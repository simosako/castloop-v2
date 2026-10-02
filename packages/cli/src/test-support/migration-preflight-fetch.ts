import { bridgeDeploymentFixture } from "./migration-bridge";

const setup = bridgeDeploymentFixture();
const versionId = "5a2601ec-9d1a-497e-90f8-fdb1d2096cfd";
const scenario = process.env.CASTLOOP_TEST_PREFLIGHT;
const settings = { ...setup.settings, compatibility_flags: [], cache_options: { enabled: true, cross_version_cache: false } };
const version = { id: versionId, metadata: setup.version.metadata, resources: { bindings: settings.bindings,
  script: { handlers: ["fetch", "queue"] }, script_runtime: { compatibility_date: "2026-09-30", cache_options: settings.cache_options } } };
const deployments = { deployments: [{ id: "8953d041-6139-4ca7-a3c9-6233163f33d5", strategy: "percentage",
  versions: [{ version_id: versionId, percentage: 100 }] }] };
const base = `/client/v4/accounts/${setup.config.account_id}`;
const worker = `${base}/workers/scripts/${setup.config.worker_name}`;
const paths: string[] = [];
let scriptReads = 0;
let settingsReads = 0;

globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  paths.push(`${request.method} ${url.pathname}${url.search}`);
  if (request.method !== "GET" || url.origin !== "https://api.cloudflare.com" || init?.redirect !== "error" ||
    request.headers.get("Authorization") !== "Bearer fake-preflight-token" || request.headers.has("X-Castloop-Key")) {
    throw new Error("Unexpected preflight request");
  }
  let result: unknown;
  if (url.pathname === `${worker}/deployments` && !url.search) result = deployments;
  else if (url.pathname === `${worker}/versions/${versionId}` && !url.search) result = version;
  else if (url.pathname === `${worker}/settings` && !url.search) {
    settingsReads += 1;
    result = { ...settings, ...(scenario === "settings-drift" && settingsReads === 2 ? { tags: ["changed"] } : {}) };
  } else if (url.pathname === `${worker}/subdomain` && !url.search) result = { enabled: true, previews_enabled: false };
  else if (url.pathname === `${base}/workers/domains` && url.search === "?service=probe-worker") result = [];
  else if (url.pathname === worker && !url.search) {
    scriptReads += 1;
    const form = new FormData();
    const changed = scenario === "script-drift" && scriptReads === 2;
    form.append("index.js", `export default {fetch(){return new Response("private-source-${changed ? "changed" : "original"}")},queue(){}};` +
      (scenario === "named-export" ? "export const UnknownEntrypoint = {};" : ""));
    return new Response(form);
  } else throw new Error("Unexpected preflight API path");
  return Response.json({ success: true, result });
}, { preconnect: () => {} });

process.on("exit", () => console.error(`PREFLIGHT_TEST_REQUESTS ${JSON.stringify(paths)}`));
