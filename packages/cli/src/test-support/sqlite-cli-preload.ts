export {};

const origin = process.env.CASTLOOP_TEST_LOOPBACK_ORIGIN;
if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Test preload requires its local fixture origin");
const transport = globalThis.fetch;
const redirected = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const request = new Request(input, init), url = new URL(request.url);
  if (!["api.cloudflare.com", "test-worker.example.workers.dev", "podcasts.example.com"].includes(url.hostname)) throw new Error("Test preload rejects external access");
  const headers = new Headers(request.headers); headers.set("X-Castloop-Test-Target", request.url);
  const options = { method: request.method, headers, redirect: "error" as const, signal: request.signal, decompress: false,
    ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }) };
  return transport(origin, options);
};
globalThis.fetch = Object.assign(redirected, { preconnect: transport.preconnect });
