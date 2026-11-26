/**
 * Pure guards for editing CMS rich text (unit-tested). Links and data-attribute spans (custom
 * writer marks whose inner text is a render-time placeholder, template variables…) must survive
 * an edit byte-for-byte; only the prose between them may change.
 */
import type { CmsTextKind } from "../integrations/types";

/** Whole `<span data-…>…</span>` placeholders and `<a …>` opening tags — never edited. */
const PROTECTED_RE = /<span\b[^>]*\sdata-[\w-]+[^>]*>[^<]*<\/span>|<a\b[^>]*>/gi;
const TAG_RE = /<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi;

const INLINE_TAGS = new Set(["b", "strong", "i", "em", "u", "s", "del", "code", "sub", "sup", "a", "span", "br", "mark"]);
const BLOCK_TAGS = new Set(["p", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote"]);

function protectedParts(html: string): string[] {
  return (html.match(PROTECTED_RE) ?? []).sort();
}

/** Returns an error message when `after` can't replace `before` for a field of this kind, else null. */
export function validateRichText(kind: CmsTextKind, before: string, after: string): string | null {
  if (!after.trim()) return "The text can't be empty — removing content isn't supported.";
  if (/<script|<style|<iframe|javascript:/i.test(after)) return "Scripts, styles and iframes aren't allowed.";
  if (kind === "plain" || kind === "multiline") {
    if (kind === "plain" && /\n/.test(after)) return "This field is a single line.";
    if (/<[a-z/][^>]*>/i.test(after) && !/<[a-z/][^>]*>/i.test(before)) return "This field holds plain text — remove the HTML tags.";
    return null;
  }
  for (const m of after.matchAll(TAG_RE)) {
    const tag = m[1]!.toLowerCase();
    const allowed = INLINE_TAGS.has(tag) || (kind === "html" && BLOCK_TAGS.has(tag));
    if (!allowed) return kind === "inline-html" && BLOCK_TAGS.has(tag) ? `This is an inline text field — <${tag}> isn't allowed.` : `<${tag}> isn't allowed in this field.`;
    if (tag !== "a" && tag !== "span" && m[0]!.startsWith("<") && !m[0]!.startsWith("</") && m[2]!.trim()) return `<${tag}> must not have attributes.`;
  }
  const want = protectedParts(before);
  const got = protectedParts(after);
  if (want.join("\u0000") !== got.join("\u0000")) {
    const missing = want.filter((p) => !got.includes(p));
    const added = got.filter((p) => !want.includes(p));
    return `Links and placeholders must stay exactly as they are${missing.length ? ` (missing: ${missing[0]!.slice(0, 80)})` : added.length ? ` (new: ${added[0]!.slice(0, 80)})` : ""}.`;
  }
  // Unwrapped spans (no data-*) would be stripped by most CMS sanitizers anyway — keep counts balanced.
  const open = (after.match(/<a\b/gi) ?? []).length;
  const close = (after.match(/<\/a>/gi) ?? []).length;
  if (open !== close) return "Every link needs its closing </a>.";
  return null;
}

/**
 * Replaces protected parts by ⟦n⟧ tokens before text goes to an LLM, so it can't damage them.
 * `restore` puts them back and fails when a token was lost or duplicated.
 */
export function protect(html: string): { text: string; tokens: string[] } {
  const tokens: string[] = [];
  const text = html.replace(PROTECTED_RE, (m) => {
    tokens.push(m);
    return `⟦${tokens.length}⟧`;
  });
  return { text, tokens };
}

export function restore(text: string, tokens: string[]): string {
  for (let i = 1; i <= tokens.length; i++) {
    const n = text.split(`⟦${i}⟧`).length - 1;
    if (n !== 1) throw new Error(n ? `Placeholder ⟦${i}⟧ appears ${n} times.` : `Placeholder ⟦${i}⟧ was removed.`);
  }
  if (/⟦\d+⟧/.test(text.replace(/⟦(\d+)⟧/g, (m, d: string) => (Number(d) <= tokens.length ? "" : m)))) throw new Error("Unknown placeholder in the text.");
  return text.replace(/⟦(\d+)⟧/g, (_, d: string) => tokens[Number(d) - 1]!);
}
