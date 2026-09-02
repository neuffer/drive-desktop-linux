import { Service } from 'diod';
import { extname } from 'node:path';
import { logger } from '@internxt/drive-desktop-core/build/backend';
import { canGenerateThumbnail } from '../../../../../backend/features/thumbnails/thumbnail.extensions';
import { TemporalFileRepository } from '../../domain/TemporalFileRepository';
import { TemporalFileUploaderFactory } from '../../domain/upload/TemporalFileUploaderFactory';
import { TemporalFileUploadedDomainEvent } from '../../domain/upload/TemporalFileUploadedDomainEvent';
import { EventBus } from '../../../../virtual-drive/shared/domain/EventBus';
import { Replaces } from '../../domain/upload/Replaces';
import { TemporalFile } from '../../domain/TemporalFile';
import { retryWithBackoff } from '../../../../../shared/retry-with-backoff';
import {
  createTransientErrorHandler,
  mapEnvironmentUploadError,
} from '../../../../../backend/common/rate-limit/transient-error-handler';
import { ContentsId } from '../../../../../apps/main/database/entities/DriveFile';
import { DriveDesktopError } from '../../../../shared/domain/errors/DriveDesktopError';
import { Result } from '../../../../shared/domain/Result';
import configStore from '../../../../../apps/main/config';
import { addMaxFileSizeRejection } from '../../../../../backend/features/user/file-size-limit/add-max-file-size-rejection';
import { UploadSizeLimitError } from '../../../../../backend/features/user/file-size-limit/upload-size-limit-error';
import { validateUploadFileSize } from '../../../../../backend/features/user/file-size-limit/validate-upload-file-size';
import { validateSpace } from '../../../../../backend/features/usage/validate-space';

@Service()
export class TemporalFileUploader {
  private static readonly EMPTY_CONTENTS_ID = '' as ContentsId;

  constructor(
    private readonly repository: TemporalFileRepository,
    private readonly uploaderFactory: TemporalFileUploaderFactory,
    private readonly eventBus: EventBus,
  ) {}

  async run(temporalFile: TemporalFile, replaces?: Replaces): Promise<ContentsId> {
    if (temporalFile.isEmpty()) {
      logger.debug({
        msg: '[TemporalFileUploader] Skipping upload for empty temporal file',
        path: temporalFile.path.value,
      });

      // An empty staged copy still has to be reapable, or every later close of
      // the path re-enters the override with nothing to upload.
      const emptyStaged = await this.readStaged(temporalFile);

      await this.publishUploadEvent(
        TemporalFileUploader.EMPTY_CONTENTS_ID,
        temporalFile,
        replaces,
        emptyStaged?.revision,
      );

      return TemporalFileUploader.EMPTY_CONTENTS_ID;
    }

    const sizeValidation = validateUploadFileSize({
      size: temporalFile.size.value,
      maxUploadFileSize: configStore.get('maxUploadFileSizeInBytes'),
    });

    if (!sizeValidation.allowed) {
      addMaxFileSizeRejection({
        path: temporalFile.path.value,
        fileSize: temporalFile.size.value,
        validation: sizeValidation,
      });

      throw new UploadSizeLimitError();
    }

    const spaceValidation = await validateSpace(temporalFile.size.value);
    if (spaceValidation.error) {
      throw new DriveDesktopError('BAD_RESPONSE', spaceValidation.error.message);
    }

    if (spaceValidation.data.hasSpace === false) {
      throw new DriveDesktopError(
        'NOT_ENOUGH_SPACE',
        'The size of the file to upload is greater than the available space',
      );
    }

    const controller = new AbortController();
    const stopWatching = this.repository.watchFile(temporalFile.path, () => controller.abort());

    try {
      const { contentsId, revision, size } = await this.uploadWithRetry(temporalFile, controller, replaces);

      logger.debug({ msg: `${temporalFile.path.value} uploaded with id ${contentsId}` });

      await this.publishUploadEvent(contentsId, temporalFile, replaces, revision, size);

      return contentsId;
    } finally {
      stopWatching();
    }
  }

