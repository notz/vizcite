import "server-only";
import { HttpError, fetchJson } from "../../net";
import type { CmsClient, CmsEditField, CmsImage, CmsItem, CmsItemPatch, CmsTextValue } from "../types";
import {
  collectTexts,
  getAtPath,
  kirbyExternalId,
  parseKirbyId,
  pathField,
  setAtPath,
  untranslatedFields,
  type KirbyFieldProps,
} from "../../cms-edits/kirby-schema";
import { normalizeSiteUrl, requireField, type Creds } from "./common";

/**
 * Kirby CMS (Kirby 5 REST API, Basic auth) — site edits only. Language safety: every call passes
 * `?language=` from the item id (`<lang>:<pageId>`); without it Kirby would write the current
 * (default) language. Non-default languages read the default content too, because Kirby fills
 * untranslated fields with the default-language text — those are shown read-only.
 */

type KPage = { id: string; title?: string; url?: string; status?: string; content?: Record<string, unknown>; blueprint?: KBlueprint };
type KSection = { type?: string; name?: string };
/** Kirby returns tabs, columns and sections as arrays or as keyed objects (e.g. `main-col-0`). */
type KList<T> = T[] | Record<string, T>;
type KBlueprint = { tabs?: KList<{ columns?: KList<{ sections?: KList<KSection> }> }> };

const entries = <T>(v: KList<T> | null | undefined): [string, T][] =>
  !v || typeof v !== "object" ? [] : Array.isArray(v) ? v.map((x, i) => [String(i), x]) : Object.entries(v);
type KFile = { filename: string; type?: string; url?: string; content?: Record<string, unknown> };
type KLanguage = { code: string; default?: boolean };

const SITE_ID = "$site";
const SEO_TITLE_RE = /^(meta|seo)[-_]?title$/i;
const SEO_DESC_RE = /^(meta|seo)[-_]?desc(ription)?$/i;
const LOCK_NOTE = "The page has unsaved changes in the Kirby Panel (content lock) — save or discard them in the Panel, then try again.";

function altText(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string") return (v as { text: string }).text;
  return null;
}

