type HealthRequest = (url: URL, init: RequestInit) => Promise<Response>;
type Wait = (milliseconds: number) => Promise<void>;

const HEALTH_ATTEMPTS = 6;
const HEALTH_DELAY_MS = 2000;

export async function waitForWorkerHealth(baseUrl: string, adminKey: string,
  request: HealthRequest = fetch,
  wait: Wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))): Promise<void> {
  const url = new URL("/admin/health", baseUrl);
  let lastResult = "network request failed";
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
    let status: number | null = null;
    try {
      status = (await request(url, {
        headers: { "X-Castloop-Key": adminKey, "User-Agent": "castloop-cli/0.1" },
        signal: AbortSignal.timeout(5000),
      })).status;
    } catch {
      lastResult = "network request failed";
    }
    if (status === 200) return;
    if (status !== null) {
      if (status !== 404 && status !== 429 && status < 500) {
        throw new Error(`Worker URL or administrator key is incorrect (HTTP ${status})`);
      }
      lastResult = `HTTP ${status}`;
    }
    if (attempt < HEALTH_ATTEMPTS) await wait(HEALTH_DELAY_MS);
  }
  throw new Error(`Worker health unavailable after ${HEALTH_ATTEMPTS} attempts (${lastResult}); ` +
    "check public_base_url and Worker deployment, then rerun init in the same workspace");
}
