import { describe, expect, it } from 'vitest';
import {
  AIRequestError,
  describeError,
  errorMessage,
  errorStatus,
  isAbortError,
  isRetryable,
  redactSecrets,
} from './errors';

describe('AI error messages', () => {
  it('maps provider statuses to actionable messages', () => {
    expect(describeError({ status: 401 })).toContain('key was rejected');
    expect(describeError({ status: 403 })).toContain('permission');
    expect(describeError({ status: 404 })).toContain('model or endpoint was not found');
    expect(describeError({ status: 429 })).toContain('rate-limited');
    expect(describeError({ status: 402 })).toContain('credits');
    expect(describeError({ status: 400, message: 'bad params' })).toContain('bad params');
    expect(describeError({ status: 500 })).toContain('server error');
  });

  it('recognises reasoning/model rejection details in a 400', () => {
    expect(
      describeError({ status: 400, message: 'unsupported reasoning effort: minimal' }),
    ).toContain('reasoning effort');
    expect(
      describeError({ status: 400, message: 'model gpt-nope does not exist' }),
    ).toContain('model id');
  });

  it('uses the provider label for rate limits and server errors', () => {
    expect(describeError({ status: 429 }, { providerLabel: 'Anthropic' })).toContain(
      'Anthropic',
    );
    expect(describeError({ status: 503 }, { providerLabel: 'DeepSeek' })).toContain(
      'DeepSeek',
    );
  });

  it('recognises connection failures', () => {
    const error = new Error('offline');
    error.name = 'APIConnectionError';
    expect(describeError(error)).toContain('Could not reach the AI provider');
  });

  it('reads a nested provider error body', () => {
    expect(describeError({ status: 400, error: { message: 'unsupported parameter' } })).toContain(
      'unsupported parameter',
    );
  });

  it('returns a plain SSE error message rather than “unknown”', () => {
    expect(describeError({ status: null, message: 'upstream exploded' })).toBe(
      'upstream exploded',
    );
  });

  it('passes through its own request errors (redacted)', () => {
    expect(describeError(new AIRequestError('declined', false))).toBe('declined');
    expect(
      describeError(new AIRequestError('failed with sk-secret-123456'), {
        secrets: ['sk-secret-123456'],
      }),
    ).not.toContain('sk-secret-123456');
  });

  it('never throws on unknown values', () => {
    expect(describeError(null)).toBe('The request failed for an unknown reason.');
    expect(describeError('weird')).toBe('The request failed for an unknown reason.');
  });
});

describe('secret redaction', () => {
  it('removes exact secret values', () => {
    expect(redactSecrets('key sk-or-v1-abcdef was rejected', ['sk-or-v1-abcdef'])).toBe(
      'key [redacted] was rejected',
    );
  });

  it('removes authorization headers and bearer tokens', () => {
    const text = 'Authorization: Bearer abc.def.ghi\nx-api-key: super-secret';
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain('abc.def.ghi');
    expect(redacted).not.toContain('super-secret');
    expect(redacted).toContain('[redacted]');
  });

  it('removes key-shaped tokens even without an explicit secret list', () => {
    expect(redactSecrets('bad key sk-ant-api03-abcdef')).not.toContain(
      'sk-ant-api03-abcdef',
    );
  });

  it('redacts the key from a nested provider error message', () => {
    const message = describeError(
      {
        status: 400,
        error: { message: 'invalid key sk-secret-abcdef' },
      },
      { secrets: ['sk-secret-abcdef'] },
    );
    expect(message).not.toContain('sk-secret-abcdef');
  });
});

describe('error helpers', () => {
  it('detects abort and retryable errors', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'APIUserAbortError' });
    expect(isAbortError(abort)).toBe(true);
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 529 })).toBe(true);
    expect(isRetryable({ status: 401 })).toBe(false);
  });

  it('reads status and nested message without throwing', () => {
    expect(errorStatus({ status: 418 })).toBe(418);
    expect(errorStatus(null)).toBeNull();
    expect(errorMessage({ error: { message: 'nested' } })).toBe('nested');
    expect(errorMessage({ message: 'top' })).toBe('top');
    expect(errorMessage(null)).toBeNull();
  });
});
