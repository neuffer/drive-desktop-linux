import { Environment } from '@internxt/inxt-js';
import {
  clearMaxFileSizeRejectionModal,
  isUploadSizeLimitBlockedPath,
} from '../../../../../backend/features/user/file-size-limit/add-max-file-size-rejection';
import { DriveDesktopError } from '../../../../shared/domain/errors/DriveDesktopError';
import { CreateFileOnTemporalFileUploaded } from './CreateFileOnTemporalFileUploaded';
import { FileCreatorTestClass } from '../../__test-helpers__/FileCreatorTestClass';
import { FileOverriderTestClass } from '../../__test-helpers__/FileOverriderTestClass';
import { FileMother } from '../../domain/__test-helpers__/FileMother';
import { OfflineContentsUploadedDomainEventMother } from '../../domain/events/__test-helpers__/OfflineContentsUploadedDomainEventMother';
import { call } from 'tests/vitest/utils.helper';
import { preserveRejectedFileSizeTooBig } from '../../../../../backend/features/user/file-size-limit';
import { SyncFileMessenger } from '../../domain/SyncFileMessenger';
import * as deleteFileModule from '../../../../../infra/drive-server/services/files/services/delete-file-content-from-bucket';
import { partialSpyOn } from 'tests/vitest/utils.helper';

vi.mock('../../../../../backend/features/user/file-size-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../backend/features/user/file-size-limit')>();

  return {
    ...actual,
    preserveRejectedFileSizeTooBig: vi.fn().mockResolvedValue({
      data: {
        filePath: '/home/user/.config/internxt/rejected-files-size-too-big/rejected/file.pdf',
      },
    }),
  };
});

