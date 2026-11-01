import { expect, test } from "bun:test";
import { validSqliteCoverIdentity } from "./sqlite-cover";

test("cover references require a positive safe generation, a hex content hash and a bounded length", () => {
  const cover = { generation: 1, sha256: "a".repeat(64), lengthBytes: 5_000_000 };
  expect(validSqliteCoverIdentity(cover)).toBe(true);
  for (const patch of [{ sha256: "unknown" }, { lengthBytes: 5_000_001 }, { lengthBytes: 0 }, { generation: 0 }]) {
    expect(validSqliteCoverIdentity({ ...cover, ...patch })).toBe(false);
  }
});
