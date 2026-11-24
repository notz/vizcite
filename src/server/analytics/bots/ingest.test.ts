import { describe, expect, it, vi } from "vitest";

const inserted: Record<string, unknown>[] = [];
vi.mock("server-only", () => ({}));
vi.mock("@/server/db/client", () => {
  const chain: Record<string, unknown> = {};
  chain.values = (v: unknown) => {
    if (Array.isArray(v) && v[0] && "bot" in v[0]) inserted.push(...v);
    return chain;
  };
  chain.onConflictDoNothing = () => chain;
  chain.onConflictDoUpdate = () => Promise.resolve();
  chain.returning = () => Promise.resolve([]);
  return { db: { insert: () => chain } };
});
vi.mock("./ip-ranges", () => ({
  getBotVerifier: async () => (_bot: string, ip: string | null) => (ip === "20.0.0.1" ? true : ip === "9.9.9.9" ? false : null),
}));

describe("ingestHits IP guard", () => {
  it("verifies on the IP but never stores it (no ip column)", async () => {
    const { ingestHits } = await import("./ingest");
    const ua = "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)";
    const hit = (ip: string | null) => ({ ts: new Date(), ip, userAgent: ua, path: "/x", host: null, method: null, status: 200, bytes: null, referer: null });
    await ingestHits("p", "api", [hit("20.0.0.1"), hit("9.9.9.9"), hit("1.2.3.4"), hit(null)]);
    expect(inserted.every((r) => !("ip" in r))).toBe(true);
    expect(inserted.map((r) => r.verified)).toEqual([true, false, null, null]);
  });
});
