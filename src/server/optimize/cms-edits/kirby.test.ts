import { describe, expect, it } from "vitest";
import { collectTexts, getAtPath, parseKirbyId, setAtPath, untranslatedFields, type KirbyFieldProps } from "./kirby-schema";
import { protect, restore, validateRichText } from "./rich-text";
import { itemFieldValue, normalizeFieldValue } from "./fields";

/* Synthetic schema: resolved field props as Kirby's sections API returns them. */
const button: KirbyFieldProps = {
  type: "blocks",
  label: "Button",
  fieldsets: {
    button: { name: "Button", tabs: { content: { fields: { text: { type: "text", label: "Text" }, url: { type: "link", label: "URL" }, anchor: { type: "text", label: "Anchor", pattern: "^[a-z-]+$" } } } } },
  },
};
const schema: Record<string, KirbyFieldProps> = {
  intro: { type: "writer", inline: true, label: { en: "Intro", de: "Einleitung" } },
  internal: { type: "text", label: "Internal key", translate: false },
  body: {
    type: "blocks",
    label: "Body",
    fieldsets: {
      heading: { name: "Heading", tabs: { content: { fields: { text: { type: "writer", inline: true, label: "Text" }, level: { type: "toggles", label: "Level" } } } } },
      cards: {
        name: "Cards",
        tabs: {
          content: { fields: { title: { type: "text", label: "Title" }, cards: { type: "blocks", label: "Cards", fieldsets: { card: { name: "Card", tabs: { content: { fields: { title: { type: "text", label: "Title" }, button } } } } } } } },
          appearance: { fields: { appearance__bg: { type: "select", label: "Background" }, campaign: { type: "text", label: "Campaign" } } },
        },
      },
    },
  },
  quote: {
    type: "blocks",
    label: "Quote",
    // tabs as an array instead of a keyed object
    fieldsets: { quote: { name: "Quote", tabs: [{ fields: { text: { type: "text", label: "Text" } } }] } },
  },
  grid: {
    type: "layout",
    label: "Layout",
    fieldsets: { text: { name: "Text", tabs: { content: { fields: { text: { type: "writer", label: "Text" } } } } } },
  },
  faq: {
    type: "structure",
    label: "FAQ",
    fields: { question: { type: "text", label: "Question" }, answers: { type: "structure", label: "Answers", fields: { text: { type: "textarea", label: "Text" } } } },
  },
  cta: { type: "object", label: "CTA", fields: { label: { type: "text", label: "Label" }, link: { type: "text", label: "Link" } } },
  image: { type: "text", label: "Image URL" },
};

const content: Record<string, unknown> = {
  intro: 'Talk to a <a href="/@/page/abc">psychologist</a> from <span data-price-tier="first">€0</span>',
  internal: "key-1",
  body: [
    { id: "h1", type: "heading", isHidden: false, content: { text: "Welcome", level: "h2" } },
    {
      id: "c1",
      type: "cards",
      isHidden: true,
      content: {
        title: "Our offers",
        appearance__bg: "bg-yellow pt-fluid-6",
        campaign: "spring_sale",
        // nested blocks stored as a JSON string (older Kirby storage)
        cards: JSON.stringify([{ id: "k1", type: "card", isHidden: false, content: { title: "Chat", button: [{ id: "b1", type: "button", content: { text: "Start", url: "https://x.test", anchor: "start" } }] } }]),
      },
    },
  ],
  quote: [{ id: "q1", type: "quote", content: { text: "Wise words" } }],
  grid: [{ id: "r1", attrs: {}, columns: [{ id: "col1", width: "1/1", blocks: [{ id: "t1", type: "text", content: { text: "<p>Layout text</p>" } }] }] }],
  faq: [{ question: "How?", answers: [{ text: "Like this." }] }],
  cta: { label: "Go", link: "page://xyz" },
  image: "https://cdn.test/a.jpg",
};

describe("kirby schema → texts", () => {
  const texts = collectTexts(schema, content, { isDefaultLanguage: true, exclude: new Set(["campaign"]) });
  const byPath = new Map(texts.map((t) => [t.path, t]));

  it("finds text at every nesting level with stable paths", () => {
    expect([...byPath.keys()]).toEqual([
      "intro",
      "internal",
      "body/#h1/text",
      "body/#c1/title",
      "body/#c1/cards/#k1/title",
      "body/#c1/cards/#k1/button/#b1/text",
      "quote/#q1/text",
      "grid/#r1/#col1/#t1/text",
      "faq/[0]/question",
      "faq/[0]/answers/[0]/text",
      "cta/label",
    ]);
    expect(byPath.get("intro")).toMatchObject({ kind: "inline-html", label: "Intro", editable: true });
    expect(byPath.get("grid/#r1/#col1/#t1/text")?.kind).toBe("html");
    expect(byPath.get("body/#c1/cards/#k1/button/#b1/text")?.label).toBe("Body › Cards (hidden) › Cards › Card › Button › Button › Text");
  });

  it("never offers selects, links, patterns, references or deny-listed fields", () => {
    expect(texts.some((t) => /appearance|campaign|url|anchor|level/.test(t.path))).toBe(false);
    expect(byPath.has("image")).toBe(false); // URL value
    expect(byPath.has("cta/link")).toBe(false); // page:// reference
  });

  it("locks translate:false and untranslated fields in other languages", () => {
    const other = collectTexts(schema, content, { isDefaultLanguage: false, untranslated: new Set(["body"]) });
    const m = new Map(other.map((t) => [t.path, t]));
    expect(m.get("internal")?.editable).toBe(false);
    expect(m.get("body/#c1/cards/#k1/title")?.editable).toBe(false);
    expect(m.get("intro")?.editable).toBe(true);
  });

  it("writes one value and keeps everything else (ids, order, storage form)", () => {
    const body = setAtPath(content.body, ["#c1", "cards", "#k1", "button", "#b1", "text"], "Start now") as Array<Record<string, unknown>>;
    expect(getAtPath(body, ["#c1", "cards", "#k1", "button", "#b1", "text"])).toBe("Start now");
    const card = body[1]!.content as Record<string, unknown>;
    expect(typeof card.cards).toBe("string"); // stays a JSON string
    expect(card.appearance__bg).toBe("bg-yellow pt-fluid-6");
    expect(body[0]).toBe((content.body as unknown[])[0]); // untouched blocks are the same objects
    expect(JSON.parse(card.cards as string)[0].content.button[0].content.url).toBe("https://x.test");
    expect(getAtPath(setAtPath(content.grid, ["#r1", "#col1", "#t1", "text"], "<p>New</p>"), ["#r1", "#col1", "#t1", "text"])).toBe("<p>New</p>");
    expect(getAtPath(setAtPath(content.faq, ["[0]", "answers", "[0]", "text"], "Better."), ["[0]", "answers", "[0]", "text"])).toBe("Better.");
    expect(() => setAtPath(content.body, ["#gone", "text"], "x")).toThrow(/no longer exists/);
  });
});

