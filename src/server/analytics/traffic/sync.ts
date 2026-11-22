import "server-only";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "@/server/db/client";
import { channelDaily, trafficDaily, trafficRows, type TrafficProvider } from "@/server/db/schema";
import type { JobContext } from "@/server/jobs/types";
import { getIntegration, markIntegrationSync } from "@/server/integrations/store";
import {
  getGoogleAccessToken,
  googleApiErrorMessage,
  GoogleNotConfiguredError,
  GoogleNotConnectedError,
  GoogleReconnectRequiredError,
} from "@/server/integrations/google/oauth";
import { ga4RunReportAll } from "@/server/integrations/google/ga4";
import { getMatomoCredentials, matomoCall, MatomoError, type MatomoCredentials, type MatomoVisit } from "@/server/integrations/matomo";
import {
  getPiwikCredentials,
  piwikCellId,
  piwikCellLabel,
  piwikQuery,
  PiwikError,
  type PiwikColumn,
  type PiwikCredentials,
} from "@/server/integrations/piwik";
import { getUmamiCredentials, umamiGet, UmamiError, type UmamiCredentials } from "@/server/integrations/umami";
import { IntegrationHttpError } from "@/server/integrations/http";
import { aiReferrerDomains, aiSourcePattern, classifyAiSource, GA4_AI_SOURCE_REGEX, PIWIK_AI_SOURCE_REGEX } from "../ai-platforms";
import {
  dateWindows,
  ga4Date,
  ga4OrganicRow,
  ga4RowToTraffic,
  GA4_ORGANIC_CHANNEL,
  matomoOrganicDays,
  matomoVisitToRow,
  normalizeCountry,
  normalizeLandingPage,
  spreadRevenue,
  todayInTimeZone,
  TrafficAggregator as Aggregator,
  umamiEventPlatform,
  umamiOrganicDay,
  umamiVisitToRow,
  UMAMI_ORGANIC_CHANNEL,
  type ChannelDayTotals,
  type NormalizedTrafficRow,
  type UmamiActivityLike,
  type UmamiChannelRow,
  type UmamiEventLike,
  type UmamiGoal,
} from "./normalize";
import { addDays, daysBetween } from "../period";
import { integrationTarget, lockSyncTarget, SyncTargetChangedError, TRAFFIC_RETENTION_DAYS } from "../scheduling";

export type TrafficSyncPayload = { projectId: string; provider: TrafficProvider; full?: boolean };

type AggRow = NormalizedTrafficRow;

type DailyTotal = { date: string; sessions: number; conversions: number; revenue: number };

class SyncCancelledError extends Error {}

/**
 * Organic-search channel import state (AI vs organic benchmark), stored in the integration config as
 * `organicChannel` / `organicNote`: ok | unsupported (the connector can't segment it) | error (last fetch failed).
 */
type OrganicState = { status: "ok" | "unsupported" | "error"; note: string | null };

/** `null` = keep the stored organic rows of the range untouched (fetch failed / unsupported). */
type OrganicDays = ChannelDayTotals[] | null;

