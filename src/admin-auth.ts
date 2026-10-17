export async function authenticated(request: Request, secret: string): Promise<boolean> {
  if (!secret) return false;
  const encoder = new TextEncoder();
  try {
    const [received, expected] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("X-Castloop-Key") ?? "")),
      crypto.subtle.digest("SHA-256", encoder.encode(secret)),
    ]);
    if (typeof crypto.subtle.timingSafeEqual === "function") {
      return crypto.subtle.timingSafeEqual(received, expected);
    }
    // Standard Web Crypto runtimes lack the Workers comparison extension.
    const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
    if (!("type" in key)) throw new Error("Expected a symmetric comparison key");
    const signature = await crypto.subtle.sign("HMAC", key, expected);
    return await crypto.subtle.verify("HMAC", key, signature, received);
  } catch {
    console.error(JSON.stringify({ event: "admin_authentication_failed", reason_code: "crypto_unavailable" }));
    return false;
  }
}
