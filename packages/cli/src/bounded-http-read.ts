export type R2RestTransport = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>;
export type R2RestOptions = { accountId: string; apiToken: string; transport?: R2RestTransport; timeoutMs?: number };

export function requireR2RestOptions(accountId: string, options: R2RestOptions): void {
  if (options.accountId !== accountId || !options.apiToken || /[\r\n]/.test(options.apiToken)) {
    throw new Error("Cloudflare REST credentials do not match the service account");
  }
  const timeoutMs = options.timeoutMs ?? 300000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) throw new Error("Invalid Cloudflare REST timeout");
}

export type BoundedReadCode = "size_limit" | "body_read_failed" | "cleanup_failed";

export class BoundedReadError extends Error {
  constructor(readonly code: BoundedReadCode) { super(code); }
}

export function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("Retry-After");
  if (value === null) return undefined;
  const milliseconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isNaN(milliseconds) ? undefined : Math.max(0, Math.ceil(milliseconds));
}

export async function collectStreamBytes(body: ReadableStream<Uint8Array>, maximumBytes: number,
  cancelOnTerminal = false): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let terminal = false;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch { terminal = true; throw new BoundedReadError("body_read_failed"); }
      if (chunk.done) { terminal = true; break; }
      length += chunk.value.byteLength;
      if (length > maximumBytes) throw new BoundedReadError("size_limit");
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    if (!terminal || cancelOnTerminal) {
      try { await reader.cancel(); }
      catch { throw new BoundedReadError("cleanup_failed"); }
      finally { reader.releaseLock(); }
    } else reader.releaseLock();
  }
}
