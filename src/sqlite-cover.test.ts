import { expect, test } from "bun:test";
import { sqliteCoverSnapshotKey, validSqliteCoverIdentity } from "./sqlite-cover";

test("cover references require validated Show, positive safe generation and supported extension", () => {
  expect(sqliteCoverSnapshotKey("daily", 3, "jpg")).toBe("public/podcasts/daily/covers/3.jpg");
  expect(sqliteCoverSnapshotKey("daily", 5, "png")).toBe("public/podcasts/daily/covers/5.png");
  for (const generation of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => sqliteCoverSnapshotKey("daily", generation, "jpg")).toThrow();
  }
  expect(() => sqliteCoverSnapshotKey("../private", 1, "jpg")).toThrow();
  const cover = { generation: 1, sha256: "a".repeat(64), lengthBytes: 5_000_000 };
  expect(validSqliteCoverIdentity(cover)).toBe(true);
  for (const patch of [{ sha256: "unknown" }, { lengthBytes: 5_000_001 }, { lengthBytes: 0 }, { generation: 0 }]) {
    expect(validSqliteCoverIdentity({ ...cover, ...patch })).toBe(false);
  }
});
