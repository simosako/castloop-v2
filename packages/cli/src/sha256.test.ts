import { expect, test } from "bun:test";
import { sha256Hex } from "@castloop/shared";
import { sha256HexSync } from "./sha256";

test("synchronous journal hashing stays byte-identical to shared Web Crypto without introducing an await", async () => {
  for (const source of ["", "abc", "番組🎙", JSON.stringify({ job_id: "job", phase: "requested" }),
    Uint8Array.from([0, 1, 255, 128]).subarray(1, 3)]) {
    expect(sha256HexSync(source)).toBe(await sha256Hex(source));
  }
});
