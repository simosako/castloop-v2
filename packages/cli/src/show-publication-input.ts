import { parseShowMetadata, stringifyToml } from "@castloop/shared";
import { SITE_CUSTOM_CSS_LIMIT_BYTES, validateSiteCss } from "../../shared/src/site-style";
import { readLocalMetadata } from "./local-metadata-read";
import { decodeUtf8Strict } from "./utf8";
import { dirname, join } from "node:path";

export async function readShowPublicationInput(path: string): Promise<Buffer> {
  const bytes = await readLocalMetadata(path);
  const show = parseShowMetadata(decodeUtf8Strict(bytes));
  if (show.site_css !== undefined) throw new Error("Local Show TOML must use site_css_path, not inline site_css");
  if (show.site_css_path === undefined) return bytes;
  const css = await readLocalMetadata(join(dirname(path), show.site_css_path), SITE_CUSTOM_CSS_LIMIT_BYTES, 0);
  const siteCss = validateSiteCss(decodeUtf8Strict(css).replace(/\r\n?/g, "\n"));
  const result = Buffer.from(stringifyToml({ ...show, site_css: siteCss }));
  if (result.length > 1_000_000) throw new Error("Show metadata with CSS exceeds its upload budget");
  return result;
}
