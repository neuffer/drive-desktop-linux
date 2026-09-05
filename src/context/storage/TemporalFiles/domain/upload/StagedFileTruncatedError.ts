/**
 * The staged copy became shorter than the length an upload had already declared.
 *
 * Thrown by the bounded read, where the truncation is proven rather than
 * suspected: `size` bytes were promised to the server and the descriptor has
 * run out. It exists as its own type because the caller has to tell it apart
 * from an ordinary upload failure - the two lead to opposite decisions about
 * the staged copy, and one of them destroys the user's only copy of the file.
 */
export class StagedFileTruncatedError extends Error {
  constructor(declaredSize: number, readSize: number) {
    super(`The staged copy was truncated during the upload: declared ${declaredSize} bytes, read ${readSize}`);
    this.name = 'StagedFileTruncatedError';
  }
}
