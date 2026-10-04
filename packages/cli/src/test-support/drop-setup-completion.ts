import type { M6AdminTransport } from "../m6-admin-json";

export function dropSetupCompletion(transport: M6AdminTransport = fetch): M6AdminTransport {
  return async (url, init) => {
    const response = await transport(url, init);
    if (url.pathname === "/admin/setup/complete" && init.method === "POST" && response.status === 200) {
      await response.body?.cancel();
      throw new Error("Isolated test deliberately discarded the successful setup completion response");
    }
    return response;
  };
}
