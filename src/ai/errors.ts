/**
 * Provider error translation shared by chat and model discovery.
 *
 * The app talks to providers directly from the browser, so every failure
 * reaches the user as a message. Two rules matter for BYOK:
 *
 *  1. The message must be specific enough to act on — "invalid key" and "rate
 *     limited" need different fixes.
 *  2. A provider/SDK error must never echo the API key or an authorization
 *     header into the UI, a log or telemetry. Every message passes through
 *     `redactSecrets` before it is returned.
 *
 * Keep this module provider-agnostic: "the provider" may be OpenAI, OpenRouter,
 * DeepSeek, Anthropic or a custom endpoint.
 */

export class AIRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'AIRequestError';
    this.retryable = retryable;
  }
}

export interface DescribeErrorOptions {
  /** Values that must never appear in the returned message. */
  secrets?: readonly string[];
  /** Human-readable provider label used in a few messages. */
  providerLabel?: string;
}

export function errorStatus(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? status : null;
  }
  return null;
}

export function errorMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;

  // OpenAI/Anthropic SDK errors expose `error` in the response body; some
  // compatible servers nest the message there instead of at the top level.
  const body = (error as { error?: unknown }).error;
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }

  if ('message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return null;
}

export function isAbortError(error: unknown): boolean {
  if (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'AbortError'
  ) {
    return true;
  }
  return (
    error instanceof Error &&
    (error.name === 'APIUserAbortError' ||
      error.name === 'AbortError' ||
      error.name === 'AbortSignalError')
  );
}

export function isRetryable(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
}

/**
 * Removes obvious secrets and authorization material from free text.
 *
 * Exact known secrets are replaced first (string splitting, not a regex, so
 * punctuation in a key cannot break the match), then common key/token shapes
 * and header forms are redacted. This is intentionally conservative: an error
 * message is not valuable enough to risk leaking a credential.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;

  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed.length < 3) continue;
    out = out.split(trimmed).join('[redacted]');
  }

  // Header-like values (Authorization: Bearer …, x-api-key: …) and key-shaped
  // tokens. Run after exact replacements so the placeholder is not re-redacted.
  out = out.replace(
    /\b(authorization|x-api-key|api[-_ ]?key)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi,
    '$1: [redacted]',
  );
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [redacted]');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, '[redacted]');
  return out;
}

function safeMessage(error: unknown, options: DescribeErrorOptions): string {
  return redactSecrets(errorMessage(error) ?? '', options.secrets);
}

/**
 * Turns provider/SDK failures into something a person can act on.
 * Deliberately specific: "invalid key" and "rate limited" need different fixes.
 */
export function describeError(
  error: unknown,
  options: DescribeErrorOptions = {},
): string {
  if (error instanceof AIRequestError) {
    return redactSecrets(error.message, options.secrets);
  }

  const status = errorStatus(error);
  const raw = safeMessage(error, options);
  const lower = raw.toLowerCase();
  const provider = options.providerLabel ?? 'AI provider';

  if (status === 401) {
    return 'The API key was rejected. Check the key for this provider in Settings.';
  }
  if (status === 403) {
    return 'This API key does not have permission to use that model or endpoint.';
  }
  if (status === 404) {
    return 'That model or endpoint was not found. Check the model id and base URL in Settings.';
  }
  if (status === 402) {
    return `${provider} reports insufficient credits or a billing limit. Check the account and try again.`;
  }
  if (status === 429) {
    return `${provider} rate-limited the request. Wait a moment and retry.`;
  }
  if (status === 400 || status === 422) {
    if (lower.includes('reasoning') || lower.includes('effort')) {
      return 'The selected reasoning effort is not supported by this model. Choose another level or Provider default in Settings.';
    }
    if (
      lower.includes('model') &&
      (lower.includes('not found') ||
        lower.includes('does not exist') ||
        lower.includes('invalid') ||
        lower.includes('unknown'))
    ) {
      return 'That model id was not accepted. Check the model id in Settings.';
    }
    if (lower.includes('api key') || lower.includes('authentication')) {
      return 'The API key was rejected. Check the key for this provider in Settings.';
    }
    return raw.length > 0
      ? `The request was rejected: ${raw}`
      : 'The request was rejected by the provider. Check the model and settings.';
  }
  if (status !== null && status >= 500) {
    return `${provider} had a server error. Retry in a moment.`;
  }
  if (error instanceof Error) {
    if (error.name === 'APIConnectionError' || error.name === 'APIConnectionTimeoutError') {
      return 'Could not reach the AI provider. Check the base URL and network connection.';
    }
    if (error.name === 'AbortError' || error.name === 'APIUserAbortError') {
      return 'Request stopped.';
    }
    if (error.message.length > 0) {
      return redactSecrets(error.message, options.secrets);
    }
  }
  // Plain objects from an SSE `error` event or a non-Error rejection still
  // carry a useful message; redaction already ran above.
  if (raw.length > 0) return raw;
  return 'The request failed for an unknown reason.';
}
