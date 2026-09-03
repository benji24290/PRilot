import { z } from "zod";

export interface HttpClientOptions {
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 3;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class HttpClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(options: HttpClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async json<T>(url: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
    const response = await this.request(url, init);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new HttpError(`Invalid JSON response from ${safeEndpoint(url)}`, response.status);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new HttpError(`Unexpected response shape from ${safeEndpoint(url)}: ${z.prettifyError(parsed.error)}`, response.status);
    }
    return parsed.data;
  }

  async request(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const response = await this.#fetch(url, { ...init, signal: controller.signal });
        if (response.ok) return response;
        if (!isRetryableStatus(response.status) || attempt === this.#maxRetries) {
          await response.body?.cancel();
          throw new HttpError(`HTTP ${response.status} from ${safeEndpoint(url)}`, response.status);
        }
        await response.body?.cancel();
        await delay(retryDelayMs(attempt, response.headers.get("retry-after")));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        lastError = error;
        if (attempt === this.#maxRetries) break;
        await delay(retryDelayMs(attempt));
      } finally {
        clearTimeout(timeout);
      }
    }
    const reason = lastError instanceof Error && lastError.name === "AbortError" ? "request timed out" : "network request failed";
    throw new HttpError(`${reason} for ${safeEndpoint(url)}`);
  }
}

export function safeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "configured endpoint";
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelayMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter && /^\d+$/.test(retryAfter)) return Math.min(Number(retryAfter) * 1_000, 30_000);
  return Math.min(250 * 2 ** attempt, 5_000);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
