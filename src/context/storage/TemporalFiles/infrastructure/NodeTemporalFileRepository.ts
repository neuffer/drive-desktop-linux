import { Service } from 'diod';
import { logger } from '@internxt/drive-desktop-core/build/backend';
import fs, { createReadStream, watch } from 'fs';
import { FileHandle, open, readFile } from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import * as uuid from 'uuid';
import { TemporalFile } from '../domain/TemporalFile';
import { TemporalFilePath } from '../domain/TemporalFilePath';
import { TemporalFileRepository } from '../domain/TemporalFileRepository';
import { TemporalFileUploadSnapshot } from '../domain/upload/TemporalFileUploadSnapshot';
import { StagedFileTruncatedError } from '../domain/upload/StagedFileTruncatedError';
import { Optional } from '../../../../shared/types/Optional';
import { exec } from 'child_process';
import { ensureFolderExists } from '../../../../apps/shared/fs/ensure-folder-exists';

@Service()
export class NodeTemporalFileRepository implements TemporalFileRepository {
  private readonly map = new Map<string, string>();

  /**
   * The revision of each staged copy: an opaque counter, not a timestamp.
   *
   * Every mutation of a staged copy goes through create(), write() or
   * truncate() on this repository, so bumping it here sees all of them. It is
   * monotonic across the whole repository and is never reset, so a revision
   * identifies one exact state of one staged copy and can never be confused
   * with a later one. A timestamp cannot do this: filesystem modification
   * times are quantised, so an in-place edit that changes no bytes of length
   * within the same quantum is indistinguishable from no edit at all.
   */
  private readonly revisions = new Map<string, number>();
  private nextRevision = 1;

  constructor(private readonly folder: string) {}

  private bumpRevision(documentPath: TemporalFilePath) {
    this.revisions.set(documentPath.value, this.nextRevision);
    this.nextRevision += 1;
  }

  init() {
    ensureFolderExists(this.folder);
  }

  async exits(documentPath: TemporalFilePath): Promise<boolean> {
    const pathToRead = this.map.get(documentPath.value);

    if (!pathToRead) {
      return false;
    }

    return new Promise((resolve) => {
      fs.stat(pathToRead, (err) => {
        if (err) {
          resolve(false);
          return;
        }

        resolve(true);
      });
    });
  }

