import { logger } from '@internxt/drive-desktop-core/build/backend';
import { DriveDesktopError } from '../../../context/shared/domain/errors/DriveDesktopError';
import { extractPropertyFromStringyfiedJson } from '../../../shared/extract-property-from-json';
import {
  INITIAL_CONNECTION_TIMEOUT_DELAY_MS,
  INITIAL_PARENT_FOLDER_NOT_FOUND_DELAY_MS,
  INITIAL_RATE_LIMIT_DELAY_MS,
  INITIAL_SERVER_ERROR_DELAY_MS,
  MAX_BACKOFF_MS,
} from './constants';

export function parseRetryAfterMs(message?: string) {
  const retryAfterSeconds = extractPropertyFromStringyfiedJson(message ?? '', 'retry_after');
  return typeof retryAfterSeconds === 'number' ? retryAfterSeconds * 1000 : INITIAL_RATE_LIMIT_DELAY_MS;
}

function isConnectionTimeoutError(err: Error & { code?: unknown }) {
  if (
    err.code === 'ETIMEDOUT' ||
    err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    err.code === 'UND_ERR_SOCKET' ||
    err.code === 'UND_ERR_HEADERS_TIMEOUT'
  ) {
    return true;
  }

  return (
    err.message.includes('Connect Timeout Error') ||
    err.message.includes('Headers Timeout Error') ||
    err.message.includes('other side closed')
  );
}

function isS3RequestTimeoutError(err: Error) {
  return (
    err.message.includes('<Code>RequestTimeout</Code>') ||
    err.message.includes('socket connection to the server was not read from or written to within the timeout period')
  );
}

/**
 * The HTTP status behind an upload failure, from wherever it is available.
 *
 * `inxt-js` reports a non-200 upload response by throwing a plain `Error` with
 * the status code inside the MESSAGE rather than as a property:
 *
 *     // node_modules/@internxt/inxt-js/build/lib/core/upload/uploadV2.js
 *     throw new Error(`Failed to upload file: ${statusCode} ${await responseBody.text()}`);
 *     // ...and multipart.js
 *     throw new Error(`Failed to upload part: ${statusCode} ${await body.text()}`);
 *
 * Nothing between there and here changes the object -
 * `EnvironmentTemporalFileUploader` rethrows it as it is - so without reading
 * the message, every 5xx and 429 from the storage node fell through to
 * `UNKNOWN`. `UNKNOWN` is not retryable, so those were not retried at all, and
 * `release` deletes the staged copy for any failure it does not recognise. A
 * transient server error therefore destroyed the user's local copy instead of
 * waiting and trying again.
 *
 * The two message formats are matched exactly rather than by scanning for any
 * number, so an unrelated error that happens to contain digits cannot be
 * mistaken for a status, and the code is bounded to 1xx-5xx so an impossible
 * status cannot reach the retry condition.
 *
 * @returns the status code, or undefined when the error carries none.
 */
function uploadStatusOf(err: Error & { status?: unknown }): number | undefined {
  if (typeof err.status === 'number') {
    return err.status;
  }

  // 1xx-5xx only. A bare \d{3} would accept 600-999, and since 5xx and above
  // is the retry condition below, an impossible status would then be retried
  // for as long as the process lived.
  const reported = /^Failed to upload (?:file|part): ([1-5][0-9]{2})(?: |$)/.exec(err.message);

  return reported ? Number(reported[1]) : undefined;
}

export function mapEnvironmentUploadError(err: Error & { code?: unknown; status?: unknown }): DriveDesktopError {
  if (err.code === 'EACCES' || err.code === 'EPERM') {
    return new DriveDesktopError('ACTION_NOT_PERMITTED', err.message);
  }

  if (isS3RequestTimeoutError(err)) {
    return new DriveDesktopError('CONNECTION_TIMEOUT', `[S3_REQUEST_TIMEOUT] ${err.message}`);
  }

  if (isConnectionTimeoutError(err)) {
    return new DriveDesktopError('CONNECTION_TIMEOUT', err.message);
  }

  if (err.message === 'Max space used') {
    return new DriveDesktopError('NOT_ENOUGH_SPACE');
  }

  const status = uploadStatusOf(err);

  if (typeof status === 'number') {
    if (status === 429) {
      return new DriveDesktopError('RATE_LIMITED', String(parseRetryAfterMs(err.message)));
    }

    if (status >= 500) {
      return new DriveDesktopError('INTERNAL_SERVER_ERROR');
    }
  }

  return new DriveDesktopError('UNKNOWN', err.message);
}

function exponentialBackoff(attempts: number, baseMs: number) {
  return Math.min(baseMs * Math.pow(2, attempts - 1), MAX_BACKOFF_MS);
}

const RETRYABLE_CAUSES = [
  'RATE_LIMITED',
  'CONNECTION_TIMEOUT',
  'INTERNAL_SERVER_ERROR',
  'NETWORK_ERROR',
  'PARENT_FOLDER_NOT_FOUND',
] as const;

type RetryableCause = (typeof RETRYABLE_CAUSES)[number];

function isRetryableCause(cause: DriveDesktopError['cause']): cause is RetryableCause {
  return RETRYABLE_CAUSES.includes(cause as RetryableCause);
}

function getRetryBaseDelay(error: DriveDesktopError) {
  if (error.cause === 'RATE_LIMITED') {
    return Number(error.message) || INITIAL_RATE_LIMIT_DELAY_MS;
  }

  if (error.cause === 'CONNECTION_TIMEOUT') {
    return INITIAL_CONNECTION_TIMEOUT_DELAY_MS;
  }

  if (error.cause === 'INTERNAL_SERVER_ERROR' || error.cause === 'NETWORK_ERROR') {
    return INITIAL_SERVER_ERROR_DELAY_MS;
  }

  if (error.cause === 'PARENT_FOLDER_NOT_FOUND') {
    return INITIAL_PARENT_FOLDER_NOT_FOUND_DELAY_MS;
  }

  return INITIAL_RATE_LIMIT_DELAY_MS;
}

type Props = {
  tag: 'BACKUPS' | 'SYNC-ENGINE';
  context: string;
  path: string;
};

export function createTransientErrorHandler({ tag, context, path }: Props) {
  let transientAttempts = 0;

  return (error: DriveDesktopError): number | null => {
    if (isRetryableCause(error.cause)) {
      transientAttempts++;

      const baseDelayMs = getRetryBaseDelay(error);

      const delayMs = exponentialBackoff(transientAttempts, baseDelayMs);

      logger.debug({
        tag,
        msg: `[${context}]`,
        cause: error.cause,
        attempt: transientAttempts,
        delayMs,
        path,
      });

      return delayMs;
    }

    return null;
  };
}