async function replaceRange(
  projectId: string,
  provider: TrafficProvider,
  target: string,
  from: string,
  to: string,
  rows: AggRow[],
  totals: DailyTotal[],
  organic: OrganicDays = null,
) {
  await db.transaction(async (tx) => {
    // Serializes concurrent syncs and aborts when the property/site changed or was disconnected meanwhile.
    await lockSyncTarget(tx, projectId, provider, target);
    await tx
      .delete(trafficRows)
      .where(and(eq(trafficRows.projectId, projectId), eq(trafficRows.provider, provider), gte(trafficRows.date, from), lte(trafficRows.date, to)));
    await tx
      .delete(trafficDaily)
      .where(and(eq(trafficDaily.projectId, projectId), eq(trafficDaily.provider, provider), gte(trafficDaily.date, from), lte(trafficDaily.date, to)));
    for (let i = 0; i < rows.length; i += 1000) {
      await tx.insert(trafficRows).values(
        rows.slice(i, i + 1000).map((r) => ({
          projectId,
          provider,
          date: r.date,
          platform: r.platform,
          page: r.page,
          country: r.country,
          sessions: Math.round(r.sessions),
          engagedSessions: Math.round(r.engagedSessions),
          convertedSessions: r.convertedSessions,
          conversions: r.conversions,
          revenue: r.revenue,
          engagementSeconds: r.engagementSeconds,
          users: Math.round(r.users),
          pageviews: r.pageviews ?? 0,
        })),
      );
    }
    const dedup = new Map<string, DailyTotal>();
    for (const t of totals) if (t.date >= from && t.date <= to) dedup.set(t.date, t);
    const list = [...dedup.values()];
    for (let i = 0; i < list.length; i += 1000) {
      await tx.insert(trafficDaily).values(
        list.slice(i, i + 1000).map((t) => ({
          projectId,
          provider,
          date: t.date,
          sessions: Math.round(t.sessions),
          conversions: t.conversions,
          revenue: t.revenue,
        })),
      );
    }
    if (organic) {
      await tx
        .delete(channelDaily)
        .where(
          and(
            eq(channelDaily.projectId, projectId),
            eq(channelDaily.provider, provider),
            eq(channelDaily.channel, "organic_search"),
            gte(channelDaily.date, from),
            lte(channelDaily.date, to),
          ),
        );
      const days = new Map<string, ChannelDayTotals>();
      for (const d of organic) if (d.date >= from && d.date <= to && /^\d{4}-\d{2}-\d{2}$/.test(d.date)) days.set(d.date, d);
      const list = [...days.values()];
      for (let i = 0; i < list.length; i += 1000) {
        await tx.insert(channelDaily).values(
          list.slice(i, i + 1000).map((d) => ({
            projectId,
            provider,
            channel: "organic_search" as const,
            date: d.date,
            sessions: Math.round(d.sessions),
            engagedSessions: Math.round(d.engagedSessions),
            engagementSeconds: d.engagementSeconds,
            pageviews: d.pageviews,
            convertedSessions: d.convertedSessions,
            conversions: d.conversions,
            revenue: d.revenue,
            users: Math.round(d.users),
          })),
        );
      }
    }
  });
}

function organicError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

type SyncRange = { from: string; to: string };

function resolveRange(opts: { full?: boolean; syncedThrough: unknown; today: string }): SyncRange | null {
  const yesterday = addDays(opts.today, -1);
  const floor = addDays(opts.today, -TRAFFIC_RETENTION_DAYS);
  const through = typeof opts.syncedThrough === "string" && /^\d{4}-\d{2}-\d{2}$/.test(opts.syncedThrough) ? opts.syncedThrough : null;
  let from = opts.full || !through ? floor : addDays(through, -3);
  if (from < floor) from = floor;
  if (from > yesterday) from = yesterday;
  return { from, to: yesterday };
}

/* ───────────────────────────── GA4 ───────────────────────────── */

async function syncGa4(projectId: string, target: string, config: Record<string, unknown>, range: SyncRange, ctx?: JobContext) {
  const propertyId = typeof config.propertyId === "string" ? config.propertyId : "";
  if (!propertyId) throw new Error("Select a Google Analytics property first.");
  const windows = dateWindows(range.from, range.to, 90);
  let rowsSaved = 0;
  let aiSessions = 0;
  let organicState: OrganicState = { status: "ok", note: null };
  for (const [i, w] of windows.entries()) {
    if (ctx && (await ctx.isCancelled())) throw new SyncCancelledError();
    await ctx?.progress({ provider: "google_analytics", step: "fetch", window: i + 1, windows: windows.length, from: w.from, to: w.to });
    const token = await getGoogleAccessToken(projectId, "ga4");
    const ai = await ga4RunReportAll(
      token,
      propertyId,
      {
        dateRanges: [{ startDate: w.from, endDate: w.to }],
        dimensions: ["date", "sessionSource", "landingPage", "countryId"],
        metrics: ["sessions", "engagedSessions", "keyEvents", "sessionKeyEventRate", "totalRevenue", "userEngagementDuration", "totalUsers", "screenPageViews"],
        dimensionFilter: {
          filter: { fieldName: "sessionSource", stringFilter: { matchType: "PARTIAL_REGEXP", value: GA4_AI_SOURCE_REGEX, caseSensitive: false } },
        },
        limit: 100_000,
      },
      250_000,
    );
    const agg = new Aggregator();
    for (const r of ai.rows) {
      const row = ga4RowToTraffic(r);
      if (row) agg.add(row);
    }
    const totalsReport = await ga4RunReportAll(token, propertyId, {
      dateRanges: [{ startDate: w.from, endDate: w.to }],
      dimensions: ["date"],
      metrics: ["sessions", "keyEvents", "totalRevenue"],
      limit: 1000,
    });
    const totals: DailyTotal[] = totalsReport.rows.map((r) => ({
      date: ga4Date(r.date),
      sessions: Number(r.sessions ?? 0) || 0,
      conversions: Number(r.keyEvents ?? 0) || 0,
      revenue: Number(r.totalRevenue ?? 0) || 0,
    }));
    // Organic search benchmark (same metrics as the AI rows, Default Channel Group = Organic Search).
    let organic: OrganicDays = null;
    try {
      const report = await ga4RunReportAll(token, propertyId, {
        dateRanges: [{ startDate: w.from, endDate: w.to }],
        dimensions: ["date"],
        metrics: ["sessions", "engagedSessions", "keyEvents", "sessionKeyEventRate", "totalRevenue", "userEngagementDuration", "totalUsers", "screenPageViews"],
        dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: GA4_ORGANIC_CHANNEL } } },
        limit: 1000,
      });
      organic = report.rows.map(ga4OrganicRow);
    } catch (err) {
      organicState = { status: "error", note: `Organic search totals could not be fetched: ${organicError(err)}` };
    }
    const rows = agg.rows();
    await replaceRange(projectId, "google_analytics", target, w.from, w.to, rows, totals, organic);
    rowsSaved += rows.length;
    aiSessions += rows.reduce((a, r) => a + r.sessions, 0);
  }
  return { rows: rowsSaved, aiSessions, organic: organicState };
}

