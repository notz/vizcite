/**
 * Pure helpers for Kirby site edits (unit-tested): walks the field schema Kirby returns for a page
 * (`GET /api/pages/:id/sections/:name` → resolved field props, recursive for blocks / layout /
 * structure / object) together with the page's form values, and yields every human-readable text
 * value with a stable path. Only schema-declared text fields are editable — never selects, links,
 * patterns, references or system keys.
 */
import type { CmsTextKind, CmsTextValue } from "../integrations/types";

export type KirbyFieldProps = {
  name?: string;
  type?: string;
  label?: unknown;
  translate?: boolean;
  disabled?: boolean;
  pattern?: string | null;
  inline?: boolean;
  /** blocks / layout: fieldsets by type (each with tabs → fields) */
  fieldsets?: Record<string, KirbyFieldset> | unknown;
  /** structure / object: sub-fields by name */
  fields?: Record<string, KirbyFieldProps> | unknown;
};

export type KirbyFieldset = { type?: string; name?: unknown; tabs?: Record<string, { fields?: Record<string, KirbyFieldProps> }> | unknown };

export type CollectOptions = {
  /** false for non-default languages: `translate: false` fields are read-only there. */
  isDefaultLanguage: boolean;
  /** Lower-case field names never to edit (site-specific key-like text fields). */
  exclude?: Set<string>;
  /** Top-level field names that hold no translation yet (non-default language) → read-only. */
  untranslated?: Set<string>;
};

const TEXT_KINDS: Record<string, (p: KirbyFieldProps) => CmsTextKind> = {
  text: () => "plain",
  textarea: () => "multiline",
  markdown: () => "multiline",
  list: () => "html",
  writer: (p) => (p.inline ? "inline-html" : "html"),
  "seo-writer": () => "inline-html",
};

/** Kirby system keys inside blocks / layouts / structures — never text. */
const SYSTEM_KEYS = new Set(["id", "type", "isHidden", "_id", "attrs", "width", "uuid"]);

/** URLs, Kirby permalinks and model references aren't prose. */
export function looksLikeReference(v: string): boolean {
  const t = v.trim();
  return /^(https?:|mailto:|tel:|\/\/|\/@\/)/i.test(t) || /^-?\s*(page|file|user|site):\/\//i.test(t) || /^#[\w-]*$/.test(t);
}

export function labelOf(label: unknown, fallback: string): string {
  if (typeof label === "string" && label.trim()) return label.trim();
  if (label && typeof label === "object") {
    const first = Object.values(label as Record<string, unknown>).find((v) => typeof v === "string" && v.trim());
    if (typeof first === "string") return first.trim();
  }
  return fallback;
}

/** Nested blocks / structures may be stored as JSON strings (or real arrays) — accept both. */
function decode(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t.startsWith("[") && !t.startsWith("{")) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function fieldsetFields(fs: KirbyFieldset | undefined): Record<string, KirbyFieldProps> {
  const out: Record<string, KirbyFieldProps> = {};
  // Tabs come as a keyed object or an array, depending on the blueprint.
  const tabs = Array.isArray(fs?.tabs) ? (fs.tabs as unknown[]) : Object.values(asRecord(fs?.tabs) ?? {});
  for (const tab of tabs) Object.assign(out, asRecord(asRecord(tab)?.fields) ?? {});
  return out;
}

type Walk = { path: string; trail: string[]; locked: string | null; group: string };

