import { Environment } from '@internxt/inxt-js';
import { DriveDesktopError } from '../../../../context/shared/domain/errors/DriveDesktopError';
import { File } from '../../../../context/virtual-drive/files/domain/File';
import { createFileToBackend } from './create-file-to-backend';
import { logger } from '@internxt/drive-desktop-core/build/backend';
import { uploadContentToEnvironment } from './upload-content-to-environment';
import { Result } from '../../../../context/shared/domain/Result';
import { deleteFileFromStorageByFileId } from '../../../../infra/drive-server/services/files/services/delete-file-content-from-bucket';
import { retryWithBackoff } from '../../../../shared/retry-with-backoff';
import { createTransientErrorHandler } from '../../../../backend/common/rate-limit/transient-error-handler';
import configStore from '../../../../apps/main/config';
import { addMaxFileSizeRejection } from '../../user/file-size-limit/add-max-file-size-rejection';
import { validateUploadFileSize } from '../../user/file-size-limit/validate-upload-file-size';

export type UploadFileParams = {
  path: string;
  size: number;
  bucket: string;
  folderId: number;
  folderUuid: string;
  environment: Environment;
  signal: AbortSignal;
};

async function uploadFile(file: UploadFileParams): Promise<Result<File | null, DriveDesktopError>> {
  const validation = validateUploadFileSize({
    size: file.size,
    maxUploadFileSize: configStore.get('maxUploadFileSizeInBytes'),
    allowEmptyFile: false,
  });

  if (!validation.allowed) {
    if (validation.reason === 'EMPTY_FILE') {
      logger.warn({
        tag: 'BACKUPS',
        msg: 'Skipping backup file because it is empty',
        path: file.path,
        size: file.size,
      });
      return { data: null };
    }

    addMaxFileSizeRejection({ path: file.path, fileSize: file.size, validation, blockUploadPath: false });
    logger.warn({
      tag: 'BACKUPS',
      msg: 'Skipping backup file because it exceeds upload size limit',
      path: file.path,
      size: file.size,
      maxFileSize: validation.maxFileSize,
      reason: validation.reason,
      showUpgradeCta: validation.showUpgradeCta,
    });
    return { data: null };
  }

  const { data: contentsId, error } = await retryWithBackoff(
    () =>
      uploadContentToEnvironment({
        path: file.path,
        size: file.size,
        bucket: file.bucket,
        environment: file.environment,
        signal: file.signal,
      }),
    createTransientErrorHandler({ tag: 'BACKUPS', context: 'BACKUP UPLOAD RETRY', path: file.path }),
    file.signal,
  );

  if (error) {
    return { error };
  }

  if (file.signal.aborted) {
    return { data: null };
  }

  const metadataResult = await retryWithBackoff(
    () =>
      createFileToBackend({
        contentsId,
        filePath: file.path,
        size: file.size,
        folderId: file.folderId,
        folderUuid: file.folderUuid,
        bucket: file.bucket,
      }),
    createTransientErrorHandler({ tag: 'BACKUPS', context: 'BACKUP UPLOAD RETRY', path: file.path }),
    file.signal,
  );

  if (metadataResult.error) {
    // Delete the uploaded content ONLY for FILE_TOO_BIG, and for nothing else.
    //
    // An error does not, in general, prove the metadata write did not land. An
    // attempt can commit the row and still report failure, and INTERNAL_SERVER_ERROR
    // is retryable, so the retry meets the row the first attempt created and comes
    // back as FILE_ALREADY_EXISTS. That conflict is then indistinguishable from a
    // genuine pre-existing file, so it cannot be treated as proof.
    //
    // FILE_TOO_BIG is the exception, and the server's own ordering is why.
    // FileUseCases.createFile checks for a duplicate name FIRST and throws
    // ConflictException, enforces the upload size limit SECOND, and only then calls
    // fileRepository.create. So a size rejection happens before any row exists, and
    // an earlier committed attempt could not surface as FILE_TOO_BIG - it would hit
    // the duplicate-name branch and return a conflict instead.
    //
    // The distinction is worth keeping rather than deleting nothing at all. The
    // storage an orphan occupies is charged to the user's own quota
    // (bridge addTotalUsedSpaceBytes on upload completion, decremented only when the
    // entry is removed), and an oversized file is retried on EVERY backup run because
    // this path deliberately does not block it - so leaking here would cost the user a
    // fresh copy of that file every run, invisibly, until backups fail as
    // NOT_ENOUGH_SPACE.
    //
    // Getting it wrong the other way is worse, which is why the list is this short:
    // DELETE /files/{bucketId}/{fileId} is not a content-only delete.
    // FileUseCases.deleteFileByFileId looks the contents id up among the user's files
    // and, when one matches, deletes the file itself.
    if (metadataResult.error.cause === 'FILE_TOO_BIG') {
      await deleteFileFromStorageByFileId({ bucketId: file.bucket, fileId: contentsId });
    } else {
      // Nothing reclaims this object on its own, so record the handle. Without it the
      // only reference to the leaked content is gone the moment this function returns.
      logger.warn({
        tag: 'BACKUPS',
        msg: 'Leaving uploaded content in place: the metadata failure does not prove it is unreferenced',
        path: file.path,
        contentsId,
        cause: metadataResult.error.cause,
      });
    }

    if (metadataResult.error.cause === 'FILE_TOO_BIG') {
      addMaxFileSizeRejection({ path: file.path, fileSize: file.size, blockUploadPath: false });
      logger.warn({
        tag: 'BACKUPS',
        msg: 'Skipping backup file because backend rejected it by upload size limit',
        path: file.path,
        size: file.size,
      });
      return { data: null };
    }

    return { error: metadataResult.error };
  }

  return { data: metadataResult.data };
}

export async function uploadFileToBackup(file: UploadFileParams): Promise<Result<File | null, DriveDesktopError>> {
  const result = await uploadFile(file);

  if (result.error?.cause === 'FILE_ALREADY_EXISTS') {
    logger.debug({
      tag: 'BACKUPS',
      msg: `[FILE ALREADY EXISTS] Skipping file ${file.path} - already exists remotely`,
    });
    return { data: null };
  }

  return result;
}
