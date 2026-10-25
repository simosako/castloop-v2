export const PUBLICATION_EPISODE_LIMIT = 10_000;
export const PUBLICATION_REVISION_CHARACTER_LIMIT = 2_000_000;

export function publicationCharacterLength(value: string): number {
  let length = 0;
  for (const _ of value) length++;
  return length;
}

export function assertPublicationInventoryBudget(count: number, revisionCharacters: number): void {
  if (count > PUBLICATION_EPISODE_LIMIT || revisionCharacters > PUBLICATION_REVISION_CHARACTER_LIMIT) {
    throw new Error("Publication feed index exceeds its rendering budget");
  }
}

export const PUBLICATION_RENDER_BUDGET_BYTES = 32_000_000;

export function assertPublicationRenderBudget(sourceBytes: number, count: number): void {
  if (sourceBytes * 6 + count * 1024 + 4096 > PUBLICATION_RENDER_BUDGET_BYTES) {
    throw new Error("Publication feed exceeds its conservative rendering budget");
  }
}
