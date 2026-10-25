import { Database } from "bun:sqlite";
import { episodeRevisionSchema, showMetadataSchema } from "../packages/shared/src/index";
import { SqlitePublicationContent } from "../src/sqlite-publication-content";
import { sqlitePublicationFixture } from "../src/test-support/sqlite-publication";

const fixture = sqlitePublicationFixture();
new SqlitePublicationContent(fixture.storage);
const schema = fixture.database.query<{ sql: string }, []>(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN ('publication_show_revisions', 'publication_episode_revisions') ORDER BY name").all();
fixture.close();
const uuid = () => crypto.randomUUID();
const hash = "a".repeat(64), stamp = "2026-10-25T00:00:00Z", count = 1000;
const samples = [
  { label: "ascii-200", title: "A".repeat(30), description: "a".repeat(200) },
  { label: "ja-200", title: "題".repeat(30), description: "説".repeat(200) },
  { label: "ja-400", title: "題".repeat(30), description: "説".repeat(400) },
  { label: "episode-emoji-10000", title: "題".repeat(30), description: "😀".repeat(10000) },
];
const results = [];
for (const kind of ["show", "episode"] as const) for (const sample of samples) {
  if (kind === "show" && sample.label === "episode-emoji-10000") continue;
  const db = new Database(":memory:");
  for (const { sql } of schema) db.exec(sql);
  const bytes = () => Number(db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count) *
    Number(db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size);
  const before = bytes();
  let valueBytes = 0, jsonBytes = 0;
  db.transaction(() => {
    for (let index = 1; index <= count; index++) {
      const id = uuid();
      if (kind === "show") {
        const metadata = showMetadataSchema.parse({ schema_version: 1, show_id: "daily", title: sample.title,
          description: sample.description, language: "ja", author: "Author", owner_name: "Owner",
          owner_email: "owner@example.com", categories: ["Technology"], explicit: false,
          site_url: "https://example.com/podcast", image_path: "cover.jpg" });
        const json = JSON.stringify(metadata);
        const values = ["daily", index, index, id, json, hash, "jpg", index, hash, 4000, null, stamp];
        db.query("INSERT INTO publication_show_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...values);
        valueBytes += values.reduce<number>((sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value) : 0), 0);
        jsonBytes = Buffer.byteLength(json);
      } else {
        const revision = episodeRevisionSchema.parse({ schema_version: 1, episode_id: "first", guid: "stable-guid",
          title: sample.title, description: sample.description, published_at: stamp, revision_id: id,
          enclosure_url: `https://example.com/podcasts/daily/episodes/first/${id}.mp3`,
          content_type: "audio/mpeg", length_bytes: 1000000, duration_seconds: 60, sha256: hash, updated_at: stamp });
        const json = JSON.stringify(revision);
        const values = ["daily", "first", index, id, id, hash, json, null, stamp];
        db.query("INSERT INTO publication_episode_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...values);
        valueBytes += values.reduce<number>((sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value) : 0), 0);
        jsonBytes = Buffer.byteLength(json);
      }
    }
  })();
  results.push({ kind, sample: sample.label, rows: count, json_bytes: jsonBytes,
    text_value_bytes_per_row: valueBytes / count, database_growth_bytes_per_row: (bytes() - before) / count });
  db.close();
}
console.log(JSON.stringify({ sqlite: "local Bun SQLite, history tables and indexes only; not Cloudflare storage metering", results }, null, 2));
