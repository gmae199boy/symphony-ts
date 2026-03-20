/**
 * fetch wrapper with retry on transient failures.
 * Respects the Retry-After header when present;
 * otherwise uses exponential backoff.
 *
 * API-specific retry conditions can be injected via shouldRetry / resolveDelayMs.
 */

import { logger } from './logger.js';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export interface FetchRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Custom retry condition. Overrides the default 429/5xx check when provided. */
  shouldRetry?: (response: Response) => boolean;
  /** Custom delay resolver. Overrides default Retry-After/backoff when provided. */
  resolveDelayMs?: (response: Response, attempt: number) => number;
}

export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  opts?: FetchRetryOptions,
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = opts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const shouldRetry = opts?.shouldRetry ?? defaultShouldRetry;
  const delayFn = opts?.resolveDelayMs ?? ((resp: Response, attempt: number) => resolveDelay(resp, attempt, baseDelay));

  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (init?.signal?.aborted) {
      throw new Error('Request aborted');
    }
    const response = await fetch(input, init);

    if (!shouldRetry(response)) {
      return response;
    }

    lastResponse = response;

    if (attempt >= maxRetries) break;

    const delayMs = delayFn(response, attempt);
    logger.warn(`HTTP ${response.status} from ${urlLabel(input)}, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
    await sleep(delayMs);
  }

  return lastResponse!;
}

function defaultShouldRetry(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

function resolveDelay(response: Response, attempt: number, baseDelay: number): number {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1_000, MAX_DELAY_MS);
    }
  }
  return Math.min(baseDelay * Math.pow(2, attempt), MAX_DELAY_MS);
}

function urlLabel(input: string | URL | Request): string {
  if (typeof input === 'string') return input.slice(0, 80);
  if (input instanceof URL) return input.toString().slice(0, 80);
  return input.url?.slice(0, 80) ?? 'unknown';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
