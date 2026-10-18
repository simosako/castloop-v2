import { expect, test } from "bun:test";
import { freezePayloadSources } from "./staging-sources";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

for (const length of [4, 65536, 65537, 8 * 1024 * 1024]) {
  test(`frozen source completion is observable after exactly Content-Length bytes (${length})`, async () => {
    const root = await mkdtemp("/tmp/opencode/castloop-source-completion-");
    const bytes = Buffer.alloc(length, 73);
    await writeFile(join(root, "audio.mp3"), bytes);
    const sources = await freezePayloadSources(root, [{ asset: "audio", length_bytes: length,
      sha256: createHash("sha256").update(bytes).digest("hex") }], ["audio.mp3"]);
    try {
      await sources.withPayload(0, async (body, requireConsumed) => {
        const reader = body.getReader();
        try {
          const chunks: Uint8Array[] = [];
          let received = 0;
          while (received < length) {
            const chunk = await reader.read();
            expect(chunk.done).toBe(false);
            received += chunk.value!.length;
            chunks.push(chunk.value!);
          }
          expect(Buffer.concat(chunks)).toEqual(bytes);
          // A Content-Length transport need not request another chunk to discover EOF.
          requireConsumed();
          expect(await reader.read()).toEqual({ done: true, value: undefined });
        } finally { await reader.cancel(); reader.releaseLock(); }
      });
    } finally { await sources.dispose(); await rm(root, { recursive: true }); }
  });
}

for (const mode of ["unread", "partial", "cancelled"] as const) {
  test(`a ${mode} source is not completed or replayable`, async () => {
    const root = await mkdtemp("/tmp/opencode/castloop-source-incomplete-");
    const bytes = Buffer.alloc(mode === "unread" ? 4 : 128 * 1024, 73);
    await writeFile(join(root, "audio.mp3"), bytes);
    const sources = await freezePayloadSources(root, [{ asset: "audio", length_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }], ["audio.mp3"]);
    try {
      await expect(sources.withPayload(0, async (body, requireConsumed) => {
        await Bun.sleep(1);
        expect(requireConsumed).toThrow("owned source finished");
        if (mode !== "unread") {
          const reader = body.getReader();
          try {
            const chunk = await reader.read();
            expect(chunk.done).toBe(false);
            expect(chunk.value!.length).toBeLessThan(bytes.length);
            if (mode === "cancelled") await reader.cancel();
            expect(requireConsumed).toThrow("owned source finished");
          } finally { reader.releaseLock(); }
        }
      })).rejects.toThrow("owned source finished");
      await expect(sources.withPayload(0, async () => {})).rejects.toThrow("cannot be replayed");
      await sources.dispose();
      expect(await readdir(join(root, ".castloop"))).toEqual([]);
    } finally { await sources.dispose(); await rm(root, { recursive: true }); }
  });
}

for (const mode of ["truncated", "grown"] as const) {
  test(`a snapshot ${mode} during consumption fails closed`, async () => {
    const root = await mkdtemp("/tmp/opencode/castloop-source-size-");
    const bytes = Buffer.alloc(65536, 73);
    await writeFile(join(root, "audio.mp3"), bytes);
    const sources = await freezePayloadSources(root, [{ asset: "audio", length_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }], ["audio.mp3"]);
    const [directory] = await readdir(join(root, ".castloop"));
    const snapshot = join(root, ".castloop", directory!, "0");
    try {
      await expect(sources.withPayload(0, async (body, requireConsumed) => {
        await chmod(snapshot, 0o600);
        await writeFile(snapshot, mode === "truncated" ? bytes.subarray(0, 1) : Buffer.concat([bytes, Buffer.of(1)]));
        await expect(new Response(body).arrayBuffer()).rejects.toThrow("frozen size");
        expect(requireConsumed).toThrow("owned source finished");
      })).rejects.toThrow("owned source finished");
    } finally { await sources.dispose(); await rm(root, { recursive: true }); }
  });
}

test("frozen payloads retain private snapshots and cannot be disposed or reused while IO is active", async () => {
  const root = await mkdtemp("/tmp/opencode/castloop-source-owned-");
  const bytes = Buffer.from("private frozen payload");
  await writeFile(join(root, "audio.mp3"), bytes);
  const sources = await freezePayloadSources(root, [{ asset: "audio", length_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") }], ["audio.mp3"]);
  const started = Promise.withResolvers<void>(), settle = Promise.withResolvers<void>();
  try {
    const [directory] = await readdir(join(root, ".castloop"));
    expect((await stat(join(root, ".castloop"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, ".castloop", directory!, "0"))).mode & 0o777).toBe(0o400);
    const pending = sources.withPayload(0, async (body, consumed) => {
      expect(Buffer.from(await new Response(body).arrayBuffer())).toEqual(bytes); consumed();
      started.resolve(); await settle.promise;
    });
    try {
      await started.promise;
      await expect(sources.dispose()).rejects.toThrow("IO is active");
      await expect(sources.assertCurrent()).rejects.toThrow("active IO");
      await expect(sources.withPayload(0, async () => {})).rejects.toThrow("active IO");
    } finally { settle.resolve(); await pending; }
    await expect(sources.withPayload(0, async () => {})).rejects.toThrow("cannot be replayed");
    await sources.dispose(); expect(await readdir(join(root, ".castloop"))).toEqual([]);
  } finally { settle.resolve(); await sources.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("changed and symlinked original sources cannot reach a consumer after freezing", async () => {
  for (const mode of ["changed", "symlink"] as const) {
    const root = await mkdtemp("/tmp/opencode/castloop-source-changed-");
    const bytes = Buffer.from("original"), path = join(root, "audio.mp3");
    await writeFile(path, bytes);
    const sources = await freezePayloadSources(root, [{ asset: "audio", length_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }], ["audio.mp3"]);
    try {
      if (mode === "changed") await writeFile(path, "modified");
      else { await rm(path); await writeFile(join(root, "target.mp3"), bytes); await symlink(join(root, "target.mp3"), path); }
      await expect(sources.assertCurrent()).rejects.toThrow();
      let consumed = false;
      await expect(sources.withPayload(0, async () => { consumed = true; })).rejects.toThrow();
      expect(consumed).toBe(false);
    } finally { await sources.dispose(); await rm(root, { recursive: true, force: true }); }
  }
});
