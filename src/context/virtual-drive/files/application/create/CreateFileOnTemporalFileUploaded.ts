import { Environment } from '@internxt/inxt-js';
import { Service } from 'diod';
import { basename } from 'node:path';
import { logger } from '@internxt/drive-desktop-core/build/backend';
import { addMaxFileSizeRejection } from '../../../../../backend/features/user/file-size-limit/add-max-file-size-rejection';
import { generateThumbnail } from '../../../../../backend/features/thumbnails/generate-thumbnail';
import { uploadAndCreateThumbnail } from '../../../../../backend/features/thumbnails/upload-and-create-thumbnail';
import { TemporalFileUploadedDomainEvent } from '../../../../storage/TemporalFiles/domain/upload/TemporalFileUploadedDomainEvent';
import { DomainEventClass } from '../../../../shared/domain/DomainEvent';
import { DomainEventSubscriber } from '../../../../shared/domain/DomainEventSubscriber';
import { DriveDesktopError } from '../../../../shared/domain/errors/DriveDesktopError';
import { FileCreator } from './FileCreator';
import { FileOverrider } from '../override/FileOverrider';
import { preserveRejectedFileSizeTooBig } from '../../../../../backend/features/user/file-size-limit';
import { deleteFileFromStorageByFileId } from '../../../../../infra/drive-server/services/files/services/delete-file-content-from-bucket';
import { SyncError } from '../../../../../shared/issues/SyncErrorCause';
import { SyncFileMessenger } from '../../domain/SyncFileMessenger';

/**
 * Causes where the server DEFINITIVELY refused the metadata write, so the
 * content it refers to is certainly unreferenced.
 *
 * Anything ambiguous is deliberately absent, and the list is a safety boundary
 * rather than a convenience. A 502 or a timeout does NOT prove the write failed:
 * the server may have committed it and lost the response, and deleting the
 * content of a file the drive now points at would turn a quota leak into data
 * loss. Those causes are already retried upstream; when the retries are
 * exhausted the bytes are left in place on purpose.
 *
 * THE INVARIANT THIS RESTS ON, because the cause is all the catch below can
 * see: every one of these four is produced in exactly two places, and both are
 * the remote metadata call itself - `SDKRemoteFileSystem.persist` for the create
 * branch and `mapOverrideFileError` for the override branch. Nothing after that
 * call can raise one, so the cause does identify the failing operation. If a
 * fifth producer is ever added somewhere later in the sequence, this cleanup
 * would start deleting content the server has already accepted, and this list
 * has to be revisited with it.
 */
const DEFINITIVELY_REJECTED_CAUSES: ReadonlyArray<SyncError> = [
  'FILE_TOO_BIG',
  'EMPTY_FILE',
  'EMPTY_FILE_LIMIT_REACHED',
  'EMPTY_FILE_UPGRADE_REQUIRED',
];

@Service()
export class CreateFileOnTemporalFileUploaded implements DomainEventSubscriber<TemporalFileUploadedDomainEvent> {
  constructor(
    private readonly creator: FileCreator,
    private readonly fileOverrider: FileOverrider,
    private readonly environment: Environment,
    private readonly bucket: string,
    private readonly notifier?: SyncFileMessenger,
  ) {}

  subscribedTo(): DomainEventClass[] {
    return [TemporalFileUploadedDomainEvent];
  }

  private async create(event: TemporalFileUploadedDomainEvent): Promise<void> {
    const file = event.replaces
      ? await this.fileOverrider.run(event.replaces, event.aggregateId, event.size)
      : await this.creator.run(event.path, event.aggregateId, event.size);

    if (event.fileBuffer) {
      const generated = generateThumbnail(event.fileBuffer);

      if (generated.error) {
        logger.warn({ msg: `Failed to generate thumbnail for ${event.path}`, error: generated.error });
        return;
      }

      void uploadAndCreateThumbnail({
        thumbnailBuffer: generated.data,
        fileUuid: file.uuid,
        environment: this.environment,
        bucket: this.bucket,
      }).then(({ error }) => {
        if (error) {
          logger.warn({ msg: `Failed to upload thumbnail for ${event.path}`, error });
        }
      });
    }
  }

  async on(event: TemporalFileUploadedDomainEvent): Promise<void> {
    try {
      await this.create(event);
    } catch (err) {
      // Started before anything else, because the FILE_TOO_BIG branch below
      // returns early and the content would otherwise be stranded on exactly the
      // cause that strands it most often.
      //
      // NOT awaited, deliberately. Nothing here reads its result, and no call
      // through this client carries a timeout, so awaiting it would hold the
      // user's own failure notification behind a request that has no bound. It
      // would also put that request inside the FUSE `Release` callback for
      // anyone who also takes the change that makes the event bus wait for its
      // subscribers. `deleteOrphanedContent` never throws, so this cannot become
      // an unhandled rejection.
      void this.deleteOrphanedContent(event, err);

      const cause = err instanceof DriveDesktopError ? err.cause : 'UNKNOWN';

      if (event.replaces && this.notifier) {
        await this.notifier.issues({
          error: 'UPLOAD_ERROR',
          cause,
          name: basename(event.path),
        });
      }

      if (err instanceof DriveDesktopError && err.cause === 'FILE_TOO_BIG') {
        const preserved = await this.preserveBackendRejectedFile(event);
        if (!preserved) {
          return;
        }

        addMaxFileSizeRejection({
          path: event.path,
          fileSize: event.size,
          blockUploadPath: false,
        });
        return;
      }

      logger.error({
        msg: '[CreateFileOnOfflineFileUploaded] Error creating file:',
        error: err,
      });
    }
  }

