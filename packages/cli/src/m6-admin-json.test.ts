import { expect, test } from "bun:test";
import { parseServiceConfig } from "@castloop/shared";
import { M6AdminJsonClient } from "./m6-admin-json";
import { PUBLICATION_SERVICE_TEXT } from "../../../src/test-support/publication";

test("all management request forms use workers.dev while retaining the Podcast's canonical URL", async () => {
  const config = parseServiceConfig(PUBLICATION_SERVICE_TEXT);
  const calls: string[] = [];
  const client = new M6AdminJsonClient(config, "private-secret", async (url, init) => {
    expect(url.origin).toBe(config.workers_dev_base_url!);
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(new Headers(init.headers).get("X-Castloop-Key")).toBe("private-secret");
    calls.push(`${init.method} ${url.pathname}`);
    return Response.json({ result: "checked" }, { headers: { "Cache-Control": "no-store" } });
  });
  await client.post("catalog", { service_id: config.service_id });
  await client.getRuntimeHealth();
  await client.getSetupProbe(crypto.randomUUID());
  expect(calls).toEqual(["POST /admin/catalog", "GET /admin/health", "GET /admin/setup/probe"]);
  expect(client.config).toEqual(config);
  expect(client.config.public_base_url).toBe("https://current.example");
});

test("management failures never retry against the custom domain or follow a redirect", async () => {
  const config = parseServiceConfig(PUBLICATION_SERVICE_TEXT);
  for (const failure of ["network", "redirect"]) {
    const urls: string[] = [];
    const client = new M6AdminJsonClient(config, "private-secret", async (url, init) => {
      urls.push(url.origin);
      expect(init.redirect).toBe("error");
      if (failure === "network") throw new Error("Unreachable workers.dev");
      return new Response(null, { status: 302, headers: { Location: config.public_base_url } });
    });
    await expect(client.getRuntimeHealth()).rejects.toThrow(failure === "network" ? "outcome is unknown" : "not verified");
    expect(urls).toEqual([config.workers_dev_base_url!]);
  }
});
