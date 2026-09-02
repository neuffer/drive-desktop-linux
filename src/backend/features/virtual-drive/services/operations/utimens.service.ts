import { logger } from '@internxt/drive-desktop-core/build/backend';
import { Container } from 'diod';
import { FuseCodes } from '../../../../../apps/drive/fuse/callbacks/FuseCodes';
import { FuseError } from '../../../../../apps/drive/fuse/callbacks/FuseErrors';
import { Result } from '../../../../../context/shared/domain/Result';
import { FileRepository } from '../../../../../context/virtual-drive/files/domain/FileRepository';
import { FirstsFileSearcher } from '../../../../../context/virtual-drive/files/application/search/FirstsFileSearcher';
import { PendingModificationTimes } from '../../../../../context/virtual-drive/files/application/utimens/PendingModificationTimes';
import { TemporalFileByPathFinder } from '../../../../../context/storage/TemporalFiles/application/find/TemporalFileByPathFinder';
import { setModificationTime } from '../../../../../infra/drive-server/services/files/services/set-modification-time';

type UtimensProps = {
  path: string;
  modificationTime: Date;
  container: Container;
};

/**
 * Applies utimensat(2)'s modification time.
 *
 * Two cases, and the staged one is the important one. `cp -p` sets the timestamp
 * on the OPEN descriptor, before close, so at that moment the file exists only
 * as a temporal copy with no drive record. Measured with strace:
 *
 *     openat(AT_FDCWD, "dst", O_WRONLY|O_CREAT|O_EXCL, 0600) = 4
 *     utimensat(4, NULL, [...], 0)                           = 0
 *     close(4)                                               = 0
 *
 * So a service that only handled uploaded files would answer ENOENT for exactly
 * the case it exists to fix. A staged file's requested time is held and sent
 * with its CREATE call instead; an already-uploaded file, which is what
 * `touch -d` hits, is updated remotely and then locally.
 */
export async function utimens({ path, modificationTime, container }: UtimensProps): Promise<Result<void, FuseError>> {
  try {
    const virtualFile = await container.get(FirstsFileSearcher).run({ path });

    if (!virtualFile) {
      const temporalFile = await container.get(TemporalFileByPathFinder).run(path);

      if (!temporalFile) {
        const msg = `[FUSE - Utimens] File not found: ${path}`;
        return { error: new FuseError(FuseCodes.ENOENT, msg) };
      }

      // Still staged: nothing exists remotely to update, so hold the time until
      // the upload creates the file and can carry it.
      container.get(PendingModificationTimes).set(path, modificationTime);
      return { data: undefined };
    }

    const result = await setModificationTime({
      fileUuid: virtualFile.uuid,
      fileContentsId: virtualFile.contentsId,
      fileSize: virtualFile.size,
      modificationTime,
    });

    if (result.error) {
      logger.error({ msg: '[FUSE - Utimens] Unable to set modification time', error: result.error, path });
      return { error: new FuseError(FuseCodes.EIO, `[FUSE - Utimens] Remote update failed: ${path}`) };
    }

    // GetAttr answers stat from the local repository, not from the drive, so a
    // remote-only update would leave the next stat reporting the old time and
    // make a successful utimensat look like it did nothing.
    virtualFile.setModificationTime(modificationTime);
    await container.get(FileRepository).update(virtualFile);

    return { data: undefined };
  } catch (error: unknown) {
    logger.error({ msg: '[FUSE - Utimens] Unable to set modification time', error, path });
    return { error: new FuseError(FuseCodes.EIO, `[FUSE - Utimens] IO error: ${path}`) };
  }
}
