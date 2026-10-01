export function authenticated(request: Request, secret: string): boolean {
  const received = new TextEncoder().encode(request.headers.get("X-Castloop-Key") ?? "");
  const expected = new TextEncoder().encode(secret);
  let difference = received.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ (received[index] ?? 0);
  }
  return expected.length > 0 && difference === 0;
}
