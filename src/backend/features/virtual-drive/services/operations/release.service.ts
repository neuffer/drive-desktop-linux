import { Container } from 'diod';
import { logger } from '@internxt/drive-desktop-core/build/backend';
import { type Result } from '../../../../../context/shared/domain/Result';
import { FuseError, FuseIOError } from '../../../../../apps/drive/fuse/callbacks/FuseErrors';
import { TemporalFileByPathFinder } from '../../../../../context/storage/TemporalFiles/application/find/TemporalFileByPathFinder';
import { TemporalFileUploader } from '../../../../../context/storage/TemporalFiles/application/upload/TemporalFileUploader';
import { TemporalFileDeleter } from '../../../../../context/storage/TemporalFiles/application/deletion/TemporalFileDeleter';
import { FirstsFileSearcher } from '../../../../../context/virtual-drive/files/application/search/FirstsFileSearcher';
import { FileStatuses } from '../../../../../context/virtual-drive/files/domain/FileStatus';
import { UploadSizeLimitError } from '../../../user/file-size-limit/upload-size-limit-error';
import { DriveDesktopError } from '../../../../../context/shared/domain/errors/DriveDesktopError';
import { addVirtualDriveIssue } from '../../../../../apps/main/issues/virtual-drive';

import {
  clearUploadSizeLimitBlockedPath,
  isUploadSizeLimitBlockedPath,
} from '../../../user/file-size-limit/add-max-file-size-rejection';
type Props = {
  path: string;
  processName: string;
  container: Container;
};

// v.2.6.0
// Esteban Galvis Triana
// For files with unusual extensions or when the system has to figure
// out which app to use to open them—two file descriptors end up being created:
// one for metadata and one for the actual content.
// The issue is that when each descriptor closes, it triggers a release,
// resulting in a duplicate request to create the file remotely.
const uploadsInProgress = new Set<string>();

export async function release({ path, processName, container }: Props): Promise<Result<void, FuseError>> {
  try {
    const temporalFile = await container.get(TemporalFileByPathFinder).run(path);

    if (!temporalFile) {
      logger.debug({ msg: '[Release] No temporal file found, nothing to upload', path, processName });
      return { data: undefined };
    }

    if (temporalFile.isAuxiliary()) {
      logger.debug({ msg: '[Release] Auxiliary file detected, deleting without upload', path, processName });
      await container.get(TemporalFileDeleter).run(path);
      return { data: undefined };
    }

    if (isUploadSizeLimitBlockedPath(path)) {
      logger.warn({
        msg: '[Release] Upload size limit blocked file detected, deleting partial temporal file without upload',
        path,
        processName,
      });
      await container.get(TemporalFileDeleter).run(path);
      return { data: undefined };
    }

    if (uploadsInProgress.has(path)) {
      logger.debug({ msg: '[Release] Upload already in progress, skipping duplicate release', path, processName });
      return { data: undefined };
    }

    uploadsInProgress.add(path);

    try {
      const existingFile = await container.get(FirstsFileSearcher).run({ path, status: FileStatuses.EXISTS });
      const replaces = existingFile
        ? { contentsId: existingFile.contentsId, name: existingFile.name, extension: existingFile.type }
        : undefined;

      await container.get(TemporalFileUploader).run(temporalFile, replaces);
      logger.debug({ msg: '[Release] Temporal file uploaded', path, processName });
      return { data: undefined };
    } catch (uploadError) {
      if (uploadError instanceof UploadSizeLimitError) {
        logger.warn({
          msg: '[Release] Upload size limit exceeded during upload preflight, preserving temporal file without upload',
          error: uploadError,
          path,
          processName,
        });
        return { data: undefined };
      }

      if (uploadError instanceof DriveDesktopError && uploadError.cause === 'NOT_ENOUGH_SPACE') {
        logger.warn({
          msg: '[Release] Upload preflight rejected file because drive space is insufficient, preserving temporal file without upload',
          error: uploadError,
          path,
          processName,
        });

        addVirtualDriveIssue({
          error: 'UPLOAD_ERROR',
          cause: 'NOT_ENOUGH_SPACE',
          name: path.split('/').pop() ?? path,
        });

        return { error: new FuseIOError('Upload failed due to insufficient storage or network issues.') };
      }

      if (uploadError instanceof DriveDesktopError && uploadError.cause === 'ABORTED') {
        // The upload was stopped because the staged copy no longer matches what
        // it declared: the file was truncated under it, so the bytes here are
        // NEWER than the ones being sent, not stale. Deleting them would throw
        // away the only copy of the user's most recent write, and it is exactly
        // the write that caused the abort. Keeping it costs one re-upload on
        // the next release, which is the cheap side of this trade by a wide
        // margin.
        logger.warn({
          msg: '[Release] Upload aborted because the file changed underneath it, preserving temporal file',
          error: uploadError,
          path,
          processName,
        });

        return { error: new FuseIOError('Upload aborted because the file changed while it was being uploaded.') };
      }

      logger.error({ msg: '[Release] Upload failed, deleting temporal file', error: uploadError, path, processName });
      await container.get(TemporalFileDeleter).run(path);
      return { error: new FuseIOError('Upload failed due to insufficient storage or network issues.') };
    } finally {
      uploadsInProgress.delete(path);
    }
  } catch (err: unknown) {
    logger.error({ msg: '[Release] Unexpected error', error: err, path, processName });
    return { error: new FuseIOError('An unexpected error occurred during file release.') };
  } finally {
    clearUploadSizeLimitBlockedPath(path);
  }
}
