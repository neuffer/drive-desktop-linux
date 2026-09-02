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
});
