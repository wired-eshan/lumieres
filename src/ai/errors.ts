/**
 * Provider error translation shared by chat and model discovery.
 *
 * The app talks to OpenAI-compatible services directly from the browser, so
 * every failure reaches the user as a message. Keep this module provider-
 * agnostic: "the provider" may be OpenAI, OpenRouter, a local server, etc.
 */

export class AIRequestError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'AIRequestError';
    this.retryable = retryable;
  }
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

  // OpenAI SDK errors expose `error` in the response body; some compatible
  // servers nest the message there instead of at the top level.
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
    (error.name === 'APIUserAbortError' || error.name === 'AbortError')
  );
}

export function isRetryable(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
}

/**
 * Turns provider/SDK failures into something a person can act on. Kept
 * deliberately specific: "invalid key" and "rate limited" need different fixes.
 */
export function describeError(error: unknown): string {
  if (error instanceof AIRequestError) return error.message;
  const status = errorStatus(error);
  if (status === 401) return 'The API key was rejected. Check it in Settings.';
  if (status === 403) return 'This API key does not have permission to use that model or endpoint.';
  if (status === 404) {
    return 'That model or endpoint was not found. Check the model and base URL in Settings.';
  }
  if (status === 429) return 'Rate limited by the AI provider. Wait a moment and retry.';
  if (status === 400) {
    return `The request was rejected: ${errorMessage(error) ?? 'bad request'}`;
  }
  if (status !== null && status >= 500) {
    return 'The AI provider had a server error. Retry in a moment.';
  }
  if (error instanceof Error) {
    if (error.name === 'APIConnectionError' || error.name === 'APIConnectionTimeoutError') {
      return 'Could not reach the AI provider. Check the base URL and network connection.';
    }
    return error.message;
  }
  return 'The request failed for an unknown reason.';
}
