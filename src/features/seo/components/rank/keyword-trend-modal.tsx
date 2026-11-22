"use client";

import { useMemo, useState } from "react";
import { Copy, Download, Loader2 } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceArea, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { buildTsv } from "@/server/seo/lib/csv";
import { fileSafe } from "@/server/seo/lib/csv";
import { competitorEntry } from "@/server/seo/lib/serp";
import { SERP_FEATURE_LABELS } from "@/server/seo/lib/rank-tracking";
import type { SerpHostEntry } from "@/server/db/schema/seo";
import { getKeywordHistoryAction } from "../../actions/rank";
import { copyText, downloadCsv, unwrap } from "../../lib/client";
import { useSeoQuery } from "../../hooks/use-seo-query";
import { configLocationLabel, type ConfigLike } from "./rank-utils";
import { cn } from "@/lib/utils";
import { CanExport } from "@/components/app/export-menu";

const RANGES = [
  { key: "30", label: "30d", days: 30 },
  { key: "90", label: "90d", days: 90 },
  { key: "all", label: "All", days: 730 },
] as const;

/** Same as the "You" colour in AI Visibility. */
const OWN_COLOR = "var(--brand)";
const COLORS = { desktop: "#2563eb", mobile: "#14b8a6" } as const;

type HistoryPoint = { device: "desktop" | "mobile"; checkedAt: Date | string; position: number | null; url: string | null; serpHosts: Record<string, SerpHostEntry> | null };
type HistoryBrand = { key: string; name: string; domain: string; color: string };
type History = { points: HistoryPoint[]; brands: HistoryBrand[] };