/* ───────────────────────────── Matomo ───────────────────────────── */

function matomoSegment(): string {
  // OR-combined (",") referrer URL contains (=@) conditions; values are URL-encoded per Matomo's segment spec.
  return aiReferrerDomains()
    .map((d) => `referrerUrl=@${encodeURIComponent(d)}`)
    .join(",");
}

async function syncMatomo(projectId: string, target: string, creds: MatomoCredentials, range: SyncRange, ctx?: JobContext) {
  const windows = dateWindows(range.from, range.to, 31);
  const segment = matomoSegment();
  let rowsSaved = 0;
  let aiSessions = 0;
  let organicState: OrganicState = { status: "ok", note: null };
  for (const [i, w] of windows.entries()) {
    if (ctx && (await ctx.isCancelled())) throw new SyncCancelledError();
    await ctx?.progress({ provider: "matomo", step: "fetch", window: i + 1, windows: windows.length, from: w.from, to: w.to });
    const agg = new Aggregator();
    const pageSize = 1000;
    for (let offset = 0; offset < 50_000; offset += pageSize) {
      const visits = await matomoCall<MatomoVisit[]>(
        creds,
        "Live.getLastVisitsDetails",
        { idSite: creds.siteId, period: "range", date: `${w.from},${w.to}`, segment, filter_limit: pageSize, filter_offset: offset },
        120_000,
      );
      if (!Array.isArray(visits) || !visits.length) break;
      for (const v of visits) {
        const row = matomoVisitToRow(v);
        if (row && row.date >= w.from && row.date <= w.to) agg.add(row);
      }
      if (visits.length < pageSize) break;
    }
    const [summary, goals] = await Promise.all([
      matomoCall<Record<string, { nb_visits?: number } | unknown[]>>(creds, "VisitsSummary.get", {
        idSite: creds.siteId,
        period: "day",
        date: `${w.from},${w.to}`,
      }),
      matomoCall<Record<string, { nb_conversions?: number; revenue?: number } | unknown[]>>(creds, "Goals.get", {
        idSite: creds.siteId,
        period: "day",
        date: `${w.from},${w.to}`,
      }).catch(() => ({}) as Record<string, unknown[]>),
    ]);
    const totals: DailyTotal[] = Object.entries(summary ?? {}).map(([date, v]) => {
      const g = (goals as Record<string, unknown>)[date];
      const gv = g && !Array.isArray(g) ? (g as { nb_conversions?: number; revenue?: number }) : {};
      return {
        date,
        sessions: !Array.isArray(v) ? Number((v as { nb_visits?: number }).nb_visits ?? 0) || 0 : 0,
        conversions: Number(gv.nb_conversions ?? 0) || 0,
        revenue: Number(gv.revenue ?? 0) || 0,
      };
    });
    // Organic search benchmark: the same summaries, segmented to search-engine referrals.
    let organic: OrganicDays = null;
    try {
      const params = { idSite: creds.siteId, period: "day", date: `${w.from},${w.to}`, segment: "referrerType==search" };
      const [orgSummary, orgGoals, orgActions] = await Promise.all([
        matomoCall<Record<string, unknown>>(creds, "VisitsSummary.get", params),
        matomoCall<Record<string, unknown>>(creds, "Goals.get", params).catch(() => ({}) as Record<string, unknown>),
        matomoCall<Record<string, unknown>>(creds, "Actions.get", params).catch(() => null),
      ]);
      organic = matomoOrganicDays(orgSummary, orgGoals, orgActions);
    } catch (err) {
      organicState = { status: "error", note: `Organic search totals could not be fetched: ${organicError(err)}` };
    }
    const rows = agg.rows();
    await replaceRange(projectId, "matomo", target, w.from, w.to, rows, totals, organic);
    rowsSaved += rows.length;
    aiSessions += rows.reduce((a, r) => a + r.sessions, 0);
  }
  return { rows: rowsSaved, aiSessions, organic: organicState };
}

