import { z } from "zod";

export function normalizeHostname(value: string): string {
  const hostname = value.toLowerCase();
  const labels = hostname.split(".");
  if (hostname.length > 253 || labels.length < 2 || labels.some((label) =>
    label.length === 0 || label.length > 63 || !/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
    !/[a-z]/.test(labels.at(-1)!)) {
    throw new Error("Expected a DNS hostname without a URL scheme, path, or port");
  }
  return hostname;
}

export const hostnameSchema = z.string().refine((value) => {
  try { return normalizeHostname(value) === value; } catch { return false; }
}, "Expected a normalized DNS hostname");