  private async uploadWithRetry(
    temporalFile: TemporalFile,
    controller: AbortController,
    replaces?: Replaces,
  ): Promise<{ contentsId: ContentsId; revision: number | undefined; size: number }> {
    const errorHandler = createTransientErrorHandler({
      tag: 'SYNC-ENGINE',
      context: 'TEMPORAL FILE UPLOAD RETRY',
      path: temporalFile.path.value,
    });

    const { data: uploaded, error } = await retryWithBackoff(
      () => this.executeUpload(temporalFile, controller, replaces),
      errorHandler,
      controller.signal,
    );

    if (error) throw error;

    return uploaded;
  }

  private async executeUpload(
    temporalFile: TemporalFile,
    controller: AbortController,
    replaces?: Replaces,
  ): Promise<Result<{ contentsId: ContentsId; revision: number | undefined; size: number }, DriveDesktopError>> {
    try {
      // Read the revision here rather than reusing the one the caller found:
      // between that lookup and this point the file has been size-checked and
      // space-checked, and the space check is a network round trip. A write in
      // that window is uploaded by the stream below while the caller's revision
      // still describes the older bytes.
      //
      // Read it BEFORE opening the stream, never after. A write between this
      // read and the open makes the recorded revision older than the bytes
      // sent, so the reaper sees a difference and KEEPS the staged copy, which
      // costs one extra upload. Reading it after the open would make the
      // recorded revision newer than the bytes sent, and the reaper would
      // delete a staged copy holding data that never reached the cloud.
      // ONE snapshot. The length declared to the network, the size recorded on
      // the event and the revision the reaper is asked to trust must all
      // describe the same state of the staged copy. Refreshing only the
      // revision is worse than refreshing nothing: the reaper then believes a
      // pairing that never existed, and deletes the only complete copy of a
      // file the upload truncated.
      const staged = await this.readStaged(temporalFile);
      const document = staged ?? temporalFile;
      const revision = staged?.revision;

      const stream = await this.repository.stream(temporalFile.path);

      const uploader = this.uploaderFactory
        .read(stream)
        .document(document)
        .replaces(replaces)
        .abort(controller)
        .build();

      const uploadedContentsId = await uploader();
      return { data: { contentsId: uploadedContentsId as ContentsId, revision, size: document.size.value } };
    } catch (uploadError) {
      return {
        error: mapEnvironmentUploadError(uploadError as Error & { status?: unknown }),
      };
    }
  }

  /**
   * Reading the revision must never fail the upload. A throw here would be
   * mapped to an upload error like any other, and release() deletes the staged
   * copy when an upload fails, so a fault in this bookkeeping would destroy the
   * user's bytes. An unknown revision costs one skipped reap instead, because
   * the reaper keeps a staged copy it cannot identify.
   */
  private async readStaged(temporalFile: TemporalFile): Promise<TemporalFile | undefined> {
    try {
      const staged = await this.repository.find(temporalFile.path);

      return staged?.isPresent() ? staged.get() : undefined;
    } catch (error) {
      logger.warn({
        msg: '[TemporalFileUploader] Could not read the staged revision; the staged copy will be kept',
        error,
        path: temporalFile.path.value,
      });

      return undefined;
    }
  }

  private async publishUploadEvent(
    contentsId: ContentsId,
    temporalFile: TemporalFile,
    replaces?: Replaces,
    uploadedRevision?: number,
    uploadedSize?: number,
  ): Promise<void> {
    const fileBuffer = await this.getThumbnailBufferIfNeeded(temporalFile);

    const contentsUploadedEvent = new TemporalFileUploadedDomainEvent({
      aggregateId: contentsId,
      size: uploadedSize ?? temporalFile.size.value,
      path: temporalFile.path.value,
      replaces: replaces?.contentsId,
      fileBuffer,
      contentFilePath: temporalFile.contentFilePath,
      uploadedRevision,
    });

    await this.eventBus.publish([contentsUploadedEvent]);
  }

  private async getThumbnailBufferIfNeeded(temporalFile: TemporalFile): Promise<Buffer | undefined> {
    if (temporalFile.isEmpty()) {
      return undefined;
    }

    const ext = extname(temporalFile.path.value).replace('.', '').toLowerCase();

    if (!canGenerateThumbnail(ext)) {
      return undefined;
    }

    return this.repository.read(temporalFile.path);
  }
}