  create(documentPath: TemporalFilePath): Promise<void> {
    logger.debug({ msg: `Creating file: ${documentPath.value}` });
    const id = uuid.v4();

    const pathToWrite = path.join(this.folder, id);

    this.map.set(documentPath.value, pathToWrite);
    this.bumpRevision(documentPath);

    return new Promise((resolve, reject) => {
      fs.writeFile(pathToWrite, '', (err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  areEqual(doc1: TemporalFilePath, doc2: TemporalFilePath): Promise<boolean> {
    const file1 = this.map.get(doc1.value);
    const file2 = this.map.get(doc2.value);

    if (!file1) {
      throw new Error(`${doc1.value} not found`);
    }
    if (!file2) {
      throw new Error(`${doc2.value} not found`);
    }

    return new Promise((resolve, reject) => {
      exec(`diff ${file1} ${file2}`, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        const filesAreEqual = stdout === null;
        resolve(filesAreEqual);
      });
    });
  }

  async delete(documentPath: TemporalFilePath): Promise<void> {
    const pathToDelete = this.map.get(documentPath.value);

    if (!pathToDelete) {
      return;
    }

    const fsDeletion = new Promise<void>((resolve, reject) => {
      fs.unlink(pathToDelete, (err: NodeJS.ErrnoException | null) => {
        if (err) {
          if (err.code === 'ENOENT') {
            logger.debug({
              msg: `Could not delete ${pathToDelete}, it already does not exist`,
            });
            resolve();
            return;
          }

          reject(err);
          return;
        }

        resolve();
      });
    });

    await fsDeletion;

    // Only drop the mapping if it still points at what was just unlinked. The
    // unlink is asynchronous, so a create() for the same path can land while it
    // is in flight and install a new staged copy; deleting the entry
    // unconditionally would then discard the NEW copy's mapping, and the next
    // write to that path would fail with "not found" while its bytes sat on
    // disk unreachable.
    if (this.map.get(documentPath.value) !== pathToDelete) {
      return;
    }

    this.map.delete(documentPath.value);
    this.revisions.delete(documentPath.value);
  }

  async matchingDirectory(directory: string): Promise<TemporalFilePath[]> {
    const paths = Array.from(this.map.keys());

    return paths.filter((p) => path.dirname(p) === directory).map((p) => new TemporalFilePath(p));
  }

  read(documentPath: TemporalFilePath): Promise<Buffer> {
    const id = this.map.get(documentPath.value);

    if (!id) {
      throw new Error(`Document with path ${documentPath.value} not found`);
    }

    return readFile(id);
  }

  async write(documentPath: TemporalFilePath, buffer: Buffer, length: number, position: number): Promise<void> {
    const pathToWrite = this.map.get(documentPath.value);

    if (!pathToWrite) {
      throw new Error(`Document with path ${documentPath.value} not found`);
    }

    // Bump BEFORE the mutation, never after. A close that throws once the bytes
    // are already on disk would skip a trailing bump and leave a changed file
    // wearing its old revision, which is the one way the reaper can be told to
    // delete bytes the upload never sent. An unnecessary bump costs one extra
    // upload; a missed one costs data.
    this.bumpRevision(documentPath);

    const fd = fs.openSync(pathToWrite, 'r+');
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    try {
      fs.writeSync(fd, bytes, 0, length, position);
    } finally {
      fs.closeSync(fd);
    }
  }

  async truncate(documentPath: TemporalFilePath, size: number): Promise<void> {
    const pathToWrite = this.map.get(documentPath.value);

    if (!pathToWrite) {
      throw new Error(`Document with path ${documentPath.value} not found`);
    }

    this.bumpRevision(documentPath);

    fs.truncateSync(pathToWrite, size);
  }

  async stream(documentPath: TemporalFilePath): Promise<Readable> {
    const pathToRead = this.map.get(documentPath.value);

    if (!pathToRead) {
      throw new Error(`Document with path ${documentPath.value} not found`);
    }

    return createReadStream(pathToRead);
  }

  /** Read size for one positional read of the upload descriptor. */
  private static readonly UPLOAD_CHUNK_BYTES = 64 * 1024;

  /**
   * Yields at most `size` bytes of `handle`, by positional read.
   *
   * Positional reads, so an attempt after the first starts at zero again rather
   * than continuing where the last one stopped, and the running `position`
   * bound is what guarantees no attempt sends more than was declared, however
   * far the file has grown in the meantime.
   */
  private static async *readBounded(handle: FileHandle, size: number): AsyncGenerator<Buffer> {
    const buffer = Buffer.allocUnsafe(NodeTemporalFileRepository.UPLOAD_CHUNK_BYTES);
    let position = 0;

    while (position < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);

      // A short read means the file was truncated under us, and there is no
      // recovering the promise already made: `size` bytes were declared to the
      // server and fewer exist. Ending the stream quietly here is what sends a
      // body shorter than its content length.
      //
      // The watcher aborts this case too, and usually first, but it is driven
      // by an fs event and can lose the race against a read already in flight.
      // Here the truncation is not suspected, it is proven, so this is where
      // the guarantee has to be enforced rather than reported.
      if (bytesRead === 0) {
        throw new StagedFileTruncatedError(size, position);
      }

      position += bytesRead;
      yield Buffer.from(buffer.subarray(0, bytesRead));
    }
  }

  /**
   * Opens the mapped file once and bounds one upload to the length that same
   * descriptor reports.
   *
   * @returns a handle whose `size` bounds what `open()` produces, and whose
   * `dispose()` the caller owns.
   * @throws Error when the document has no mapping, or the open fails. Nothing
   * is left open if taking the length fails.
   */
  async createUploadSnapshot(documentPath: TemporalFilePath): Promise<TemporalFileUploadSnapshot> {
    const pathToOpen = this.map.get(documentPath.value);

    if (!pathToOpen) {
      throw new Error(`Document with path ${documentPath.value} not found`);
    }

    const handle = await open(pathToOpen, 'r');

    try {
      // fstat on the handle rather than stat on the path, so the length and the
      // body are two reads of one inode instead of two observations of a name.
      const { size } = await handle.stat();

      return {
        size,
        // Generator-backed rather than handle.createReadStream, and that is
        // load-bearing: a stream created FROM the handle closes it when it is
        // destroyed, and `autoClose: false` does NOT prevent that - it governs
        // only the natural-end path. EnvironmentTemporalFileUploader destroys
        // the readable on both its error and abort paths, so a handle-backed
        // stream would be closed by the FIRST failed attempt and every retry
        // would then read from a dead descriptor. Retrying is the whole reason
        // this class exists, so the stream must not own the handle.
        open: () => Readable.from(NodeTemporalFileRepository.readBounded(handle, size)),
        dispose: () => handle.close(),
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async find(documentPath: TemporalFilePath): Promise<Optional<TemporalFile>> {
    logger.debug({ msg: `Finding file: ${documentPath.value}` });
    const pathToSearch = this.map.get(documentPath.value);

    if (!pathToSearch) {
      return Optional.empty();
    }

    let stat: fs.Stats;

    try {
      stat = fs.statSync(pathToSearch);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        logger.debug({
          msg: 'Temporal file was removed from disk before reading attributes',
          documentPath: documentPath.value,
          pathToSearch,
        });
      }

      return Optional.empty();
    }

    const doc = TemporalFile.from({
      createdAt: stat.ctime,
      modifiedAt: stat.mtime,
      path: documentPath.value,
      size: stat.size,
      contentFilePath: pathToSearch,
      revision: this.revisions.get(documentPath.value),
    });

    return Optional.of(doc);
  }

  watchFile(documentPath: TemporalFilePath, callback: (observedSize: number) => void): () => void {
    const pathToWatch = this.map.get(documentPath.value);

    logger.debug({ msg: `Watching file: ${documentPath.value}` });

    if (!pathToWatch) {
      throw new Error(`Document with path ${documentPath.value} not found`);
    }

    // No filter on the reported name. Exactly one file is watched, so every
    // event is about that file, and the filter that used to stand here compared
    // fs.watch's name (the uuid create() maps the document to) against the
    // logical name on the drive. Those are two namespaces and can never be
    // equal, so the early return was taken on every event and the callback was
    // unreachable. On platforms that report a null filename it failed too.
    const watcher = watch(pathToWatch, () => {
      callback(NodeTemporalFileRepository.observedSizeOf(pathToWatch));
    });

    return () => {
      watcher.close();
    };
  }

  /**
   * The length of a watched file, as seen from inside a watch callback.
   *
   * Synchronous on purpose: an async stat would resolve after further writes
   * could have landed, so the size reported would describe a moment other than
   * the event that asked for it.
   *
   * @returns the file's current length, or 0 when it cannot be stat'd. A
   * deleted or unreadable backing file is reported as empty rather than
   * throwing into fs.watch's callback, where nothing could catch it.
   */
  private static observedSizeOf(pathToWatch: string): number {
    try {
      return fs.statSync(pathToWatch).size;
    } catch {
      return 0;
    }
  }

  statFs(): Promise<{ blocks: number; bfree: number; bavail: number; files: number; ffree: number; bsize: number }> {
    return new Promise((resolve, reject) => {
      fs.statfs(this.folder, (err, stats) => {
        if (err) {
          reject(err);
          return;
        }

        resolve({
          blocks: stats.blocks,
          bfree: stats.bfree,
          bavail: stats.bavail,
          files: stats.files,
          ffree: stats.ffree,
          bsize: stats.bsize,
        });
      });
    });
  }
}
