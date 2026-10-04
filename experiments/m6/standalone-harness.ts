import assert from "node:assert/strict";
import { resolve } from "node:path";

async function run(root: string, args: string[]): Promise<{ code: number; output: string; error: string }> {
  const child = Bun.spawn([resolve("dist/castloop-m6-test-linux-x64"), ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output, error };
}

export async function standaloneOutput(root: string, ...args: string[]): Promise<string> {
  const { code, output } = await run(root, args);
  if (code) throw new Error("Standalone command was not acknowledged; preserve journals without replay");
  return output.trim();
}

export async function standaloneCommand(root: string, ...args: string[]): Promise<unknown> {
  return JSON.parse(await standaloneOutput(root, ...args));
}

export async function expectStandaloneRejection(root: string, ...args: string[]): Promise<string> {
  const result = await run(root, args);
  assert.notEqual(result.code, 0, "Standalone must reject the invalid operation");
  return result.error;
}

async function consumeBody(response: Response, maximumBytes: number, consume: (chunk: Uint8Array) => void): Promise<number> {
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      assert.ok(length <= maximumBytes, "Acceptance response exceeds its explicit byte budget");
      consume(chunk.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return length;
}

export async function readAcceptanceBytes(response: Response): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  await consumeBody(response, 2_000_000, (chunk) => chunks.push(chunk));
  return Buffer.concat(chunks);
}

export async function digestAcceptanceResponse(response: Response, maximumBytes: number): Promise<{ bytes: number; sha256: string }> {
  const hasher = new Bun.CryptoHasher("sha256");
  const bytes = await consumeBody(response, maximumBytes, (chunk) => { hasher.update(chunk); });
  return { bytes, sha256: hasher.digest("hex") };
}