describe('Create File On Offline File Uploaded', () => {
  const environment = {} as Environment;
  const bucket = 'test-bucket';

  afterEach(() => {
    clearMaxFileSizeRejectionModal();
  });

  it('creates a new file when event replaces field is undefined', async () => {
    const creator = new FileCreatorTestClass();
    const overrider = new FileOverriderTestClass();
    const file = FileMother.noThumbnable();
    creator.mock.mockResolvedValue(file);

    const uploadedEvent = OfflineContentsUploadedDomainEventMother.doesNotReplace();

    const sut = new CreateFileOnTemporalFileUploaded(creator, overrider, environment, bucket);

    await sut.on(uploadedEvent);

    call(creator.mock).toMatchObject([uploadedEvent.path, uploadedEvent.aggregateId, uploadedEvent.size]);
  });

  it('does not create a new file when the replaces field is defined', async () => {
    const creator = new FileCreatorTestClass();
    const overrider = new FileOverriderTestClass();
    const file = FileMother.noThumbnable();
    overrider.mock.mockResolvedValue(file);

    const uploadedEvent = OfflineContentsUploadedDomainEventMother.replacesContents();

    const sut = new CreateFileOnTemporalFileUploaded(creator, overrider, environment, bucket);

    await sut.on(uploadedEvent);

    expect(creator.mock).not.toHaveBeenCalled();
  });

  it('overrides file with contents specified on the event', async () => {
    const creator = new FileCreatorTestClass();
    const overrider = new FileOverriderTestClass();
    const file = FileMother.noThumbnable();
    overrider.mock.mockResolvedValue(file);

    const uploadedEvent = OfflineContentsUploadedDomainEventMother.replacesContents();

    const sut = new CreateFileOnTemporalFileUploaded(creator, overrider, environment, bucket);

    await sut.on(uploadedEvent);

    call(overrider.mock).toMatchObject([uploadedEvent.replaces, uploadedEvent.aggregateId, uploadedEvent.size]);
  });

  it('preserves and queues max file size rejection when backend rejects metadata creation by file size', async () => {
    const creator = new FileCreatorTestClass();
    const overrider = new FileOverriderTestClass();
    creator.mock.mockRejectedValue(new DriveDesktopError('FILE_TOO_BIG'));

    const uploadedEvent = OfflineContentsUploadedDomainEventMother.doesNotReplace();
    Object.assign(uploadedEvent, { contentFilePath: '/tmp/internxt-drive-tmp/staged-file' });

    const sut = new CreateFileOnTemporalFileUploaded(creator, overrider, environment, bucket);

    await sut.on(uploadedEvent);

    expect(preserveRejectedFileSizeTooBig).toHaveBeenCalledWith({
      originalPath: uploadedEvent.path,
      temporalContentPath: '/tmp/internxt-drive-tmp/staged-file',
      size: uploadedEvent.size,
    });
    expect(isUploadSizeLimitBlockedPath(uploadedEvent.path)).toBe(false);
  });

  it('publishes an upload issue when an override upload is rejected with a specific cause', async () => {
    const creator = new FileCreatorTestClass();
    const overrider = new FileOverriderTestClass();
    const notifier = { issues: vi.fn().mockResolvedValue(undefined) } as unknown as SyncFileMessenger;
    const uploadedEvent = OfflineContentsUploadedDomainEventMother.replacesContents();

    overrider.mock.mockRejectedValue(new DriveDesktopError('EMPTY_FILE', 'You can not have empty files'));

    const sut = new CreateFileOnTemporalFileUploaded(creator, overrider, environment, bucket, notifier);

    await sut.on(uploadedEvent);

    expect(notifier.issues).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'UPLOAD_ERROR',
        cause: 'EMPTY_FILE',
      }),
    );
  });

  it('deletes the uploaded content when the backend definitively rejects the file', async () => {
    const deleteFile = partialSpyOn(deleteFileModule, 'deleteFileFromStorageByFileId');
    deleteFile.mockResolvedValue({ data: true });
    const creator = new FileCreatorTestClass();
    const overrider = new FileOverriderTestClass();
    creator.mock.mockRejectedValue(new DriveDesktopError('FILE_TOO_BIG'));

    const uploadedEvent = OfflineContentsUploadedDomainEventMother.doesNotReplace();
    Object.assign(uploadedEvent, { contentFilePath: '/tmp/internxt-drive-tmp/staged-file' });

    const sut = new CreateFileOnTemporalFileUploaded(creator, overrider, environment, bucket);

    await sut.on(uploadedEvent);

    // The content was uploaded before the metadata write, so a definitive
    // rejection leaves it in the bucket with nothing pointing at it.
    expect(deleteFile).toHaveBeenCalledWith({ bucketId: bucket, fileId: uploadedEvent.aggregateId });
  });

  it('deletes the NEW contents and never the one the file still points at, when an override is rejected', async () => {
    const deleteFile = partialSpyOn(deleteFileModule, 'deleteFileFromStorageByFileId');
    deleteFile.mockResolvedValue({ data: true });
    const creator = new FileCreatorTestClass();
    const overrider = new FileOverriderTestClass();
    overrider.mock.mockRejectedValue(new DriveDesktopError('FILE_TOO_BIG'));

    const uploadedEvent = OfflineContentsUploadedDomainEventMother.replacesContents();

    const sut = new CreateFileOnTemporalFileUploaded(creator, overrider, environment, bucket);

    await sut.on(uploadedEvent);

    expect(deleteFile).toHaveBeenCalledWith({ bucketId: bucket, fileId: uploadedEvent.aggregateId });
    // `replaces` is the contents the drive still refers to. Deleting it would
    // turn a quota leak into data loss.
    expect(deleteFile).not.toHaveBeenCalledWith(expect.objectContaining({ fileId: uploadedEvent.replaces }));
  });

  it('does NOT delete the uploaded content when the failure is ambiguous', async () => {
    const deleteFile = partialSpyOn(deleteFileModule, 'deleteFileFromStorageByFileId');
    const creator = new FileCreatorTestClass();
    const overrider = new FileOverriderTestClass();
    // A 502 does not prove the server failed to commit the metadata write, so
    // the content may be exactly what the drive now points at.
    overrider.mock.mockRejectedValue(new DriveDesktopError('INTERNAL_SERVER_ERROR'));

    const uploadedEvent = OfflineContentsUploadedDomainEventMother.replacesContents();

    const sut = new CreateFileOnTemporalFileUploaded(creator, overrider, environment, bucket);

    await sut.on(uploadedEvent);

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('does not attempt a delete for an empty file, which uploaded no content', async () => {
    const deleteFile = partialSpyOn(deleteFileModule, 'deleteFileFromStorageByFileId');
    const creator = new FileCreatorTestClass();
    const overrider = new FileOverriderTestClass();
    creator.mock.mockRejectedValue(new DriveDesktopError('EMPTY_FILE'));

    const uploadedEvent = OfflineContentsUploadedDomainEventMother.doesNotReplace();
    // `TemporalFileUploader` short-circuits an empty file and publishes an empty
    // contents id, so there is nothing in the bucket to remove.
    Object.assign(uploadedEvent, { aggregateId: '' });

    const sut = new CreateFileOnTemporalFileUploaded(creator, overrider, environment, bucket);

    await sut.on(uploadedEvent);

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('still reports the rejection when the cleanup itself fails', async () => {
    const deleteFile = partialSpyOn(deleteFileModule, 'deleteFileFromStorageByFileId');
    deleteFile.mockRejectedValue(new Error('the bucket is unreachable'));
    const creator = new FileCreatorTestClass();
    const overrider = new FileOverriderTestClass();
    const notifier = { issues: vi.fn().mockResolvedValue(undefined) } as unknown as SyncFileMessenger;
    overrider.mock.mockRejectedValue(new DriveDesktopError('FILE_TOO_BIG'));

    const uploadedEvent = OfflineContentsUploadedDomainEventMother.replacesContents();

    const sut = new CreateFileOnTemporalFileUploaded(creator, overrider, environment, bucket, notifier);

    // A failed cleanup leaves the object leaked, which is what we already had.
    // It must not become a second failure the user is told about.
    await expect(sut.on(uploadedEvent)).resolves.toBeUndefined();

    expect(notifier.issues).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'UPLOAD_ERROR', cause: 'FILE_TOO_BIG' }),
    );
  });

  it('refuses to delete when the new contents id is the one the file already points at', async () => {
    const deleteFile = partialSpyOn(deleteFileModule, 'deleteFileFromStorageByFileId');
    const creator = new FileCreatorTestClass();
    const overrider = new FileOverriderTestClass();
    overrider.mock.mockRejectedValue(new DriveDesktopError('FILE_TOO_BIG'));

    const uploadedEvent = OfflineContentsUploadedDomainEventMother.replacesContents();
    // Content-addressed storage handing back the id the file already has would
    // make the "new" content and the live content the same object.
    Object.assign(uploadedEvent, { replaces: uploadedEvent.aggregateId });

    const sut = new CreateFileOnTemporalFileUploaded(creator, overrider, environment, bucket);

    await sut.on(uploadedEvent);

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('does not delete when the failure is not a DriveDesktopError at all', async () => {
    const deleteFile = partialSpyOn(deleteFileModule, 'deleteFileFromStorageByFileId');
    const creator = new FileCreatorTestClass();
    const overrider = new FileOverriderTestClass();
    creator.mock.mockRejectedValue(new Error('something local went wrong'));

    const uploadedEvent = OfflineContentsUploadedDomainEventMother.doesNotReplace();

    const sut = new CreateFileOnTemporalFileUploaded(creator, overrider, environment, bucket);

    await sut.on(uploadedEvent);

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('does not make the caller wait for the cleanup', async () => {
    const deleteFile = partialSpyOn(deleteFileModule, 'deleteFileFromStorageByFileId');
    // No call through this client carries a timeout, so a cleanup that never
    // answers must not hold the handler, and with the event bus awaiting its
    // subscribers it must not hold the FUSE release either.
    deleteFile.mockReturnValue(new Promise(() => undefined));
    const creator = new FileCreatorTestClass();
    const overrider = new FileOverriderTestClass();
    creator.mock.mockRejectedValue(new DriveDesktopError('FILE_TOO_BIG'));

    const uploadedEvent = OfflineContentsUploadedDomainEventMother.doesNotReplace();
    Object.assign(uploadedEvent, { contentFilePath: '/tmp/internxt-drive-tmp/staged-file' });

    const sut = new CreateFileOnTemporalFileUploaded(creator, overrider, environment, bucket);

    await expect(sut.on(uploadedEvent)).resolves.toBeUndefined();

    expect(deleteFile).toHaveBeenCalledWith({ bucketId: bucket, fileId: uploadedEvent.aggregateId });
  });
});
