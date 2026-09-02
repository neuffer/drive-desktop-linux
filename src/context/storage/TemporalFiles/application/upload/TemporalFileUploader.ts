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

      await this.publishUploadEvent(TemporalFileUploader.EMPTY_CONTENTS_ID, temporalFile, replaces);

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
      const { contentsId, revision } = await this.uploadWithRetry(temporalFile, controller, replaces);

      logger.debug({ msg: `${temporalFile.path.value} uploaded with id ${contentsId}` });

      await this.publishUploadEvent(contentsId, temporalFile, replaces, revision);

      return contentsId;
    } finally {
      stopWatching();
    }
  }

  private async uploadWithRetry(
    temporalFile: TemporalFile,
    controller: AbortController,
    replaces?: Replaces,
  ): Promise<{ contentsId: ContentsId; revision: number | undefined }> {
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
  ): Promise<Result<{ contentsId: ContentsId; revision: number | undefined }, DriveDesktopError>> {
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
      const staged = await this.repository.find(temporalFile.path);
      const revision = staged.isPresent() ? staged.get().revision : undefined;

      const stream = await this.repository.stream(temporalFile.path);

      const uploader = this.uploaderFactory
        .read(stream)
        .document(temporalFile)
        .replaces(replaces)
        .abort(controller)
        .build();

      const uploadedContentsId = await uploader();
      return { data: { contentsId: uploadedContentsId as ContentsId, revision } };
    } catch (uploadError) {
      return {
        error: mapEnvironmentUploadError(uploadError as Error & { status?: unknown }),
      };
    }
  }

  private async publishUploadEvent(
    contentsId: ContentsId,
    temporalFile: TemporalFile,
    replaces?: Replaces,
    uploadedRevision?: number,
  ): Promise<void> {
    const fileBuffer = await this.getThumbnailBufferIfNeeded(temporalFile);

    const contentsUploadedEvent = new TemporalFileUploadedDomainEvent({
      aggregateId: contentsId,
      size: temporalFile.size.value,
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