/* ───────────────────────────── Umami ───────────────────────────── */

const utcDay = (d: string) => ({ startAt: Date.parse(`${d}T00:00:00.000Z`), endAt: Date.parse(`${d}T23:59:59.999Z`) });

/** Optional Umami feature (goals, revenue, channels): older versions answer 400/404 → `fallback`. */
async function umamiOptional<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof IntegrationHttpError && (err.status === 400 || err.status === 404)) return fallback;
    throw err;
  }
}

/** Pages through an Umami list (`{data, count}` or a plain array). */
async function umamiPaged<T>(creds: UmamiCredentials, path: string, params: Record<string, string | number>, pageSize = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 200; page++) {
    const res = await umamiGet<{ data?: T[] } | T[]>(creds, path, { ...params, page, pageSize }, 120_000);
    const data = Array.isArray(res) ? res : (res.data ?? []);
    out.push(...data);
    if (Array.isArray(res) || data.length < pageSize) break;
  }
  return out;
}

type UmamiSavedGoal = { id?: string; type?: string; parameters?: { type?: string; value?: string } | string };

/** Saved goals of the website (path or event goals) — they define a conversion. */
async function umamiGoals(creds: UmamiCredentials, site: string): Promise<(UmamiGoal & { id: string })[]> {
  const list = await umamiOptional(() => umamiPaged<UmamiSavedGoal>(creds, `${site}/goals`, {}, 100), []);
  const goals: (UmamiGoal & { id: string })[] = [];
  for (const g of list) {
    let p: { type?: string; value?: string } = {};
    try {
      p = typeof g.parameters === "string" ? JSON.parse(g.parameters) : (g.parameters ?? {});
    } catch {}
    if (g.id && p.value && (p.type === "path" || p.type === "event")) goals.push({ id: g.id, type: p.type, value: p.value });
  }
  return goals;
}

