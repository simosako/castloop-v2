import { expect, test } from "bun:test";
import { assertPublicationInventoryBudget, assertPublicationRenderBudget, publicationCharacterLength } from "./publication-budget";

test("publication inventory accepts the boundary and rejects the next character or Episode", () => {
  for (const characters of [1_999_999, 2_000_000]) expect(() => assertPublicationInventoryBudget(10_000, characters)).not.toThrow();
  expect(() => assertPublicationInventoryBudget(10_001, 0)).toThrow("feed index");
  expect(() => assertPublicationInventoryBudget(1, 2_000_001)).toThrow("feed index");
  expect(publicationCharacterLength('a😀あ')).toBe(3);
});

test("publication rendering preserves its separate conservative allocation budget", () => {
  const bytes = Math.floor((32_000_000 - 4096) / 6);
  expect(() => assertPublicationRenderBudget(bytes, 0)).not.toThrow();
  expect(() => assertPublicationRenderBudget(bytes + 1, 0)).toThrow("conservative rendering budget");
});
