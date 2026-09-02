import { Result } from '../../../../../context/shared/domain/Result';
import { driveServerClient } from '../../../client/drive-server.client.instance';
import { DriveServerError } from '../../../drive-server.error';

export type SetModificationTimeProps = {
  fileUuid: string;
  fileContentsId: string;
  fileSize: number;
  modificationTime: Date;
};

/**
 * Sets a file's modification time without changing its contents.
 *
 * `PUT /files/{uuid}` is the only endpoint that accepts a modification time for
 * a file that already exists, so the current contents id and size are sent back
 * unchanged alongside the new time.
 *
 * This requires a server that does not treat an unchanged contents id as a
 * superseded one. Against an older server the re-declared id is deleted from
 * the bucket and the file's contents are lost, so this must not be called until
 * that fix is deployed.
 */
export async function setModificationTime({
  fileUuid,
  fileContentsId,
  fileSize,
  modificationTime,
}: SetModificationTimeProps): Promise<Result<boolean, DriveServerError>> {
  const { error } = await driveServerClient.PUT('/files/{uuid}', {
    path: { uuid: fileUuid },
    body: {
      fileId: fileContentsId,
      size: fileSize,
      modificationTime: modificationTime.toISOString(),
    },
  });
  if (error) return { error };
  return { data: true };
}