async function syncUmami(projectId: string, target: string, creds: UmamiCredentials, range: SyncRange, ctx?: JobContext) {
  const windows = dateWindows(range.from, range.to, 31);
  const site = `/websites/${encodeURIComponent(creds.websiteId)}`;
  const goals = await umamiGoals(creds, site);
  const domains = aiReferrerDomains()
    .map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  let rowsSaved = 0;
  let aiSessions = 0;
  let organicState: OrganicState = { status: "ok", note: null };
  for (const [i, w] of windows.entries()) {
    if (ctx && (await ctx.isCancelled())) throw new SyncCancelledError();
    await ctx?.progress({ provider: "umami", step: "fetch", window: i + 1, windows: windows.length, from: w.from, to: w.to });

    // 1. One landing pageview per AI-referred visit (Umami filters match single events, so the referrer
    //    filter only selects the entry pageview — visit metrics come from the session activity below).
    const landings = new Map<string, UmamiEventLike & { id?: string }>();
    //    Two passes: by referrer domain, and by utm_source (many AI links carry no referrer, only utm_source=chatgpt.com).
    const query = { startAt: utcDay(w.from).startAt, endAt: utcDay(w.to).endAt, eventType: 1 };
    const events = [
      ...(await umamiPaged<UmamiEventLike & { id?: string }>(creds, `${site}/events`, { ...query, referrer: `re.${domains}` })),
      ...(await umamiPaged<UmamiEventLike & { id?: string }>(creds, `${site}/events`, { ...query, utmSource: `re.${aiSourcePattern()}` })),
    ];
    for (const e of events) {
      if (!e.sessionId || Number.isNaN(Date.parse(e.createdAt ?? "")) || !umamiEventPlatform(e)) continue;
      const key = e.visitId ?? e.id ?? `${e.sessionId}|${e.createdAt}`;
      const cur = landings.get(key);
      if (!cur || e.createdAt! < cur.createdAt!) landings.set(key, e);
    }

    // 2. Duration, page views, engagement and goal conversions of those visits (activity of their session).
    const bySession = new Map<string, UmamiEventLike[]>();
    for (const e of landings.values()) bySession.set(e.sessionId!, [...(bySession.get(e.sessionId!) ?? []), e]);
    const visits: NormalizedTrafficRow[] = [];
    for (const [sessionId, list] of bySession) {
      if (ctx && (await ctx.isCancelled())) throw new SyncCancelledError();
      const times = list.map((e) => Date.parse(e.createdAt!));
      // shortcut: the activity endpoint returns at most 500 events — a longer visit is cut off (rare).
      const activity = await umamiOptional(
        () =>
          umamiGet<UmamiActivityLike[]>(creds, `${site}/sessions/${encodeURIComponent(sessionId)}/activity`, {
            startAt: Math.min(...times),
            endAt: Math.max(...times) + 24 * 3600_000,
          }),
        null,
      );
      for (const e of list) {
        const row = umamiVisitToRow(e, Array.isArray(activity) ? activity : null, goals);
        if (row && row.date >= w.from && row.date <= w.to) visits.push(row);
      }
    }

    // 3. Daily totals, organic search benchmark and revenue (revenue is only tracked per day × referrer).
    const revenueStats = await umamiOptional(
      () => umamiGet<{ sum?: number }>(creds, `${site}/revenue/stats`, { startAt: utcDay(w.from).startAt, endAt: utcDay(w.to).endAt, currency: creds.currency }),
      {} as { sum?: number },
    );
    const hasRevenue = Number(revenueStats.sum ?? 0) > 0;
    const revenue = new Map<string, number>();
    const totals: DailyTotal[] = [];
    const organic: ChannelDayTotals[] = [];
    let organicFailure: unknown = null;
    for (let day = w.from; day <= w.to; day = addDays(day, 1)) {
      const rng = { ...utcDay(day), timezone: "UTC" };
      const money = (type: string) =>
        hasRevenue
          ? umamiOptional(() => umamiGet<{ name?: string; value?: number }[]>(creds, `${site}/revenue/metrics`, { ...rng, type, currency: creds.currency }), [])
          : Promise.resolve([]);
      const [channels, byChannel, byReferrer, goalStats] = await Promise.all([
        umamiGet<UmamiChannelRow[]>(creds, `${site}/metrics/expanded`, { ...rng, type: "channel" }).catch((err) => {
          organicFailure = err;
          return null;
        }),
        money("channel"),
        money("referrer"),
        Promise.all(goals.map((g) => umamiOptional(() => umamiGet<{ num?: number }>(creds, `${site}/goals/${g.id}/stats`, rng), {} as { num?: number }))),
      ]);
      // Without channel metrics (older Umami) the total visits come from /stats and the benchmark is skipped.
      const visitsTotal = channels
        ? channels.reduce((a, c) => a + (Number(c.visits ?? 0) || 0), 0)
        : Number((await umamiGet<{ visits?: number }>(creds, `${site}/stats`, rng)).visits ?? 0) || 0;
      for (const r of byReferrer) {
        const platform = classifyAiSource(r.name ?? "");
        if (platform) revenue.set(`${day}|${platform}`, (revenue.get(`${day}|${platform}`) ?? 0) + (Number(r.value ?? 0) || 0));
      }
      totals.push({
        date: day,
        sessions: visitsTotal,
        conversions: goalStats.reduce((a, g) => a + (Number(g.num ?? 0) || 0), 0),
        revenue: byChannel.reduce((a, c) => a + (Number(c.value ?? 0) || 0), 0),
      });
      if (channels) organic.push(umamiOrganicDay(day, channels, Number(byChannel.find((c) => c.name === UMAMI_ORGANIC_CHANNEL)?.value ?? 0) || 0));
    }
    if (organicFailure) {
      const missing = organicFailure instanceof IntegrationHttpError && (organicFailure.status === 400 || organicFailure.status === 404);
      organicState = missing
        ? { status: "unsupported", note: "This Umami version has no channel metrics, so the organic search benchmark is unavailable." }
        : { status: "error", note: `Organic search totals could not be fetched: ${organicError(organicFailure)}` };
    }

    spreadRevenue(visits, revenue);
    const agg = new Aggregator();
    for (const v of visits) agg.add(v);
    const rows = agg.rows();
    await replaceRange(projectId, "umami", target, w.from, w.to, rows, totals, organicFailure ? null : organic);
    rowsSaved += rows.length;
    aiSessions += rows.reduce((a, r) => a + r.sessions, 0);
  }
  return { rows: rowsSaved, aiSessions, organic: organicState };
}

