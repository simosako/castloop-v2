type HealthRequest = (url: URL, init: RequestInit) => Promise<Response>;
type Wait = (milliseconds: number) => Promise<void>;
type HealthWaitOptions = {
  now?: () => number;
  report?: (message: string) => void;
};

const HEALTH_TIMEOUT_MS = 120000;
const HEALTH_DELAY_MS = 5000;
const HEALTH_REQUEST_TIMEOUT_MS = 5000;

export async function waitForWorkerHealth(baseUrl: string, adminKey: string,
  request: HealthRequest = fetch,
  wait: Wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  options: HealthWaitOptions = {}): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const report = options.report ?? ((message: string) => console.error(message));
  const url = new URL("/admin/health", baseUrl);
  const deadline = now() + HEALTH_TIMEOUT_MS;
  let attempts = 0;
  let lastResult = "network request failed";
  while (now() < deadline) {
    attempts += 1;
    let status: number | null = null;
    try {
      status = (await request(url, {
        headers: { "X-Castloop-Key": adminKey, "User-Agent": "castloop-cli/0.1" },
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1,
          Math.ceil(Math.min(HEALTH_REQUEST_TIMEOUT_MS, deadline - now())))),
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
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const delay = Math.min(HEALTH_DELAY_MS, remaining);
    report(`Waiting for Worker health (${lastResult}, attempt ${attempts}); ` +
      `up to ${Math.ceil(remaining / 1000)}s remaining`);
    await wait(delay);
  }
  throw new Error(`Worker health unavailable after ${HEALTH_TIMEOUT_MS / 1000}s and ` +
    `${attempts} attempt${attempts === 1 ? "" : "s"} (${lastResult}); ` +
    "check public_base_url and Worker deployment, then rerun init in the same workspace");
}
