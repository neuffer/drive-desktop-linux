import { Readable } from 'stream';
import { TemporalFile } from './TemporalFile';
import { TemporalFilePath } from './TemporalFilePath';
import { Optional } from '../../../../shared/types/Optional';
import { TemporalFileUploadSnapshot } from './upload/TemporalFileUploadSnapshot';

export abstract class TemporalFileRepository {
  abstract create(path: TemporalFilePath): Promise<void>;

  abstract delete(path: TemporalFilePath): Promise<void>;

  abstract matchingDirectory(path: string): Promise<Array<TemporalFilePath>>;

  abstract write(path: TemporalFilePath, buffer: Buffer, length: number, position: number): Promise<void>;

  abstract truncate(path: TemporalFilePath, size: number): Promise<void>;

  abstract read(path: TemporalFilePath): Promise<Buffer>;

  abstract stream(path: TemporalFilePath): Promise<Readable>;

  /**
   * Takes a private copy of a temporal file's contents for the duration of one
   * upload. The caller disposes of it.
   */
  abstract createUploadSnapshot(path: TemporalFilePath): Promise<TemporalFileUploadSnapshot>;

  abstract find(documentPath: TemporalFilePath): Promise<Optional<TemporalFile>>;

  /**
   * Reports every change to a staged copy's backing file, with the length that
   * file has once the change has landed.
   *
   * The size is reported rather than judged: what counts as a change worth
   * acting on belongs to the upload that declared a length, not to the storage
   * that observes one. A size of 0 is reported when the file can no longer be
   * stat'd, which is what a deletion looks like from here.
   *
   * @returns a function that stops the watch. Calling it twice is safe.
   */
  abstract watchFile(documentPath: TemporalFilePath, callback: (observedSize: number) => void): () => void;

  abstract areEqual(doc1: TemporalFilePath, doc2: TemporalFilePath): Promise<boolean>;

  abstract statFs(): Promise<{
    blocks: number;
    bfree: number;
    bavail: number;
    files: number;
    ffree: number;
    bsize: number;
  }>;
}
