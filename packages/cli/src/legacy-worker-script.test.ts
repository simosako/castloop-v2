import { expect, test } from "bun:test";
import { inspectLegacyWorkerScript } from "./legacy-worker-script";
import { createHash } from "node:crypto";

const source = 'globalThis.__castloopLegacyScriptExecuted = true; export default {fetch(){return new Response("private body")},queue(){}};';
const script = (text = source) => new Response(text, { headers: { "Content-Type": "application/javascript+module" } });
const diagnostic = "Legacy Worker script inspection failed; no deployment is authorized";

test("closed default-only module is parsed without execution and only its checksum is returned", async () => {
  expect(await inspectLegacyWorkerScript(script())).toBe(createHash("sha256").update(source).digest("hex"));
  expect(Reflect.has(globalThis, "__castloopLegacyScriptExecuted")).toBe(false);
  const form = new FormData();
  form.append("index.js", new Blob([source], { type: "application/javascript+module" }), "index.js");
  expect(await inspectLegacyWorkerScript(new Response(form))).toBe(await inspectLegacyWorkerScript(script()));
  const textForm = new FormData();
  textForm.append("index.js", source);
  expect(await inspectLegacyWorkerScript(new Response(textForm))).toBe(await inspectLegacyWorkerScript(script()));
});

for (const invalid of ["export default {", "module.exports = {};", "export default {}; export class CachedPublicAssets {}",
  'export {default} from "./worker.js";', 'import "./dependency.js"; export default {};',
  'import("./dependency.js"); export default {};', 'export * from "./other.js"; export default {};']) {
  test(`rejects incomplete or non-closed module ${invalid}`, async () => {
    await expect(inspectLegacyWorkerScript(script(invalid))).rejects.toThrow(diagnostic);
  });
}

test("multipart inspection rejects metadata, duplicate parts, extra assets and unknown module names", async () => {
  for (const invalid of ["metadata", "duplicate", "asset", "unknown"] as const) {
    const form = new FormData();
    form.append("index.js", new Blob([source], { type: "application/javascript+module" }), "index.js");
    if (invalid === "metadata") form.append("metadata", '{"private":"body"}');
    if (invalid === "duplicate") form.append("index.js", new Blob([source], { type: "application/javascript+module" }), "index.js");
    if (invalid === "asset") form.append("other.bin", new Blob(["private payload"], { type: "application/octet-stream" }), "other.bin");
    if (invalid === "unknown") { form.delete("index.js"); form.append("metadata", source); }
    await expect(inspectLegacyWorkerScript(new Response(form))).rejects.toThrow(diagnostic);
  }
});

test("HTTP, MIME, declared/actual length and UTF-8 failures do not expose arbitrary source diagnostics", async () => {
  const cases = [new Response("private error", { status: 403 }), new Response(source, { status: 206,
    headers: { "Content-Type": "application/javascript", "Content-Range": "bytes 0-10/20" } }),
    new Response(source, { headers: { "Content-Type": "text/html" } }),
    new Response(source, { headers: { "Content-Type": "application/javascript", "Content-Length": "99999999" } }),
    new Response(source, { headers: { "Content-Type": "application/javascript", "Content-Length": "1" } }),
    new Response(source, { headers: { "Content-Type": "application/javascript", "Content-Length": "invalid" } }),
    new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/javascript" } }),
    new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { "Content-Type": "application/javascript" } })];
  for (const response of cases) await expect(inspectLegacyWorkerScript(response)).rejects.toThrow(diagnostic);
});

test("oversized response cancellation is owned and awaited before a fixed failure is returned", async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const cancelling = new Promise<void>((resolve) => { started = resolve; });
  let settled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ async cancel() {
    started(); await gate; throw new Error("private cancellation detail");
  } }), { headers: { "Content-Type": "application/javascript", "Content-Length": "99999999" } });
  const pending = inspectLegacyWorkerScript(response).catch((error: unknown) => { settled = true; return error; });
  await cancelling;
  expect(settled).toBe(false);
  release();
  const error = await pending;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(diagnostic);
});

test("empty streaming chunks cannot exhaust the read budget indefinitely", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array()); },
    cancel() { cancelled = true; } }), { headers: { "Content-Type": "application/javascript" } });
  await expect(inspectLegacyWorkerScript(response)).rejects.toThrow(diagnostic);
  expect(cancelled).toBe(true);
});
