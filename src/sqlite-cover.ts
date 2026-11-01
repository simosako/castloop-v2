export type SqliteCoverIdentity = { generation: number; sha256: string; lengthBytes: number };

export function validSqliteCoverIdentity(cover: SqliteCoverIdentity): boolean {
  return Number.isSafeInteger(cover.generation) && cover.generation > 0 &&
    /^[a-f0-9]{64}$/.test(cover.sha256) && Number.isSafeInteger(cover.lengthBytes) &&
    cover.lengthBytes > 0 && cover.lengthBytes <= 5_000_000;
}