describe("kirby languages", () => {
  it("binds every item to one language", () => {
    expect(parseKirbyId("en:blog/post", ["de", "en"])).toEqual({ language: "en", id: "blog/post" });
    expect(() => parseKirbyId("blog/post", ["de", "en"])).toThrow(/language prefix/);
    expect(() => parseKirbyId("fr:blog/post", ["de", "en"])).toThrow(/language prefix/);
    expect(parseKirbyId("blog/post", [])).toEqual({ language: null, id: "blog/post" });
    expect(() => parseKirbyId("en:blog", [])).toThrow(/single language/);
  });

  it("detects fields that only show the default-language fallback", () => {
    const de = { intro: "Hallo", body: "[1]", internal: "k", empty: "" };
    const en = { intro: "Hello", body: "[1]", internal: "k", empty: "" };
    expect([...untranslatedFields(en, de, new Set(["intro", "body", "empty"]))]).toEqual(["body"]);
  });
});

describe("rich text guard", () => {
  const before = 'Talk to a <a href="/@/page/abc">psychologist</a> from <span data-price-tier="first">€0</span> today';

  it("allows prose changes around protected links and placeholders", () => {
    expect(validateRichText("inline-html", before, 'Chat with a <a href="/@/page/abc">licensed psychologist</a> from <span data-price-tier="first">€0</span>')).toBeNull();
    expect(validateRichText("html", "<p>a</p>", "<p>a <strong>b</strong></p><ul><li>c</li></ul>")).toBeNull();
  });

  it("rejects lost or changed links / placeholders, block tags in inline fields and attributes", () => {
    expect(validateRichText("inline-html", before, "Talk to a psychologist")).toMatch(/must stay exactly/);
    expect(validateRichText("inline-html", before, before.replace("€0", "€5"))).toMatch(/must stay exactly/);
    expect(validateRichText("inline-html", before, before.replace("/@/page/abc", "https://evil.test"))).toMatch(/must stay exactly/);
    expect(validateRichText("inline-html", "x", "<p>x</p>")).toMatch(/inline/);
    expect(validateRichText("html", "<p>x</p>", '<p onclick="x()">x</p>')).toMatch(/attributes/);
    expect(validateRichText("html", "<p>x</p>", "<p>x</p><script>1</script>")).toMatch(/Scripts/);
    expect(validateRichText("plain", "a", "a\nb")).toMatch(/single line/);
    expect(validateRichText("plain", "a", "")).toMatch(/empty/);
  });

  it("round-trips protected parts through ⟦n⟧ tokens and rejects damage", () => {
    const p = protect(before);
    expect(p.text).toBe("Talk to a ⟦1⟧psychologist</a> from ⟦2⟧ today");
    expect(restore("Chat with a ⟦1⟧psychologist</a> for ⟦2⟧", p.tokens)).toBe('Chat with a <a href="/@/page/abc">psychologist</a> for <span data-price-tier="first">€0</span>');
    expect(() => restore("Chat ⟦1⟧ ⟦1⟧ ⟦2⟧", p.tokens)).toThrow(/2 times/);
    expect(() => restore("Chat ⟦1⟧", p.tokens)).toThrow(/removed/);
    expect(() => restore("⟦1⟧ ⟦2⟧ ⟦3⟧", p.tokens)).toThrow(/Unknown/);
  });

  it("resolves content texts by path and ignores re-serialized whitespace", () => {
    const item = { fields: {}, images: [], texts: [{ path: "body/#a/text", label: "", group: "", kind: "html" as const, value: "<p>x</p>", editable: true }] };
    expect(itemFieldValue(item, "content_text", "body/#a/text")).toBe("<p>x</p>");
    expect(itemFieldValue(item, "content_text", "body/#b/text")).toBeNull();
    expect(normalizeFieldValue("content_text", "<p>a</p>\n  <p>b</p> ")).toBe("<p>a</p><p>b</p>");
  });
});
