import { describe, expect, it } from "vitest";
import {
  TrafficAggregator,
  dateWindows,
  ga4Date,
  ga4RowToTraffic,
  matomoVisitToRow,
  normalizeCountry,
  normalizeLandingPage,
  spreadRevenue,
  todayInTimeZone,
  umamiOrganicDay,
  umamiVisitToRow,
} from "./normalize";

describe("normalizers", () => {
  it("normalizes landing pages", () => {
    expect(normalizeLandingPage("(not set)")).toBe("");
    expect(normalizeLandingPage("/")).toBe("/");
    expect(normalizeLandingPage("/pricing?utm_source=chatgpt.com")).toBe("/pricing");
    expect(normalizeLandingPage("https://example.com/de/shop//kit#x")).toBe("/de/shop/kit");
    expect(normalizeLandingPage("blog/post")).toBe("/blog/post");
  });

  it("normalizes countries", () => {
    expect(normalizeCountry("de")).toBe("DE");
    expect(normalizeCountry("(not set)")).toBe("");
    expect(normalizeCountry("xx")).toBe("");
  });

  it("formats GA4 dates and time-zone days", () => {
    expect(ga4Date("20260925")).toBe("2026-09-25");
    const now = new Date("2026-09-25T23:30:00Z");
    expect(todayInTimeZone("Europe/Berlin", now)).toBe("2026-09-26");
    expect(todayInTimeZone("America/Los_Angeles", now)).toBe("2026-09-25");
    expect(todayInTimeZone("Not/AZone", now)).toBe("2026-09-25");
  });

  it("splits date windows", () => {
    expect(dateWindows("2026-01-01", "2026-01-10", 4)).toEqual([
      { from: "2026-01-01", to: "2026-01-04" },
      { from: "2026-01-05", to: "2026-01-08" },
      { from: "2026-01-09", to: "2026-01-10" },
    ]);
    expect(dateWindows("2026-01-01", "2026-01-01", 90)).toHaveLength(1);
  });
});

describe("row mappers", () => {
  it("maps GA4 AI rows and drops non-AI sources", () => {
    const row = ga4RowToTraffic({
      date: "20260920",
      sessionSource: "chatgpt.com",
      landingPage: "/pricing",
      countryId: "DE",
      sessions: 10,
      engagedSessions: 6,
      keyEvents: 3,
      sessionKeyEventRate: 0.2,
      totalRevenue: 99.5,
      userEngagementDuration: 300,
      totalUsers: 9,
    });
    expect(row).toMatchObject({ date: "2026-09-20", platform: "chatgpt", page: "/pricing", country: "DE", sessions: 10, convertedSessions: 2, revenue: 99.5 });
    expect(ga4RowToTraffic({ date: "20260920", sessionSource: "google", sessions: 5 })).toBeNull();
  });

  it("maps Matomo visits", () => {
    const v = matomoVisitToRow({
      serverDate: "2026-09-20",
      referrerName: "perplexity.ai",
      referrerUrl: "https://www.perplexity.ai/search/abc",
      visitDuration: 95,
      actions: 3,
      countryCode: "at",
      visitConverted: 1,
      goalConversions: 1,
      actionDetails: [
        { type: "action", url: "https://example.com/products/kit?x=1" },
        { type: "goal", revenue: 20 },
        { type: "ecommerceOrder", revenue: 150 },
      ],
    });
    expect(v).toMatchObject({ platform: "perplexity", page: "/products/kit", country: "AT", engagedSessions: 1, convertedSessions: 1, conversions: 2, revenue: 170 });
    expect(matomoVisitToRow({ serverDate: "2026-09-20", referrerName: "google", referrerUrl: "https://www.google.com/" })).toBeNull();
  });

  it("aggregates by date × platform × page × country", () => {
    const agg = new TrafficAggregator();
    const base = { date: "2026-09-20", platform: "claude", page: "/", country: "DE", engagedSessions: 1, convertedSessions: 0, conversions: 0, revenue: 0, engagementSeconds: 10, users: 1 };
    agg.add({ ...base, sessions: 1 });
    agg.add({ ...base, sessions: 2 });
    agg.add({ ...base, country: "US", sessions: 1 });
    agg.add({ ...base, sessions: 0, engagedSessions: 0 });
    const rows = agg.rows();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.country === "DE")?.sessions).toBe(3);
  });
  it("maps Umami visits (entry page, duration, engagement, goals)", () => {
    const landing = { sessionId: "s1", visitId: "v1", createdAt: "2026-09-20T10:00:00.000Z", urlPath: "/products/kit", referrerDomain: "chatgpt.com", country: "at" };
    const activity = [
      { createdAt: "2026-09-20T10:03:00.000Z", eventType: 2, eventName: "signup", visitId: "v1" },
      { createdAt: "2026-09-20T10:01:00.000Z", eventType: 1, urlPath: "/pricing", visitId: "v1" },
      { createdAt: "2026-09-20T10:00:00.000Z", eventType: 1, urlPath: "/products/kit", visitId: "v1" },
      { createdAt: "2026-09-20T12:00:00.000Z", eventType: 1, urlPath: "/other-visit", visitId: "v2" },
    ];
    const goals = [{ type: "event" as const, value: "signup" }, { type: "path" as const, value: "/pricing*" }];
    expect(umamiVisitToRow(landing, activity, goals)).toMatchObject({
      date: "2026-09-20", platform: "chatgpt", page: "/products/kit", country: "AT",
      engagedSessions: 1, convertedSessions: 1, conversions: 2, engagementSeconds: 180, pageviews: 2,
    });
    // No activity (deleted session): still one visit, counted as a bounce.
    expect(umamiVisitToRow(landing, null, goals)).toMatchObject({ sessions: 1, engagedSessions: 0, conversions: 0, pageviews: 1, engagementSeconds: 0 });
    expect(umamiVisitToRow({ ...landing, referrerDomain: "google.com" }, activity, goals)).toBeNull();
    // No referrer, but utm_source=chatgpt.com in the URL (how ChatGPT tags its links).
    expect(umamiVisitToRow({ ...landing, referrerDomain: "", urlQuery: "utm_source=chatgpt.com" }, null, goals)).toMatchObject({ platform: "chatgpt" });
    expect(umamiVisitToRow({ ...landing, referrerDomain: "", urlQuery: "utm_source=newsletter" }, null, goals)).toBeNull();
  });

  it("spreads Umami revenue over the day's visits of a platform", () => {
    const row = (platform: string, convertedSessions: number) => ({ date: "2026-09-20", platform, page: "/", country: "DE", sessions: 1, engagedSessions: 1, convertedSessions, conversions: convertedSessions, revenue: 0, engagementSeconds: 0, users: 1 });
    const visits = [row("chatgpt", 1), row("chatgpt", 1), row("chatgpt", 0), row("claude", 0)];
    spreadRevenue(visits, new Map([["2026-09-20|chatgpt", 100], ["2026-09-20|claude", 10], ["2026-09-21|claude", 5]]));
    expect(visits.map((v) => v.revenue)).toEqual([50, 50, 0, 10]);
  });

  it("maps the Umami organic search channel", () => {
    const channels = [{ name: "direct", visits: 50 }, { name: "organicSearch", visits: 10, bounces: 4, totaltime: 600, pageviews: 25, visitors: 9 }];
    expect(umamiOrganicDay("2026-09-20", channels, 7)).toMatchObject({ sessions: 10, engagedSessions: 6, engagementSeconds: 600, pageviews: 25, users: 9, revenue: 7 });
    expect(umamiOrganicDay("2026-09-20", [], 0).sessions).toBe(0);
  });

});
