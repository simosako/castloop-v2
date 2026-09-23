export function validateId(value: unknown, kind: "service" | "show" | "episode"): string {
  const max = { service: 20, show: 32, episode: 80 }[kind];
  if (typeof value !== "string" || value.length > max ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`Invalid ${kind} ID: use a lowercase slug of at most ${max} characters`);
  }
  return value;
}