/* ───────────────────────────── Piwik PRO ───────────────────────────── */

async function piwikAll(creds: PiwikCredentials, columns: PiwikColumn[], from: string, to: string, filters?: Parameters<typeof piwikQuery>[1]["filters"]) {
  const out: Awaited<ReturnType<typeof piwikQuery>>["rows"] = [];
  const limit = 10_000;
  for (let offset = 0; offset < 200_000; offset += limit) {
    const res = await piwikQuery(creds, { columns, date_from: from, date_to: to, filters, limit, offset });
    out.push(...res.rows);
    if (res.rows.length < limit || out.length >= res.count) break;
  }
  return out;
}

/** Runs a Piwik PRO query with optional columns, dropping them (in order) when the account rejects them. */
async function piwikWithOptional(
  creds: PiwikCredentials,
  base: PiwikColumn[],
  optional: PiwikColumn[],
  from: string,
  to: string,
  filters?: Parameters<typeof piwikQuery>[1]["filters"],
): Promise<{ rows: Awaited<ReturnType<typeof piwikAll>>; columns: PiwikColumn[] }> {
  let extra = [...optional];
  for (;;) {
    const columns = [...base, ...extra];
    try {
      return { rows: await piwikAll(creds, columns, from, to, filters), columns };
    } catch (err) {
      // Some accounts reject event-scoped metrics (revenue, page views) next to session-scoped dimensions.
      if (!extra.length || !(err instanceof PiwikError)) throw err;
      extra = extra.slice(0, -1);
    }
  }
}

const colIndex = (columns: PiwikColumn[], id: string) => columns.findIndex((c) => c.column_id === id);