/** Every text value of the given top-level fields (schema) and content (form values). */
export function collectTexts(fields: Record<string, KirbyFieldProps>, content: Record<string, unknown>, opts: CollectOptions): CmsTextValue[] {
  const out: CmsTextValue[] = [];
  const exclude = opts.exclude ?? new Set<string>();

  const lockOf = (p: KirbyFieldProps, inherited: string | null): string | null => {
    if (inherited) return inherited;
    if (p.disabled) return "Disabled in the blueprint.";
    if (p.translate === false && !opts.isDefaultLanguage) return "Not translatable — edit it in the default language.";
    return null;
  };

  const walk = (p: KirbyFieldProps, name: string, raw: unknown, w: Walk) => {
    if (exclude.has(name.toLowerCase())) return;
    const type = String(p.type ?? "");
    const label = labelOf(p.label, name);
    const locked = lockOf(p, w.locked);
    const kindOf = TEXT_KINDS[type];
    if (kindOf) {
      // Fixed-format values (pattern) and links/references aren't prose — not listed at all.
      if (typeof raw !== "string" || !raw.trim() || p.pattern || looksLikeReference(raw)) return;
      const reason = locked;
      out.push({ path: w.path, label: [...w.trail, label].join(" › "), group: w.group, kind: kindOf(p), value: raw, editable: !reason, ...(reason ? { reason } : {}) });
      return;
    }
    const value = decode(raw);
    if (type === "blocks") walkBlocks(p, value, { ...w, locked, trail: [...w.trail, label] });
    else if (type === "layout") {
      if (!Array.isArray(value)) return;
      for (const row of value) {
        const r = asRecord(row);
        for (const col of Array.isArray(r?.columns) ? r.columns : []) {
          const c = asRecord(col);
          if (!r?.id || !c?.id) continue;
          walkBlocks(p, c.blocks, { ...w, locked, path: `${w.path}/#${r.id}/#${c.id}`, trail: [...w.trail, label] });
        }
      }
    } else if (type === "structure") {
      if (!Array.isArray(value)) return;
      const sub = asRecord(p.fields) as Record<string, KirbyFieldProps> | null;
      value.forEach((row, i) => {
        const r = asRecord(row);
        if (!r || !sub) return;
        for (const [k, fp] of Object.entries(sub)) walk(fp, k, r[k] ?? r[k.toLowerCase()], { ...w, locked, path: `${w.path}/[${i}]/${k}`, trail: [...w.trail, `${label} ${i + 1}`] });
      });
    } else if (type === "object") {
      const r = asRecord(value);
      const sub = asRecord(p.fields) as Record<string, KirbyFieldProps> | null;
      if (!r || !sub) return;
      for (const [k, fp] of Object.entries(sub)) walk(fp, k, r[k] ?? r[k.toLowerCase()], { ...w, locked, path: `${w.path}/${k}`, trail: [...w.trail, label] });
    }
  };

  const walkBlocks = (p: KirbyFieldProps, raw: unknown, w: Walk) => {
    const blocks = decode(raw);
    if (!Array.isArray(blocks)) return;
    const sets = (asRecord(p.fieldsets) ?? {}) as Record<string, KirbyFieldset>;
    for (const b of blocks) {
      const block = asRecord(b);
      const type = typeof block?.type === "string" ? block.type : null;
      const c = asRecord(block?.content);
      if (!block?.id || !type || !c) continue;
      const fs = sets[type];
      const blockLabel = `${labelOf(fs?.name, type)}${block.isHidden ? " (hidden)" : ""}`;
      for (const [k, fp] of Object.entries(fieldsetFields(fs))) {
        if (SYSTEM_KEYS.has(k)) continue;
        walk(fp, k, c[k] ?? c[k.toLowerCase()], { ...w, path: `${w.path}/#${block.id}/${k}`, trail: [...w.trail, blockLabel] });
      }
    }
  };

  for (const [name, p] of Object.entries(fields)) {
    if (SYSTEM_KEYS.has(name)) continue;
    const top = name.toLowerCase();
    const untranslated = opts.untranslated?.has(top) ? "Not translated in this language yet — translate it in the Kirby Panel first." : null;
    walk(p, name, content[top] ?? content[name], { path: name, trail: [], locked: untranslated, group: labelOf(p.label, name) });
  }
  return out;
}

/* ───────────────────────────── Paths ───────────────────────────── */

/** Top-level field of a path (`body/#a1/text` → `body`). */
export function pathField(path: string): string {
  return path.split("/")[0]!;
}

