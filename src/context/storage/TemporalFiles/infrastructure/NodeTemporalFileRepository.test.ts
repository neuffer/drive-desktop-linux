import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeTemporalFileRepository } from './NodeTemporalFileRepository';
import { TemporalFilePath } from '../domain/TemporalFilePath';

describe('NodeTemporalFileRepository', () => {
  let folder: string;
  let repository: NodeTemporalFileRepository;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'internxt-temporal-files-'));
    repository = new NodeTemporalFileRepository(folder);
    repository.init();
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('should return empty when mapped file no longer exists on disk', async () => {
    const documentPath = new TemporalFilePath('/Documents/.test-file.txt.swp');

    await repository.create(documentPath);
    const temporalFile = await repository.find(documentPath);
    const contentFilePath = temporalFile.get().contentFilePath;

    await rm(contentFilePath, { force: true });

    const result = await repository.find(documentPath);

    expect(result.isPresent()).toBe(false);
  });

  it('should ignore ENOENT when deleting a stale mapped file', async () => {
    const documentPath = new TemporalFilePath('/Documents/.test-file.txt.swp');

    await repository.create(documentPath);
    const temporalFile = await repository.find(documentPath);
    const contentFilePath = temporalFile.get().contentFilePath;

    await rm(contentFilePath, { force: true });

    await expect(repository.delete(documentPath)).resolves.toBeUndefined();
  });
  it('bumps the revision even when the write itself fails', async () => {
    // The bump must happen before the mutation, not after. A write that puts
    // bytes on disk and then throws on close would otherwise leave a changed
    // file wearing its old revision, and the reaper would delete bytes the
    // upload never sent. Making the open fail stands in for that: the revision
    // must have moved regardless of the outcome.
    const documentPath = new TemporalFilePath('/Documents/report.pdf');

    await repository.create(documentPath);
    const before = (await repository.find(documentPath)).get().revision;
    const contentFilePath = (await repository.find(documentPath)).get().contentFilePath as string;

    await chmod(contentFilePath, 0o444);

    await expect(repository.write(documentPath, Buffer.from('x'), 1, 0)).rejects.toThrow();

    const after = (await repository.find(documentPath)).get().revision;
    expect(after).not.toBe(before);

    await chmod(contentFilePath, 0o644);
  });

  it('keeps a staged copy created while an earlier delete was still unlinking', async () => {
    // The unlink is asynchronous, so a create() for the same path can land
    // between it and the map update that follows it. Removing the entry
    // unconditionally would discard the mapping of the NEW staged copy, and the
    // next write to that path would fail with "not found" while its bytes sat
    // on disk unreachable. A close followed immediately by a reopen is exactly
    // this shape, and the override reaping made it a routine path.
    const documentPath = new TemporalFilePath('/Documents/notes.txt');

    await repository.create(documentPath);

    const deleting = repository.delete(documentPath);
    await repository.create(documentPath);

    await deleting;

    const staged = await repository.find(documentPath);
    expect(staged.isPresent()).toBe(true);

    await expect(repository.write(documentPath, Buffer.from('later'), 5, 0)).resolves.toBeUndefined();
  });
});
