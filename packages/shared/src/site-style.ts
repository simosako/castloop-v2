export const SITE_CUSTOM_CSS_LIMIT_BYTES = 65_536;

export function validateSiteCss(css: string): string {
  if (new TextEncoder().encode(css).byteLength > SITE_CUSTOM_CSS_LIMIT_BYTES ||
    /[\u0000\r]/.test(css) || /<\/style/i.test(css) || /[\uD800-\uDFFF]/u.test(css)) {
    throw new Error("Site CSS must be valid normalized text, at most 64 KiB, without a style closing tag");
  }
  return css;
}
