import { logger } from '@internxt/drive-desktop-core/build/backend';
import { Container } from 'diod';
import { FuseCodes } from '../../../../../apps/drive/fuse/callbacks/FuseCodes';
import { FuseError } from '../../../../../apps/drive/fuse/callbacks/FuseErrors';
import { Result } from '../../../../../context/shared/domain/Result';
import { FirstsFileSearcher } from '../../../../../context/virtual-drive/files/application/search/FirstsFileSearcher';
import { setModificationTime } from '../../../../../infra/drive-server/services/files/services/set-modification-time';

type UtimensProps = {
  path: string;
  modificationTime: Date;
  container: Container;
};

/**
 * Applies utimensat(2)'s modification time to a file that already exists on the
 * drive.
 *
 * A file still being staged locally has no remote row to update yet, and the
 * time it is given here would be overwritten by the upload that follows, so
 * only uploaded files are handled.
 */
export async function utimens({ path, modificationTime, container }: UtimensProps): Promise<Result<void, FuseError>> {
  try {
    const virtualFile = await container.get(FirstsFileSearcher).run({ path });

    if (!virtualFile) {
      const msg = `[FUSE - Utimens] File not found: ${path}`;
      return { error: new FuseError(FuseCodes.ENOENT, msg) };
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

    return { data: undefined };
  } catch (error: unknown) {
    logger.error({ msg: '[FUSE - Utimens] Unable to set modification time', error, path });
    return { error: new FuseError(FuseCodes.EIO, `[FUSE - Utimens] IO error: ${path}`) };
  }
}