export function createKirbyClient(creds: Creds): CmsClient {
  const site = normalizeSiteUrl(requireField(creds, "siteUrl", "Site URL"), true);
  const auth = `Basic ${Buffer.from(`${requireField(creds, "email", "Email")}:${requireField(creds, "password", "Password")}`).toString("base64")}`;
  const exclude = new Set(
    (creds.excludeFields ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  let langs: KLanguage[] | null = null;
  const languages = async (): Promise<KLanguage[]> => {
    if (langs) return langs;
    const configured = (creds.languages ?? "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const res = await fetchJson<{ data?: KLanguage[] }>(`${site}/api/languages`, { headers: { authorization: auth } });
      langs = (res.data ?? []).map((l) => ({ code: l.code, default: !!l.default }));
    } catch (err) {
      if (!(err instanceof HttpError) || (err.status !== 403 && err.status !== 401) || !configured.length) {
        if (err instanceof HttpError && err.status === 403)
          throw new Error("The Kirby user can't read the site's languages — give it access to languages or enter the language codes in the integration settings.");
        throw err;
      }
      langs = configured.map((code, i) => ({ code, default: i === 0 }));
    }
    return langs;
  };
  const codes = async () => (await languages()).map((l) => l.code);
  const defaultLang = async () => (await languages()).find((l) => l.default)?.code ?? null;

  /** The only way to call Kirby: on multi-language sites a language is mandatory. */
  const kapi = async <T>(path: string, language: string | null, init: { method?: string; json?: unknown; query?: Record<string, string> } = {}): Promise<T> => {
    const qs = new URLSearchParams(init.query ?? {});
    if ((await codes()).length) {
      if (!language) throw new Error("Refusing to call Kirby without a language on a multi-language site.");
      qs.set("language", language);
    }
    try {
      return await fetchJson<T>(`${site}/api/${path}${qs.size ? `?${qs}` : ""}`, {
        method: init.method,
        json: init.json,
        headers: { authorization: auth },
        maxBytes: 16 * 1024 * 1024,
      });
    } catch (err) {
      if (err instanceof HttpError && /lock/i.test(err.message)) throw new Error(LOCK_NOTE);
      throw err;
    }
  };

  const base = (id: string) => (id === SITE_ID ? "site" : `pages/${id.split("/").map(encodeURIComponent).join("+")}`);

  const loadPage = async (id: string, language: string | null): Promise<KPage> => {
    const select = id === SITE_ID ? "title,url,content,blueprint" : "id,title,url,status,content,blueprint";
    const res = await kapi<{ data: KPage }>(base(id), language, { query: { select } });
    return { ...res.data, id };
  };

  /** Resolved field props of all `fields` sections (blocks fieldsets etc. included). */
  const loadSchema = async (id: string, language: string | null, bp: KBlueprint | undefined): Promise<Record<string, KirbyFieldProps>> => {
    const names = entries(bp?.tabs).flatMap(([, t]) =>
      entries(t?.columns).flatMap(([, c]) =>
        entries(c?.sections)
          .filter(([, sec]) => sec?.type === "fields")
          .map(([n, sec]) => sec.name ?? n),
      ),
    );
    const out: Record<string, KirbyFieldProps> = {};
    for (const n of [...new Set(names)]) {
      const sec = await kapi<{ fields?: Record<string, KirbyFieldProps> }>(`${base(id)}/sections/${encodeURIComponent(n)}`, language);
      Object.assign(out, sec.fields ?? {});
    }
    return out;
  };

  const loadFiles = async (id: string, language: string | null): Promise<KFile[]> => {
    if (id === SITE_ID) return [];
    const res = await kapi<{ data?: KFile[] }>(`${base(id)}/files`, language, { query: { select: "filename,type,url,content", limit: "100" } });
    return (res.data ?? []).filter((f) => f.type === "image" && f.content && "alt" in f.content);
  };

  const seoKeys = (schema: Record<string, KirbyFieldProps>) => {
    const keys = Object.keys(schema);
    return { title: keys.find((k) => SEO_TITLE_RE.test(k)) ?? null, description: keys.find((k) => SEO_DESC_RE.test(k)) ?? null };
  };

  const getItem = async (externalId: string): Promise<CmsItem> => {
    const all = await languages();
    const { language, id } = parseKirbyId(externalId, all.map((l) => l.code));
    const def = await defaultLang();
    const isDefault = !language || language === def;
    const page = await loadPage(id, language);
    const [schema, files, defPage, defFiles] = await Promise.all([
      loadSchema(id, language, page.blueprint),
      loadFiles(id, language),
      isDefault ? null : loadPage(id, def),
      isDefault ? [] : loadFiles(id, def),
    ]);
    const content = page.content ?? {};
    const translatable = new Set(Object.entries(schema).filter(([, p]) => p.translate !== false).map(([k]) => k.toLowerCase()));
    const untranslated = defPage ? untranslatedFields(content, defPage.content ?? {}, translatable) : new Set<string>();
    const titleUntranslated = !!defPage && page.title === defPage.title;
    const filled = [...translatable].filter((k) => content[k] !== "" && content[k] != null);
    const noTranslation = !!defPage && titleUntranslated && filled.every((k) => untranslated.has(k));
    if (noTranslation) for (const k of translatable) untranslated.add(k);

    const seo = seoKeys(schema);
    const seoFields = new Set([seo.title, seo.description].filter((k): k is string => !!k).map((k) => k.toLowerCase()));
    const texts = collectTexts(
      Object.fromEntries(Object.entries(schema).filter(([k]) => !seoFields.has(k.toLowerCase()))),
      content,
      { isDefaultLanguage: isDefault, exclude, untranslated },
    );
    const lock = (k: string | null) => !k || untranslated.has(k.toLowerCase());
    const str = (k: string | null) => (k && typeof content[k.toLowerCase()] === "string" ? (content[k.toLowerCase()] as string) : null);

    const fields: CmsItem["fields"] = { title: page.title ?? "" };
    const editable: CmsEditField[] = [];
    const notes: string[] = [];
    if (!titleUntranslated && !noTranslation) editable.push("title");
    if (id !== SITE_ID) {
      fields.slug = id.split("/").pop() ?? "";
      if (!noTranslation) editable.push("slug");
    }
    if (seo.title) {
      fields.meta_title = str(seo.title) ?? "";
      if (!lock(seo.title)) editable.push("meta_title");
    }
    if (seo.description) {
      fields.meta_description = str(seo.description) ?? "";
      if (!lock(seo.description)) editable.push("meta_description");
    }
    if (!seo.title && !seo.description) notes.push("No SEO title / meta description field found in this page's blueprint (expected e.g. metaTitle / metaDescription).");
    if (texts.some((t) => t.editable)) editable.push("content_text");

    const defAlt = new Map(defFiles.map((f) => [f.filename, altText(f.content?.alt)]));
    const images: CmsImage[] = files.map((f) => ({ id: f.filename, src: f.url ?? null, alt: altText(f.content?.alt) ?? "", label: f.filename }));
    const altLocked = (f: CmsImage) => !isDefault && (f.alt ?? "") !== "" && defAlt.get(f.id) === f.alt;
    if (images.length && images.some((i) => !altLocked(i))) editable.push("image_alt");
    if (images.some(altLocked)) notes.push("Some image alt texts aren't translated in this language yet — translate them in the Kirby Panel first.");

    if (noTranslation) notes.unshift(`This page has no ${language?.toUpperCase()} translation yet — create it in the Kirby Panel first. Editing here would create (and possibly publish) it.`);
    else if (untranslated.size || titleUntranslated) notes.unshift(`Fields not yet translated to ${language?.toUpperCase()} are read-only (they only show the ${def?.toUpperCase()} fallback).`);

    const multi = all.length > 0;
    return {
      type: "page",
      externalId: kirbyExternalId(language, id),
      title: `${page.title || id}${multi ? ` · ${language?.toUpperCase()}` : ""}`,
      url: page.url ?? null,
      status: page.status ?? null,
      updatedAt: null,
      fields,
      editable,
      images: images.map((i) => (altLocked(i) ? { ...i, label: `${i.label} (not translated)` } : i)),
      notes,
      texts,
      language,
      translations: all.map((l) => ({ language: l.code, externalId: kirbyExternalId(l.code, id), isDefault: !!l.default })),
    };
  };

  /** Reads one top-level field's form value (form values = what PATCH expects back). */
  const fieldValue = async (id: string, language: string | null, field: string): Promise<unknown> => {
    const page = await loadPage(id, language);
    return (page.content ?? {})[field.toLowerCase()];
  };

  const updateItem = async (externalId: string, patch: CmsItemPatch): Promise<{ note?: string | null }> => {
    const { language, id } = parseKirbyId(externalId, await codes());
    const def = await defaultLang();
    const item = await getItem(externalId);
    if (!item.editable.includes(patch.field)) throw new Error(`${patch.field} can't be edited for this item.${item.notes?.[0] ? ` ${item.notes[0]}` : ""}`);

    let write: () => Promise<unknown>;
    let guardField: string | null = null;
    switch (patch.field) {
      case "title":
        write = () => kapi(`${base(id)}/title`, language, { method: "PATCH", json: { title: patch.value } });
        guardField = "title";
        break;
      case "slug":
        if (id === SITE_ID) throw new Error("The site has no slug.");
        write = () => kapi(`${base(id)}/slug`, language, { method: "PATCH", json: { slug: patch.value } });
        break;
      case "meta_title":
      case "meta_description": {
        const schema = await loadSchema(id, language, (await loadPage(id, language)).blueprint);
        const key = seoKeys(schema)[patch.field === "meta_title" ? "title" : "description"];
        if (!key) throw new Error("No SEO field found in this page's blueprint.");
        write = () => kapi(base(id), language, { method: "PATCH", json: { [key]: patch.value } });
        guardField = key;
        break;
      }
      case "content_text": {
        const path = patch.fieldKey ?? "";
        const entry: CmsTextValue | undefined = item.texts?.find((t) => t.path === path);
        if (!entry?.editable) throw new Error(entry?.reason ?? "This text no longer exists on the page.");
        const [field, ...segments] = path.split("/");
        const current = await fieldValue(id, language, field!);
        if (typeof getAtPath(current, segments) !== "string") throw new Error("This text no longer exists on the page.");
        const next = setAtPath(current, segments, patch.value);
        write = () => kapi(base(id), language, { method: "PATCH", json: { [field!]: next } });
        guardField = pathField(path);
        break;
      }
      case "image_alt": {
        const file = patch.fieldKey ?? "";
        const f = (await loadFiles(id, language)).find((x) => x.filename === file);
        if (!f) throw new Error("Choose the image to update.");
        const alt = f.content?.alt;
        const value = alt && typeof alt === "object" ? { ...(alt as object), text: patch.value, source: "manual" } : patch.value;
        write = () => kapi(`${base(id)}/files/${encodeURIComponent(file)}`, language, { method: "PATCH", json: { alt: value } });
        break;
      }
      default:
        throw new Error(`Kirby can't edit ${patch.field}.`);
    }

    // Writing a non-default language must never touch the default one: snapshot, write, compare.
    const guard = language && def && language !== def && guardField ? guardField : null;
    const snapshot = guard ? JSON.stringify(guard === "title" ? (await loadPage(id, def)).title : await fieldValue(id, def, guard)) : null;
    await write();
    if (guard) {
      const after = JSON.stringify(guard === "title" ? (await loadPage(id, def)).title : await fieldValue(id, def, guard));
      if (after !== snapshot) throw new Error(`Kirby changed the ${def?.toUpperCase()} content while writing ${language?.toUpperCase()} — check the page in the Panel.`);
    }
    return {};
  };

  return {
    editTypes: ["page"],
    async test() {
      const me = await fetchJson<{ data?: { email?: string; name?: string } }>(`${site}/api/auth`, { headers: { authorization: auth } });
      const l = await languages();
      return { account: `${new URL(site).host} · ${me.data?.name || me.data?.email || "Kirby"}${l.length ? ` · ${l.map((x) => x.code).join("/")}` : ""}` };
    },
    async publish() {
      throw new Error("Kirby: creating pages isn't supported — edit existing pages under Content → Site edits.");
    },
    async listItems(query) {
      const page = Math.max(1, Number.parseInt(query.cursor ?? "1", 10) || 1);
      const def = await defaultLang();
      const res = await kapi<{ data?: KPage[]; pagination?: { page: number; total: number; limit: number } }>("site/search", def, {
        method: "POST",
        query: { select: "id,title,url,status", page: String(page), limit: "20" },
        json: query.search?.trim() ? { search: query.search.trim() } : {},
      });
      const multi = (await codes()).length > 0;
      const items: CmsItem[] = (res.data ?? []).map((p) => ({
        type: "page",
        externalId: kirbyExternalId(def, p.id),
        title: `${p.title || p.id}${multi ? ` · ${def?.toUpperCase()}` : ""}`,
        url: p.url ?? null,
        status: p.status ?? null,
        updatedAt: null,
        fields: { title: p.title ?? "" },
        editable: [],
        images: [],
        language: def,
      }));
      if (page === 1 && !query.search?.trim()) {
        items.unshift({ type: "page", externalId: kirbyExternalId(def, SITE_ID), title: `Site (global fields)${multi ? ` · ${def?.toUpperCase()}` : ""}`, url: site, status: null, updatedAt: null, fields: {}, editable: [], images: [], language: def });
      }
      const p = res.pagination;
      return { items, nextCursor: p && p.page * p.limit < p.total ? String(page + 1) : null };
    },
    getItem: (_type, externalId) => getItem(externalId),
    updateItem: (_type, externalId, patch) => updateItem(externalId, patch),
  };
}
