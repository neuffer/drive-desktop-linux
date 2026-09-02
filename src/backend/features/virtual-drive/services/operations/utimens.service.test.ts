import { mockDeep } from 'vitest-mock-extended';
import { Container } from 'diod';
import { FuseCodes } from '../../../../../apps/drive/fuse/callbacks/FuseCodes';
import { FirstsFileSearcher } from '../../../../../context/virtual-drive/files/application/search/FirstsFileSearcher';
import { FileRepository } from '../../../../../context/virtual-drive/files/domain/FileRepository';
import type { File } from '../../../../../context/virtual-drive/files/domain/File';
import { setModificationTime } from '../../../../../infra/drive-server/services/files/services/set-modification-time';
import { utimens } from './utimens.service';

vi.mock('@internxt/drive-desktop-core/build/backend');
vi.mock('../../../../../infra/drive-server/services/files/services/set-modification-time');

describe('utimens', () => {
  const REQUESTED = new Date('2024-03-04T05:06:07.000Z');

  let container: ReturnType<typeof mockDeep<Container>>;
  const firstsFileSearcher = mockDeep<FirstsFileSearcher>();
  const fileRepository = mockDeep<FileRepository>();
  const setModificationTimeMock = vi.mocked(setModificationTime);

  let file: File;

  beforeEach(() => {
    vi.clearAllMocks();
    container = mockDeep<Container>();
    container.get.calledWith(FirstsFileSearcher).mockReturnValue(firstsFileSearcher);
    container.get.calledWith(FileRepository).mockReturnValue(fileRepository);

    file = {
      uuid: 'a-uuid',
      contentsId: 'a-contents-id',
      size: 4096,
      setModificationTime: vi.fn(),
    } as unknown as File;

    firstsFileSearcher.run.mockResolvedValue(file);
    setModificationTimeMock.mockResolvedValue({ data: true });
  });

  it('should send the requested time with the file its existing contents id and size', async () => {
    const { error } = await utimens({ path: '/some/file.txt', modificationTime: REQUESTED, container });

    expect(error).toBeUndefined();
    expect(setModificationTimeMock).toHaveBeenCalledWith({
      fileUuid: 'a-uuid',
      fileContentsId: 'a-contents-id',
      fileSize: 4096,
      modificationTime: REQUESTED,
    });
  });

  it('should persist the new time locally, because stat is answered from the repository', async () => {
    await utimens({ path: '/some/file.txt', modificationTime: REQUESTED, container });

    expect(file.setModificationTime).toHaveBeenCalledWith(REQUESTED);
    expect(fileRepository.update).toHaveBeenCalledWith(file);
  });

  it('should not touch the local record when the remote update failed', async () => {
    setModificationTimeMock.mockResolvedValue({ error: { cause: 'BAD_REQUEST' } as never });

    const { error } = await utimens({ path: '/some/file.txt', modificationTime: REQUESTED, container });

    expect(error?.code).toBe(FuseCodes.EIO);
    expect(file.setModificationTime).not.toHaveBeenCalled();
    expect(fileRepository.update).not.toHaveBeenCalled();
  });

  it('should return ENOENT when the file is not on the drive', async () => {
    firstsFileSearcher.run.mockResolvedValue(undefined);

    const { error } = await utimens({ path: '/nope.txt', modificationTime: REQUESTED, container });

    expect(error?.code).toBe(FuseCodes.ENOENT);
    expect(setModificationTimeMock).not.toHaveBeenCalled();
  });
});
