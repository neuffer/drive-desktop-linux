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

      // No upload failure deletes the staged copy any more, and this is the
      // change: it used to be the default for everything not named above.
      //
      // Until an upload succeeds, the staged copy is the ONLY place the bytes
      // the user just wrote exist. A failure here says the upload did not
      // complete; it does not say the data is expendable, and the two are not
      // the same thing. A 5xx, a dropped connection, a permission error, an
      // exception in the code below - none of them are evidence that the user
      // wanted their file gone.
      //
      // The two cases above already worked this way, for a weaker reason than
      // this one: they preserve a copy that was never sent, and so does this.
      //
      // The deletions that remain are the ones decided BEFORE the upload, and
      // they are not all the same. An auxiliary file is not user data, so
      // deleting it costs nothing. A size-blocked file IS user data, and
      // deleting it is a real trade-off rather than an obvious one: the upload
      // cannot succeed at the account's current limit, so preserving it would
      // keep a copy that may never be sent. That branch is left exactly as it
      // was, deliberately - it is a different decision from this one and it
      // predates it - but it is the same shape of loss and it is worth
      // revisiting separately.
      //
      // The cost of keeping it is disk space until the next close re-uploads
      // it. The cost of deleting it was the file.
      logger.error({
        msg: '[Release] Upload failed, preserving the temporal file so the next close can retry it',
        error: uploadError,
        path,
        processName,
      });

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
