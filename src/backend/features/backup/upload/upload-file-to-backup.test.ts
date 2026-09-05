import { partialSpyOn } from '../../../../../tests/vitest/utils.helper';
import { DriveDesktopError } from '../../../../context/shared/domain/errors/DriveDesktopError';
import { FileMother } from '../../../../context/virtual-drive/files/domain/__test-helpers__/FileMother';
import * as uploadContentModule from './upload-content-to-environment';
import * as createFileModule from './create-file-to-backend';
import * as deleteFileModule from '../../../../infra/drive-server/services/files/services/delete-file-content-from-bucket';
import { uploadFileToBackup, UploadFileParams } from './upload-file-to-backup';
import { Environment } from '@internxt/inxt-js';
import configStore from '../../../../apps/main/config';
import * as maxFileSizeRejectionModule from '../../user/file-size-limit/add-max-file-size-rejection';

describe('upload-file-to-backup', () => {
  const uploadContentMock = partialSpyOn(uploadContentModule, 'uploadContentToEnvironment');
  const createFileToBackendMock = partialSpyOn(createFileModule, 'createFileToBackend');
  const deleteFileMock = partialSpyOn(deleteFileModule, 'deleteFileFromStorageByFileId');
  const configGetMock = partialSpyOn(configStore, 'get');
  const addMaxFileSizeRejectionMock = partialSpyOn(maxFileSizeRejectionModule, 'addMaxFileSizeRejection');

  let abortController: AbortController;

  const baseParams: UploadFileParams = {
    path: '/some/path/file.txt',
    size: 1024,
    bucket: 'test-bucket',
    folderId: 1,
    folderUuid: 'folder-uuid',
    environment: {} as Environment,
    signal: new AbortController().signal,
  };

  beforeEach(() => {
    abortController = new AbortController();
    configGetMock.mockReturnValue(0);
    addMaxFileSizeRejectionMock.mockClear();
  });

  it('should upload the file content and create metadata on backend successfully', async () => {
    const contentsId = 'contents-id-123';
    const file = FileMother.any();
    uploadContentMock.mockResolvedValue({ data: contentsId });
    createFileToBackendMock.mockResolvedValue({ data: file });

    const result = await uploadFileToBackup({ ...baseParams, signal: abortController.signal });

    expect(result.data).toBe(file);
    expect(result.error).toBeUndefined();
  });

  it('should skip file upload when local upload size validation fails', async () => {
    configGetMock.mockReturnValue(100);

    const result = await uploadFileToBackup({ ...baseParams, size: 101, signal: abortController.signal });

    expect(result).toStrictEqual({ data: null });
    expect(uploadContentMock).not.toHaveBeenCalled();
    expect(createFileToBackendMock).not.toHaveBeenCalled();
    expect(addMaxFileSizeRejectionMock).toHaveBeenCalledWith({
      path: baseParams.path,
      fileSize: 101,
      validation: { allowed: false, reason: 'PLAN_LIMIT_EXCEEDED', maxFileSize: 100, showUpgradeCta: true },
      blockUploadPath: false,
    });
  });

  it('should skip file upload when file size is zero', async () => {
    const result = await uploadFileToBackup({ ...baseParams, size: 0, signal: abortController.signal });

    expect(result).toStrictEqual({ data: null });
    expect(uploadContentMock).not.toHaveBeenCalled();
    expect(createFileToBackendMock).not.toHaveBeenCalled();
    expect(addMaxFileSizeRejectionMock).not.toHaveBeenCalled();
  });

  it('should return error when content upload fails with a non-retryable error', async () => {
    const uploadError = new DriveDesktopError('UNKNOWN', 'Upload failed');
    uploadContentMock.mockResolvedValue({ error: uploadError });

    const result = await uploadFileToBackup({ ...baseParams, signal: abortController.signal });

    expect(result.error).toBe(uploadError);
    expect(createFileToBackendMock).not.toHaveBeenCalled();
  });

  it('should return ACTION_NOT_PERMITTED when content upload cannot read the local file', async () => {
    const uploadError = new DriveDesktopError('ACTION_NOT_PERMITTED', 'permission denied');
    uploadContentMock.mockResolvedValue({ error: uploadError });

    const result = await uploadFileToBackup({ ...baseParams, signal: abortController.signal });

    expect(result.error).toBe(uploadError);
    expect(createFileToBackendMock).not.toHaveBeenCalled();
  });

  it('should return the error without deleting the content when metadata creation fails for an unproven reason', async () => {
    const contentsId = 'contents-id-123';
    const metadataError = new DriveDesktopError('BAD_RESPONSE', 'Metadata failed');
    uploadContentMock.mockResolvedValue({ data: contentsId });
    createFileToBackendMock.mockResolvedValue({ error: metadataError });
    deleteFileMock.mockResolvedValue({ data: true });

    const result = await uploadFileToBackup({ ...baseParams, signal: abortController.signal });

    expect(result.error).toBe(metadataError);
    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(createFileToBackendMock).toHaveBeenCalledWith(expect.objectContaining({ contentsId }));
  });

  it.each(['ABORTED', 'UNKNOWN', 'BAD_RESPONSE', 'FILE_ALREADY_EXISTS'] as const)(
    'should not delete the uploaded content when the failure does not prove the write was refused (%s)',
    async (cause) => {
      const contentsId = 'contents-id-123';
      uploadContentMock.mockResolvedValue({ data: contentsId });
      createFileToBackendMock.mockResolvedValue({ error: new DriveDesktopError(cause, cause) });

      await uploadFileToBackup({ ...baseParams, signal: abortController.signal });

      expect(deleteFileMock).not.toHaveBeenCalled();
    },
  );

  it('should not delete the content when a retry meets the row the first attempt committed', async () => {
    // The sequence that makes every cause unsafe: the first metadata write
    // commits and reports failure anyway, the retry meets its own row, and the
    // server answers FILE_ALREADY_EXISTS. Deleting the contents id here would
    // destroy the file that first attempt created.
    const contentsId = 'contents-id-123';
    uploadContentMock.mockResolvedValue({ data: contentsId });
    // INTERNAL_SERVER_ERROR is retryable, so the loop really does go round
    // again and reaches the conflict through the retry state machine.
    createFileToBackendMock
      .mockResolvedValueOnce({ error: new DriveDesktopError('INTERNAL_SERVER_ERROR', '502') })
      .mockResolvedValue({ error: new DriveDesktopError('FILE_ALREADY_EXISTS', 'File already exists') });

    const result = await uploadFileToBackup({ ...baseParams, signal: abortController.signal });

    expect(createFileToBackendMock).toHaveBeenCalledTimes(2);
    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(result.data).toBeNull();
  });

  it('should skip file when backend rejects metadata creation by upload size limit', async () => {
    const contentsId = 'contents-id-123';
    uploadContentMock.mockResolvedValue({ data: contentsId });
    createFileToBackendMock.mockResolvedValue({ error: new DriveDesktopError('FILE_TOO_BIG', 'File too big') });
    deleteFileMock.mockResolvedValue({ data: true });

    const result = await uploadFileToBackup({ ...baseParams, signal: abortController.signal });

    expect(result).toStrictEqual({ data: null });
    // FILE_TOO_BIG is the one cause the server's own ordering proves is safe:
    // createFile rejects on size before it creates a row, and an earlier committed
    // attempt would have surfaced as a duplicate-name conflict instead.
    expect(deleteFileMock).toHaveBeenCalledWith({ bucketId: baseParams.bucket, fileId: contentsId });
    expect(addMaxFileSizeRejectionMock).toHaveBeenCalledWith({
      path: baseParams.path,
      fileSize: baseParams.size,
      blockUploadPath: false,
    });
  });

  it('should return null data and skip metadata when signal is aborted during content upload', async () => {
    const contentsId = 'contents-id-123';
    uploadContentMock.mockImplementation(async () => {
      abortController.abort();
      return { data: contentsId };
    });

    const result = await uploadFileToBackup({ ...baseParams, signal: abortController.signal });

    expect(result.data).toBeNull();
    expect(result.error).toBeUndefined();
    expect(createFileToBackendMock).not.toHaveBeenCalled();
  });

  it('should return null data when file already exists remotely', async () => {
    const alreadyExistsError = new DriveDesktopError('FILE_ALREADY_EXISTS', 'File already exists');
    uploadContentMock.mockResolvedValue({ data: 'contents-id' });
    createFileToBackendMock.mockResolvedValue({ error: alreadyExistsError });
    deleteFileMock.mockResolvedValue({ data: true });

    const result = await uploadFileToBackup({ ...baseParams, signal: abortController.signal });

    expect(result.data).toBeNull();
    expect(result.error).toBeUndefined();
    expect(deleteFileMock).not.toHaveBeenCalled();
  });
});