async function syncPiwik(projectId: string, target: string, creds: PiwikCredentials, range: SyncRange, ctx?: JobContext) {
  const windows = dateWindows(range.from, range.to, 90);
  const filters = {
    operator: "and" as const,
    conditions: [{ column_id: "source", condition: { operator: "matches", value: PIWIK_AI_SOURCE_REGEX } }],
  };
  const baseColumns: PiwikColumn[] = [
    { column_id: "timestamp", transformation_id: "to_date" },
    { column_id: "source" },
    { column_id: "session_entry_url", transformation_id: "to_path" },
    { column_id: "location_country_name" },
    { column_id: "sessions" },
    { column_id: "bounces" },
    { column_id: "session_total_time", transformation_id: "sum" },
    { column_id: "goal_conversions" },
    { column_id: "ecommerce_conversions" },
  ];
  // Optional metrics, dropped from the end when rejected (and not requested again in later windows).
  let optional: PiwikColumn[] = [
    { column_id: "revenue", transformation_id: "sum" },
    { column_id: "page_views" },
  ];
  let rowsSaved = 0;
  let aiSessions = 0;
  let organicState: OrganicState = { status: "ok", note: null };
  for (const [i, w] of windows.entries()) {
    if (ctx && (await ctx.isCancelled())) throw new SyncCancelledError();
    await ctx?.progress({ provider: "piwik_pro", step: "fetch", window: i + 1, windows: windows.length, from: w.from, to: w.to });
    const ai = await piwikWithOptional(creds, baseColumns, optional, w.from, w.to, filters);
    optional = ai.columns.slice(baseColumns.length);
    const revenueAt = colIndex(ai.columns, "revenue");
    const pageviewsAt = colIndex(ai.columns, "page_views");
    const agg = new Aggregator();
    for (const r of ai.rows) {
      const source = piwikCellLabel(r[1]);
      const platform = classifyAiSource(source);
      if (!platform) continue;
      const sessions = Number(r[4] ?? 0) || 0;
      const bounces = Number(r[5] ?? 0) || 0;
      const goals = Number(r[7] ?? 0) || 0;
      const orders = Number(r[8] ?? 0) || 0;
      agg.add({
        date: piwikCellLabel(r[0]).slice(0, 10),
        platform,
        page: normalizeLandingPage(piwikCellLabel(r[2])),
        country: normalizeCountry(piwikCellId(r[3])),
        sessions,
        engagedSessions: Math.max(0, sessions - bounces),
        convertedSessions: Math.min(sessions, goals + orders),
        conversions: goals + orders,
        revenue: revenueAt >= 0 ? Number(r[revenueAt] ?? 0) || 0 : 0,
        engagementSeconds: Number(r[6] ?? 0) || 0,
        users: sessions,
        pageviews: pageviewsAt >= 0 ? Number(r[pageviewsAt] ?? 0) || 0 : 0,
      });
    }
    const totalColumns: PiwikColumn[] = [
      { column_id: "timestamp", transformation_id: "to_date" },
      { column_id: "sessions" },
      { column_id: "goal_conversions" },
      { column_id: "ecommerce_conversions" },
    ];
    const totalsRes = await piwikWithOptional(creds, totalColumns, optional.filter((c) => c.column_id === "revenue"), w.from, w.to);
    const totalsRevenueAt = colIndex(totalsRes.columns, "revenue");
    const totals: DailyTotal[] = totalsRes.rows.map((r) => ({
      date: piwikCellLabel(r[0]).slice(0, 10),
      sessions: Number(r[1] ?? 0) || 0,
      conversions: (Number(r[2] ?? 0) || 0) + (Number(r[3] ?? 0) || 0),
      revenue: totalsRevenueAt >= 0 ? Number(r[totalsRevenueAt] ?? 0) || 0 : 0,
    }));
    // Organic search benchmark: sessions whose medium is "organic" (Piwik PRO's search-engine medium).
    let organic: OrganicDays = null;
    if (organicState.status !== "unsupported") {
      try {
        const org = await piwikWithOptional(
          creds,
          [
            { column_id: "timestamp", transformation_id: "to_date" },
            { column_id: "sessions" },
            { column_id: "bounces" },
            { column_id: "session_total_time", transformation_id: "sum" },
            { column_id: "goal_conversions" },
            { column_id: "ecommerce_conversions" },
          ],
          optional,
          w.from,
          w.to,
          { operator: "and", conditions: [{ column_id: "medium", condition: { operator: "matches", value: "^organic$" } }] },
        );
        const orgRevenueAt = colIndex(org.columns, "revenue");
        const orgPageviewsAt = colIndex(org.columns, "page_views");
        organic = org.rows
          .map((r): ChannelDayTotals => {
            const sessions = Number(r[1] ?? 0) || 0;
            const conversions = (Number(r[4] ?? 0) || 0) + (Number(r[5] ?? 0) || 0);
            return {
              date: piwikCellLabel(r[0]).slice(0, 10),
              sessions,
              engagedSessions: Math.max(0, sessions - (Number(r[2] ?? 0) || 0)),
              engagementSeconds: Number(r[3] ?? 0) || 0,
              pageviews: orgPageviewsAt >= 0 ? Number(r[orgPageviewsAt] ?? 0) || 0 : null,
              convertedSessions: Math.min(sessions, conversions),
              conversions,
              revenue: orgRevenueAt >= 0 ? Number(r[orgRevenueAt] ?? 0) || 0 : 0,
              users: sessions,
            };
          })
          .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date));
      } catch (err) {
        organicState =
          err instanceof PiwikError
            ? { status: "unsupported", note: `This Piwik PRO account can't segment sessions by medium (${organicError(err)}).` }
            : { status: "error", note: `Organic search totals could not be fetched: ${organicError(err)}` };
      }
    }
    const aggRows = agg.rows().filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
    await replaceRange(projectId, "piwik_pro", target, w.from, w.to, aggRows, totals.filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.date)), organic);
    rowsSaved += aggRows.length;
    aiSessions += aggRows.reduce((a, r) => a + r.sessions, 0);
  }
  return { rows: rowsSaved, aiSessions, organic: organicState };
}