  /**
   * Remove content the drive can no longer reach.
   *
   * Both branches of `create` upload the content BEFORE the metadata write, so
   * when that write finally fails the bytes are in the bucket with nothing
   * pointing at them, and they keep counting against the user's quota. The
   * backup path already cleans up after itself
   * (`upload-file-to-backup.ts`); the virtual drive never has.
   *
   * `event.aggregateId` is the contents id that was just uploaded, on the
   * create branch and the override branch alike. `event.replaces` is the
   * PREVIOUS contents id, which the file still points at when an override
   * fails, and deleting that would destroy the user's existing data.
   *
   * `this.bucket` is the bucket that content is actually in, which is worth
   * saying because this class and the uploader are constructed at different
   * injection sites: both take `DependencyInjectionUserProvider.get().bucket`,
   * in `registerFilesServices` and `registerTemporalFilesServices`. If those
   * ever diverge, this deletes by id in the wrong bucket.
   *
   * Never throws, which is what makes it safe for the caller to start it without
   * waiting, and never changes what the caller reports. A failed cleanup is a
   * leaked object, which is what we already have; letting it escape here would
   * turn that into a failed upload the user is told about twice.
   */
  private async deleteOrphanedContent(event: TemporalFileUploadedDomainEvent, err: unknown): Promise<void> {
    if (!(err instanceof DriveDesktopError) || !DEFINITIVELY_REJECTED_CAUSES.includes(err.cause)) {
      return;
    }

    // An empty file uploads no content at all: `TemporalFileUploader` skips the
    // upload and publishes an empty contents id, so there is nothing to remove
    // and the request would be malformed.
    if (!event.aggregateId) {
      return;
    }

    // Defence in depth for the case the comment above is about. If the two ids
    // are ever equal - content-addressed storage returning the id the file
    // already has, say - then deleting the "new" content deletes what the drive
    // still points at, which is the one outcome this whole guard exists to
    // avoid. Cheaper to refuse than to be sure it cannot happen.
    if (event.aggregateId === event.replaces) {
      return;
    }

    try {
      const { error } = await deleteFileFromStorageByFileId({ bucketId: this.bucket, fileId: event.aggregateId });

      if (error) {
        logger.error({
          msg: '[CreateFileOnOfflineFileUploaded] Could not delete the content left behind by a rejected file',
          error,
          path: event.path,
          contentsId: event.aggregateId,
        });
        return;
      }

      logger.warn({
        msg: '[CreateFileOnOfflineFileUploaded] Deleted the content left behind by a rejected file',
        cause: err.cause,
        path: event.path,
        contentsId: event.aggregateId,
      });
    } catch (deleteError) {
      logger.error({
        msg: '[CreateFileOnOfflineFileUploaded] Could not delete the content left behind by a rejected file',
        error: deleteError,
        path: event.path,
        contentsId: event.aggregateId,
      });
    }
  }

  private async preserveBackendRejectedFile(event: TemporalFileUploadedDomainEvent): Promise<boolean> {
    if (!event.contentFilePath) {
      logger.error({
        msg: '[CreateFileOnOfflineFileUploaded] Backend rejected oversized file but temporal content path is unavailable',
        path: event.path,
        size: event.size,
      });
      return false;
    }

    try {
      const { data, error } = await preserveRejectedFileSizeTooBig({
        originalPath: event.path,
        temporalContentPath: event.contentFilePath,
        size: event.size,
      });

      if (error) {
        logger.error({
          msg: '[CreateFileOnOfflineFileUploaded] Failed to preserve backend-rejected oversized file',
          error,
          path: event.path,
          size: event.size,
          temporalContentPath: event.contentFilePath,
        });
        return false;
      }

      logger.warn({
        msg: '[CreateFileOnOfflineFileUploaded] Backend rejected file because it exceeds upload size limit, preserved local copy',
        path: event.path,
        size: event.size,
        preservedFilePath: data.filePath,
      });
      return true;
    } catch (preserveError) {
      logger.error({
        msg: '[CreateFileOnOfflineFileUploaded] Failed to preserve backend-rejected oversized file',
        error: preserveError,
        path: event.path,
        size: event.size,
        temporalContentPath: event.contentFilePath,
      });
      return false;
    }
  }
}
