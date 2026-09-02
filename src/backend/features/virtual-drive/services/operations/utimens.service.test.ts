import { mockDeep } from 'vitest-mock-extended';
import { Container } from 'diod';
import { FuseCodes } from '../../../../../apps/drive/fuse/callbacks/FuseCodes';
import { FirstsFileSearcher } from '../../../../../context/virtual-drive/files/application/search/FirstsFileSearcher';
import { FileRepository } from '../../../../../context/virtual-drive/files/domain/FileRepository';
import { PendingModificationTimes } from '../../../../../context/virtual-drive/files/application/utimens/PendingModificationTimes';
import { TemporalFileByPathFinder } from '../../../../../context/storage/TemporalFiles/application/find/TemporalFileByPathFinder';
import type { TemporalFile } from '../../../../../context/storage/TemporalFiles/domain/TemporalFile';
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
  const temporalFileFinder = mockDeep<TemporalFileByPathFinder>();
  const pendingModificationTimes = mockDeep<PendingModificationTimes>();
  const setModificationTimeMock = vi.mocked(setModificationTime);

  let file: File;

  beforeEach(() => {
    vi.clearAllMocks();
    container = mockDeep<Container>();
    container.get.calledWith(FirstsFileSearcher).mockReturnValue(firstsFileSearcher);
    container.get.calledWith(FileRepository).mockReturnValue(fileRepository);
    container.get.calledWith(TemporalFileByPathFinder).mockReturnValue(temporalFileFinder);
    container.get.calledWith(PendingModificationTimes).mockReturnValue(pendingModificationTimes);
    temporalFileFinder.run.mockResolvedValue(undefined);

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

  it('should return ENOENT when the path is neither on the drive nor staged', async () => {
    firstsFileSearcher.run.mockResolvedValue(undefined);
    temporalFileFinder.run.mockResolvedValue(undefined);

    const { error } = await utimens({ path: '/nope.txt', modificationTime: REQUESTED, container });

    expect(error?.code).toBe(FuseCodes.ENOENT);
    expect(setModificationTimeMock).not.toHaveBeenCalled();
  });

  describe('when the file is still staged, which is what cp -p does', () => {
    beforeEach(() => {
      // cp -p calls utimensat on the open descriptor BEFORE close, so no drive
      // record exists yet, only a temporal file.
      firstsFileSearcher.run.mockResolvedValue(undefined);
      temporalFileFinder.run.mockResolvedValue({} as unknown as TemporalFile);
    });

    it('should succeed rather than returning ENOENT', async () => {
      const { data, error } = await utimens({ path: '/some/file.txt', modificationTime: REQUESTED, container });

      expect(error).toBeUndefined();
      expect(data).toBeUndefined();
    });

    it('should hold the time for the upload to carry, and not call the drive', async () => {
      await utimens({ path: '/some/file.txt', modificationTime: REQUESTED, container });

      expect(pendingModificationTimes.set).toHaveBeenCalledWith('/some/file.txt', REQUESTED);
      expect(setModificationTimeMock).not.toHaveBeenCalled();
      expect(fileRepository.update).not.toHaveBeenCalled();
    });
  });
});
