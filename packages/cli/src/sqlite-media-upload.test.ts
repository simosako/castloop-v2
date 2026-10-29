import { expect, test } from "bun:test";
import { sqliteMediaKey } from "../../shared/src/sqlite-media";
import { uploadSqliteMedia } from "./sqlite-media-upload";
import type { R2RestTransport } from "./bounded-http-read";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config = { account_id: "a".repeat(32), bucket_name: "private-bucket" };
const bytes = Buffer.from("frozen-media-input");
const media = { sha256: createHash("sha256").update(bytes).digest("hex"), length_bytes: bytes.length, duration_seconds: 10 };
const key = sqliteMediaKey("daily", media);
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "castloop-direct-media-"));
  try { await writeFile(join(root, "audio.mp3"), bytes); await run(root); }
  finally { await rm(root, { recursive: true }); }
}
const options = (transport: R2RestTransport) => ({ accountId: config.account_id, apiToken: "private-token", transport });

test("direct media PUTs once with no lookup, readback, snapshot copies or journals", async () => {
  await fixture(async (root) => {
    const calls: string[] = [];
    await uploadSqliteMedia(root, config, "daily", "audio.mp3", media, options(async (input, init) => {
      const url = new URL(String(input));
      calls.push(init!.method!);
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-token");
      expect(url.search).toBe("");
      expect(url.pathname).toEndWith(`/objects/${key}`);
      expect(new Headers(init?.headers).get("Content-Length")).toBe(String(bytes.length));
      expect(new Headers(init?.headers).get("Content-Type")).toBe("audio/mpeg");
      expect(Buffer.from(await new Response(init?.body).arrayBuffer())).toEqual(bytes);
      return Response.json({ success: true, result: { key, size: String(bytes.length) } });
    }));
    expect(calls).toEqual(["PUT"]);
    expect(existsSync(join(root, ".castloop"))).toBe(false);
  });
});

test("cover placement uses a content-hash key and its image content type", async () => {
  for (const extension of ["jpg", "png"] as const) await fixture(async (root) => {
    const cover = { sha256: media.sha256, length_bytes: media.length_bytes, extension };
    const coverKey = sqliteMediaKey("daily", cover);
    await uploadSqliteMedia(root, config, "daily", "audio.mp3", cover, options(async (input, init) => {
      expect(init?.method).toBe("PUT");
      expect(String(input)).toEndWith(coverKey);
      expect(new Headers(init?.headers).get("Content-Type")).toBe(extension === "png" ? "image/png" : "image/jpeg");
      await new Response(init?.body).arrayBuffer();
      return Response.json({ success: true, result: { key: coverKey, size: bytes.length } });
    }));
  });
});

test("PUT requires HTTP 200, success, matching key and size, and a consumed source", async () => {
  for (const failure of ["http", "success", "key", "size", "source", "network"]) await fixture(async (root) => {
    const calls: string[] = [];
    await expect(uploadSqliteMedia(root, config, "daily", "audio.mp3", media, options(async (_, init) => {
      calls.push(init!.method!);
      if (failure === "network") throw new Error("Network failure");
      if (failure !== "source") await new Response(init?.body).arrayBuffer();
      if (failure === "http") return new Response(null, { status: 500 });
      return Response.json({ success: failure !== "success", result: {
        key: failure === "key" ? "other" : key, size: failure === "size" ? bytes.length + 1 : bytes.length,
      } });
    }))).rejects.toThrow();
    expect(calls).toEqual(["PUT"]);
    expect(existsSync(join(root, ".castloop"))).toBe(false);
  });
});

test("changed local input fails before network IO", async () => {
  await fixture(async (root) => {
    await writeFile(join(root, "audio.mp3"), "changed");
    let calls = 0;
    await expect(uploadSqliteMedia(root, config, "daily", "audio.mp3", media, options(async () => {
      calls++; throw new Error("Unexpected IO");
    }))).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

test("oversized media and invalid references fail before local or network IO", async () => {
  for (const invalid of [{ ...media, length_bytes: 300_000_001 }, { ...media, sha256: "invalid" }]) {
    let calls = 0;
    await expect(uploadSqliteMedia("missing", config, "daily", "audio.mp3", invalid, options(async () => {
      calls++; throw new Error("Unexpected IO");
    }))).rejects.toThrow();
    expect(calls).toBe(0);
  }
});
