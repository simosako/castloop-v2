import { Parser } from "htmlparser2";

const OMIT_CONTENT = new Set(["script", "style", "head", "title", "template", "noscript", "iframe", "object", "embed",
  "form", "input", "button", "select", "textarea", "svg", "math", "audio", "video", "canvas", "picture", "img",
  "source", "track", "link", "meta", "base", "frameset", "frame", "noembed", "noframes", "xmp", "plaintext"]);
const BLOCKS = new Set(["div", "ul", "ol", "li", "dl", "dt", "dd", "blockquote", "pre", "section", "article",
  "header", "footer", "main", "aside", "nav", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tr", "td", "th", "hr"]);
type Part = { kind: "text"; value: string; href?: string | null } | { kind: "paragraph" | "line" | "br" };

export function escapeSiteText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export type SiteDescription = { excerpt: string; html: string };

function safeLink(source: string): string | null {
  const value = source.trim();
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function linkedText(value: string, href?: string | null): string {
  const escape = (text: string) => escapeSiteText(text).replace(/\n/g, "<br>");
  const anchor = (url: string, text: string) => `<a href="${escapeSiteText(url)}">${escape(text)}</a>`;
  if (href !== undefined) return href ? anchor(href, value) : escape(value);
  let html = "", offset = 0;
  for (const match of value.matchAll(/https?:\/\/[^\s<>"'`。、！？「」『』（）【】〈〉《》]+/giu)) {
    let candidate = match[0].replace(/[.,!?;:]+$/u, "");
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      const extra = candidate.split(close).length - candidate.split(open).length;
      for (let count = 0; count < extra && candidate.endsWith(close); count++) candidate = candidate.slice(0, -1);
    }
    const url = safeLink(candidate);
    html += escape(value.slice(offset, match.index)) + (url ? anchor(url, candidate) : escape(candidate)) +
      escape(match[0].slice(candidate.length));
    offset = match.index + match[0].length;
  }
  return html + escape(value.slice(offset));
}

export function formatSiteDescription(source: string): SiteDescription {
  const parts: Part[] = [], text: string[] = [];
  let omitted = 0, markup = false;
  let href: string | null | undefined;
  const flush = () => {
    if (text.length) { parts.push({ kind: "text", value: text.join(""), href }); text.length = 0; }
  };
  const boundary = (kind: "paragraph" | "line" | "br") => { flush(); parts.push({ kind }); };
  new Parser({
    onopentag(name, attributes) {
      markup = true;
      if (omitted || OMIT_CONTENT.has(name)) { omitted++; return; }
      if (name === "a") { flush(); href = safeLink(attributes.href ?? ""); }
      else if (name === "p") boundary("paragraph");
      else if (name === "br") boundary("br");
      else if (BLOCKS.has(name)) boundary("line");
    },
    onclosetag(name) {
      if (omitted) { omitted--; return; }
      if (name === "a") { flush(); href = undefined; }
      else if (name === "p") boundary("paragraph");
      else if (BLOCKS.has(name)) boundary("line");
    },
    ontext(value) { if (!omitted) text.push(value); },
    onerror(error) { throw error; },
  }, { decodeEntities: true, xmlMode: false }).end(source);
  flush();

  const plain = parts.map((part) => part.kind === "text" ? part.value : " ").join("").replace(/\s+/gu, " ").trim();
  const characters = Array.from(plain);
  const excerpt = characters.length > 160 ? `${characters.slice(0, 160).join("")}…` : plain;
  const paragraphs: string[] = [];
  let paragraph = "", linePending = false;
  const closeParagraph = () => {
    if (paragraph.trim()) paragraphs.push(`<p>${paragraph.trim()}</p>`);
    paragraph = ""; linePending = false;
  };
  for (const part of parts) {
    if (part.kind === "paragraph") closeParagraph();
    else if (part.kind === "line") linePending = !!paragraph;
    else if (part.kind === "br") { paragraph += "<br>"; linePending = false; }
    else if (part.kind === "text") {
      const value = markup ? part.value.replace(/[\t\n\f\r ]+/g, " ") : part.value.replace(/\r\n?/g, "\n");
      if (linePending && value.trim()) {
        if (!paragraph.endsWith("<br>")) paragraph = paragraph.trimEnd() + "<br>";
        linePending = false;
      }
      paragraph += linkedText(value, part.href);
    }
  }
  closeParagraph();
  return { excerpt, html: paragraphs.join("") };
}