/* ───────────────────────────── Entry point ───────────────────────────── */

function friendlyError(err: unknown, provider: TrafficProvider): { message: string; retry: boolean } {
  if (err instanceof GoogleReconnectRequiredError || err instanceof GoogleNotConfiguredError || err instanceof GoogleNotConnectedError)
    return { message: err.message, retry: false };
  if (provider === "google_analytics") {
    const message = googleApiErrorMessage(err, "ga4");
    const status = err instanceof IntegrationHttpError ? err.status : 0;
    return { message, retry: status === 0 || status === 429 || status >= 500 };
  }
  if (err instanceof MatomoError || err instanceof PiwikError || err instanceof UmamiError) return { message: err.message, retry: false };
  if (err instanceof IntegrationHttpError) {
    return {
      message: err.status === 401 || err.status === 403 ? "The credentials were rejected — check them in Settings." : err.message,
      retry: err.status === 0 || err.status === 429 || err.status >= 500,
    };
  }
  return { message: err instanceof Error ? err.message : String(err), retry: true };
}

/** Imports AI-referred sessions (and all-traffic totals) for a project from GA4, Matomo, Piwik PRO or Umami. */
export async function syncTraffic(payload: TrafficSyncPayload, ctx?: JobContext): Promise<unknown> {
  const { projectId, provider } = payload;
  const row = await getIntegration(projectId, provider);
  if (!row) return { skipped: "not_connected" };
  if (row.status === "pending") return { skipped: "pending" };
  const target = integrationTarget(provider, row.config);
  const started = Date.now();
  try {
    const cfg = row.config ?? {};
    const today = provider === "google_analytics" ? todayInTimeZone(typeof cfg.timeZone === "string" ? cfg.timeZone : null) : new Date().toISOString().slice(0, 10);
    // First sync since the organic benchmark shipped: re-import the whole window once so organic
    // search totals and AI page views cover the same history as the AI rows.
    const backfillOrganic = cfg.organicChannel === undefined && typeof cfg.syncedThrough === "string";
    const range = resolveRange({ full: payload.full || backfillOrganic, syncedThrough: cfg.syncedThrough, today });
    if (!range) return { skipped: "up_to_date" };
    let result: { rows: number; aiSessions: number; organic: OrganicState };
    if (provider === "google_analytics") {
      result = await syncGa4(projectId, target, cfg, range, ctx);
    } else if (provider === "matomo") {
      const creds = await getMatomoCredentials(projectId);
      if (!creds) throw new MatomoError("Matomo credentials are incomplete — edit them in Settings.");
      result = await syncMatomo(projectId, target, creds, range, ctx);
    } else if (provider === "umami") {
      const creds = await getUmamiCredentials(projectId);
      if (!creds) throw new UmamiError("Umami credentials are incomplete — edit them in Settings.");
      result = await syncUmami(projectId, target, creds, range, ctx);
    } else {
      const creds = await getPiwikCredentials(projectId);
      if (!creds) throw new PiwikError("Piwik PRO credentials are incomplete — edit them in Settings.");
      result = await syncPiwik(projectId, target, creds, range, ctx);
    }
    await markIntegrationSync(
      projectId,
      provider,
      {
        ok: true,
        config: {
          syncedThrough: range.to,
          lastSyncDays: daysBetween(range.from, range.to) + 1,
          organicChannel: result.organic.status,
          organicNote: result.organic.note,
        },
      },
      target,
    );
    return { ...result, from: range.from, to: range.to, ms: Date.now() - started };
  } catch (err) {
    // Cancelled or re-targeted mid-way: leave `syncedThrough` untouched so the gap is fetched next time.
    if (err instanceof SyncCancelledError) return { cancelled: true };
    if (err instanceof SyncTargetChangedError) return { skipped: "target_changed" };
    const { message, retry } = friendlyError(err, provider);
    await markIntegrationSync(projectId, provider, { ok: false, error: message }, target);
    if (!retry) return { error: message };
    throw new Error(message);
  }
}