/** Position-over-time for one keyword: inverted-Y line chart (1 on top) + per-check table. */
export function KeywordTrendModal({
  projectId,
  config,
  keyword,
  open,
  onOpenChange,
}: {
  projectId: string;
  config: ConfigLike;
  keyword: { id: string; keyword: string } | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("all");
  const days = RANGES.find((r) => r.key === range)!.days;
  const key = open && keyword ? `rank-history:${config.id}:${keyword.id}:${days}` : null;
  const { data: history, loading, error } = useSeoQuery<History>(
    key,
    async () => unwrap(await getKeywordHistoryAction(projectId, config.id, keyword!.id, days)),
    { staleMs: 60_000 },
  );
  const [brandDevice, setBrandDevice] = useState<"desktop" | "mobile">(config.devices === "mobile" ? "mobile" : "desktop");
  const depth = config.serpDepth;
  const brands = useMemo(() => history?.brands ?? [], [history]);
  const withBrands = brands.length > 0;
  const devices = config.devices === "both" ? (["desktop", "mobile"] as const) : ([config.devices] as const);
  // With competitors the chart shows own + competitor lines for one device; without, one line per device.
  const showDevice = config.devices === "both" && !withBrands;
  const data = useMemo(() => (history?.points ?? []).filter((p) => !withBrands || p.device === brandDevice), [history, withBrands, brandDevice]);
  const lines = useMemo(
    () =>
      withBrands
        ? [{ key: "own", label: config.domain, color: OWN_COLOR }, ...brands.map((b) => ({ key: b.key, label: b.name, color: b.color }))]
        : devices.map((d) => ({ key: d, label: d[0]!.toUpperCase() + d.slice(1), color: COLORS[d] })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [withBrands, brands, config.domain, config.devices],
  );
  const brandPos = (p: HistoryPoint, b: HistoryBrand) => (p.serpHosts ? (competitorEntry(p.serpHosts, b.domain)?.p ?? null) : undefined);

  const chartData = useMemo(
    () =>
      data.map((p) => {
        const row: Record<string, number | boolean | undefined> = { t: new Date(p.checkedAt).getTime() };
        if (withBrands) {
          row.own = p.position ?? depth;
          row.ownMissing = p.position == null;
          for (const b of brands) {
            const v = brandPos(p, b);
            row[b.key] = v === undefined ? undefined : (v ?? depth);
            row[`${b.key}Missing`] = v === null;
          }
        } else {
          row[p.device] = p.position ?? depth;
          row[`${p.device}Missing`] = p.position == null;
        }
        return row;
      }),
    [data, depth, withBrands, brands],
  );
  const latest = data.at(-1);

  /** Rows with Δ vs the previous check of the same device (positive = improved). */
  const tableRows = useMemo(() => {
    const prev: Record<string, number | null | undefined> = {};
    return data.map((p) => {
      const before = prev[p.device];
      prev[p.device] = p.position;
      let delta: string = "";
      if (before !== undefined) {
        if (before == null && p.position == null) delta = "";
        else if (before == null) delta = "new";
        else if (p.position == null) delta = "lost";
        else if (before - p.position !== 0) delta = `${before - p.position > 0 ? "+" : ""}${before - p.position}`;
        else delta = "0";
      }
      return { ...p, delta };
    });
  }, [data]);

  const showPos = (v: number | null | undefined) => (v === undefined ? "—" : (v ?? `Not in top ${depth}`));
  const headers = ["Date", ...(showDevice ? ["Device"] : []), withBrands ? config.domain : "Position", "Δ vs previous check", ...brands.map((b) => b.name)];
  const cells = tableRows.map((r) => [
    new Date(r.checkedAt).toISOString(),
    ...(showDevice ? [r.device] : []),
    r.position ?? `Not in top ${depth}`,
    r.delta,
    ...brands.map((b) => showPos(brandPos(r, b))),
  ]);

  const chartConfig: ChartConfig = Object.fromEntries(lines.map((l) => [l.key, { label: l.label, color: l.color }]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="pr-8">{keyword?.keyword}</DialogTitle>
          <DialogDescription>
            {config.domain} · {configLocationLabel(config)} · Position over time
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex rounded-lg bg-muted p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRange(r.key)}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium", range === r.key ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground")}
              >
                {r.label}
              </button>
            ))}
          </div>
          {withBrands && config.devices === "both" && (
            <div className="flex rounded-lg bg-muted p-0.5">
              {(["desktop", "mobile"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setBrandDevice(d)}
                  className={cn("rounded-md px-2.5 py-1 text-xs font-medium capitalize", brandDevice === d ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground")}
                >
                  {d}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" disabled={!cells.length} onClick={() => copyText(buildTsv(headers, cells), "Copied history")}>
              <Copy /> Copy
            </Button>
            <CanExport>
              <Button
                variant="outline"
                size="sm"
                disabled={!cells.length}
                onClick={() => downloadCsv(`rank-history-${fileSafe(config.domain)}-${fileSafe(keyword?.keyword ?? "keyword")}`, headers, cells)}
              >
                <Download /> Export CSV
              </Button>
            </CanExport>
          </div>
        </div>

        {loading && !history ? (
          <div className="flex h-56 items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : error ? (
          <p className="py-10 text-center text-sm text-destructive">{error}</p>
        ) : !chartData.length ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No checks in this range yet.</p>
        ) : (
          <>
            <ChartContainer config={chartConfig} className="aspect-auto h-60 w-full">
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="4 4" />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={28}
                  tickFormatter={(v: number) => new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                />
                <YAxis reversed domain={[1, depth]} allowDecimals={false} tickLine={false} axisLine={false} width={32} />
                <ReferenceArea
                  y1={Math.max(1, depth - Math.max(1, Math.round(depth * 0.06)))}
                  y2={depth}
                  fill="var(--muted-foreground)"
                  fillOpacity={0.08}
                  strokeOpacity={0}
                  label={{ value: `Not in top ${depth}`, position: "insideBottomRight", fontSize: 10, fill: "var(--muted-foreground)" }}
                />
                <ChartTooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const p = payload[0]!.payload as Record<string, number | boolean>;
                    return (
                      <div className="rounded-lg border bg-popover px-2.5 py-1.5 text-xs shadow-md">
                        <div className="mb-1 font-medium">{new Date(p.t as number).toLocaleDateString("en-US", { dateStyle: "medium" })}</div>
                        {lines.map((l) =>
                          p[l.key] != null ? (
                            <div key={l.key} className="flex items-center gap-1.5">
                              <span className="size-2 rounded-full" style={{ background: l.color }} />
                              <span>{l.label}</span>
                              <span className="ml-auto pl-3 font-medium tabular">{p[`${l.key}Missing`] ? `Not in top ${depth}` : `#${p[l.key]}`}</span>
                            </div>
                          ) : null,
                        )}
                      </div>
                    );
                  }}
                />
                {lines.map((l) => (
                  <Line key={l.key} dataKey={l.key} type="monotone" stroke={l.color} strokeWidth={l.key === "own" ? 2.5 : 2} connectNulls dot={{ r: 2.5 }} activeDot={{ r: 4 }} isAnimationActive={false} />
                ))}
              </LineChart>
            </ChartContainer>
            {withBrands && latest && (
              <ul className="grid gap-1.5 text-xs sm:grid-cols-2">
                {[{ key: "own", name: config.domain, color: OWN_COLOR, domain: config.domain }, ...brands].map((b) => {
                  const own = b.key === "own";
                  const e = own ? { p: latest.position, u: latest.url ?? undefined, f: undefined } : competitorEntry(latest.serpHosts, b.domain);
                  return (
                    <li key={b.key} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5">
                      <span className="size-2 shrink-0 rounded-full" style={{ background: b.color }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{b.name}</span>
                        {e?.u && (
                          <a href={e.u} target="_blank" rel="noreferrer" className="block truncate text-muted-foreground hover:underline">
                            {e.u.replace(/^https?:\/\/(www\.)?/, "")}
                          </a>
                        )}
                      </span>
                      {e?.f?.map((f) => (
                        <span key={f} className="shrink-0 rounded-full border px-1.5 py-px text-[10px] text-muted-foreground" title={f.replaceAll("_", " ")}>
                          {SERP_FEATURE_LABELS[f] ?? f.replaceAll("_", " ")}
                        </span>
                      ))}
                      <span className="shrink-0 font-semibold tabular">{e?.p != null ? `#${e.p}` : !own && !latest.serpHosts ? "—" : `>${depth}`}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="max-h-64 overflow-auto rounded-xl border">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-normal">Date</th>
                    {showDevice && <th className="px-3 py-2 font-normal">Device</th>}
                    <th className="px-3 py-2 text-right font-normal">{withBrands ? config.domain : "Position"}</th>
                    <th className="px-3 py-2 text-right font-normal">Δ vs previous check</th>
                    {brands.map((b) => (
                      <th key={b.key} className="px-3 py-2 text-right font-normal" style={{ borderTop: `2px solid ${b.color}` }}>
                        {b.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...tableRows].reverse().map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-1.5 tabular">{new Date(r.checkedAt).toLocaleDateString("en-US", { dateStyle: "medium" })}</td>
                      {showDevice && <td className="px-3 py-1.5 capitalize">{r.device}</td>}
                      <td className="px-3 py-1.5 text-right tabular">{r.position ?? <span className="text-muted-foreground">Not in top {depth}</span>}</td>
                      <td
                        className={cn(
                          "px-3 py-1.5 text-right tabular",
                          r.delta.startsWith("+") || r.delta === "new" ? "text-success" : r.delta.startsWith("-") || r.delta === "lost" ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {r.delta || "—"}
                      </td>
                      {brands.map((b) => (
                        <td key={b.key} className="px-3 py-1.5 text-right tabular">
                          {brandPos(r, b) ?? <span className="text-muted-foreground">{brandPos(r, b) === null ? `>${depth}` : "—"}</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