function child(node: unknown, seg: string): { get: () => unknown; set: (v: unknown) => unknown } | null {
  const id = seg.startsWith("#") ? seg.slice(1) : null;
  const idx = /^\[(\d+)\]$/.exec(seg)?.[1];
  if (id !== null) {
    // An id addresses an array item, a layout row's column or a column's block.
    const rec = asRecord(node);
    const key = Array.isArray(node) ? null : Array.isArray(rec?.columns) ? "columns" : Array.isArray(rec?.blocks) ? "blocks" : null;
    const list = key ? (decode(rec![key]) as unknown[]) : (node as unknown[]);
    if (!Array.isArray(list)) return null;
    const i = list.findIndex((x) => asRecord(x)?.id === id);
    if (i < 0) return null;
    return {
      get: () => list[i],
      set: (v) => {
        const next = list.map((x, j) => (j === i ? v : x));
        return key ? { ...rec!, [key]: next } : next;
      },
    };
  }
  if (idx !== undefined) {
    if (!Array.isArray(node)) return null;
    const i = Number(idx);
    if (i >= node.length) return null;
    return { get: () => node[i], set: (v) => node.map((x, j) => (j === i ? v : x)) };
  }
  const rec = asRecord(node);
  if (!rec) return null;
  // Block fields live in `content`.
  const holder = asRecord(rec.content) && typeof rec.type === "string" ? asRecord(rec.content)! : rec;
  const key = seg in holder ? seg : seg.toLowerCase() in holder ? seg.toLowerCase() : null;
  if (!key) return null;
  return {
    get: () => holder[key],
    set: (v) => (holder === rec ? { ...rec, [key]: v } : { ...rec, content: { ...holder, [key]: v } }),
  };
}

/** Reads the string at `path` below a top-level field value (path without the field name). */
export function getAtPath(fieldValue: unknown, segments: string[]): unknown {
  let node: unknown = fieldValue;
  for (const seg of segments) {
    const c = child(decode(node), seg);
    if (!c) return undefined;
    node = c.get();
  }
  return node;
}

/**
 * Returns a copy of the top-level field value with the string at `segments` replaced. Every other
 * key, id and order stays as it was; values stored as JSON strings are written back as strings.
 * Throws when the path doesn't exist (anymore).
 */
export function setAtPath(fieldValue: unknown, segments: string[], value: string): unknown {
  if (!segments.length) return value;
  const decoded = decode(fieldValue);
  const c = child(decoded, segments[0]!);
  if (!c) throw new Error(`The content at "${segments[0]}" no longer exists on the page.`);
  const next = c.set(setAtPath(c.get(), segments.slice(1), value));
  return typeof fieldValue === "string" && decoded !== fieldValue ? JSON.stringify(next) : next;
}

/* ───────────────────────────── Languages ───────────────────────────── */

/** `en:blog/post` → { language: "en", id: "blog/post" }. Single-language sites use bare ids. */
export function parseKirbyId(externalId: string, languages: string[]): { language: string | null; id: string } {
  if (!languages.length) {
    if (/^[a-z]{2,3}(?:[-_][a-z0-9]+)?:/i.test(externalId)) throw new Error("This Kirby site has a single language — use the page id without a language prefix.");
    return { language: null, id: externalId };
  }
  const m = /^([a-z]{2,3}(?:[-_][a-z0-9]+)?):(.+)$/i.exec(externalId);
  if (!m || !languages.includes(m[1]!)) throw new Error(`Multi-language Kirby site: the item id needs a language prefix (${languages.map((l) => `${l}:`).join(", ")}).`);
  return { language: m[1]!, id: m[2]! };
}

export function kirbyExternalId(language: string | null, id: string): string {
  return language ? `${language}:${id}` : id;
}

/**
 * Top-level fields of a non-default language that only show the default-language fallback (Kirby
 * merges untranslated fields from the default language when reading).
 */
export function untranslatedFields(content: Record<string, unknown>, defaults: Record<string, unknown>, translatable: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(content)) {
    if (!translatable.has(k.toLowerCase())) continue;
    const d = defaults[k];
    if (v === "" || v === null || v === undefined) continue;
    if (JSON.stringify(v) === JSON.stringify(d)) out.add(k.toLowerCase());
  }
  return out;
}
