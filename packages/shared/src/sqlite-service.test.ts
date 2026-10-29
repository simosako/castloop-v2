import { expect, test } from "bun:test";
import { stringify as stringifyToml } from "@iarna/toml";
import { parseSqliteServiceConfig, sqliteServiceConfigHash, sqliteServiceConfigSchema } from "./sqlite-service";

const config = { schema_version: 2 as const, storage_layout: "show-v1" as const, publication_protocol: "sqlite-sequential-v1" as const,
  service_id: "service", account_id: "a".repeat(32), bucket_name: "private-bucket", worker_name: "castloop-service",
  public_base_url: "https://podcasts.example.com", workers_dev_base_url: "https://castloop-service.example.workers.dev" };

test("SQLite service config does not require or adopt Queue settings", () => {
  expect(sqliteServiceConfigSchema.parse(config)).toEqual(config);
  expect(parseSqliteServiceConfig(stringifyToml(config))).toEqual(config);
  for (const change of [{ schema_version: 1 }, { publication_protocol: "queue-management-v1" },
    { queue_name: "legacy-queue" }, { dlq_name: "legacy-dlq" }, { api_token: "secret" }]) {
    expect(sqliteServiceConfigSchema.safeParse({ ...config, ...change }).success).toBe(false);
  }
  const source = stringifyToml({ schema_version: 1, service_id: "service", account_id: "a".repeat(32),
    bucket_name: "private-bucket", worker_name: "castloop-service", queue_name: "legacy-queue", dlq_name: "legacy-dlq",
    public_base_url: config.public_base_url });
  expect(() => parseSqliteServiceConfig(source)).toThrow();
});

test("SQLite administration has an exact HTTPS workers.dev origin", () => {
  expect(sqliteServiceConfigSchema.parse({ ...config, workers_dev_base_url: `${config.workers_dev_base_url}/`,
    public_base_url: `${config.public_base_url}/` })).toEqual(config);
  for (const field of ["public_base_url", "workers_dev_base_url"]) {
    for (const value of ["http://example.com", "https://user:secret@example.com", "https://example.com/path",
      "https://example.com?x=1", "https://example.com#fragment", "https://example.com:8080"]) {
      expect(sqliteServiceConfigSchema.safeParse({ ...config, [field]: value }).success).toBe(false);
    }
  }
  for (const workers_dev_base_url of ["https://other.example.workers.dev", "https://castloop-service.example.com",
    "https://castloop-service.a.b.workers.dev"]) {
    expect(sqliteServiceConfigSchema.safeParse({ ...config, workers_dev_base_url }).success).toBe(false);
  }
});

test("config hashes bind the complete canonical new config", async () => {
  expect(await sqliteServiceConfigHash(config)).toBe(await sqliteServiceConfigHash(
    Object.fromEntries(Object.entries(config).reverse()) as typeof config));
  expect(await sqliteServiceConfigHash(config)).not.toBe(await sqliteServiceConfigHash({ ...config, bucket_name: "another-bucket" }));
});
