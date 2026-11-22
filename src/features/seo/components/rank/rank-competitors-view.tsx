"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { BarChart3, LineChart, Loader2, Swords } from "lucide-react";
import { Panel } from "@/components/app/page";
import { DataTable, type Column } from "@/components/app/data-table";
import { BarsChart, TrendChart, type ValueFormat } from "@/components/app/charts";
import { EmptyState } from "@/components/app/empty-state";
import { SearchInput } from "@/components/app/filters";
import { formatCompact } from "@/components/app/metrics";
import { YouBadge } from "@/features/ai-insights/components/brand";
import type { CompetitorPosition, RankBrand, RankTrackingRow } from "@/server/seo/rank-tracking";
import { changeCell, type CompetitorMetric, type ComparePeriod } from "@/server/seo/lib/rank-tracking";
import { fileSafe, type Cell } from "@/server/seo/lib/csv";
import { getRankCompetitorDataAction } from "../../actions/rank";
import { unwrap } from "../../lib/client";
import { useSeoQuery } from "../../hooks/use-seo-query";
import { ExportMenu } from "../shared/export-menu";
import { DeviceRankCell } from "./rank-table";
import type { ConfigLike } from "./rank-utils";
import { cn } from "@/lib/utils";

type Device = "desktop" | "mobile";

const METRICS: { key: CompetitorMetric; label: string; format: ValueFormat; /** lower is better */ invert?: boolean; hint: string }[] = [
  { key: "visibility", label: "Visibility", format: "percent", hint: "Estimated share of available clicks: Σ(volume × CTR at the position) ÷ (Σ volume × 28%)." },
  { key: "avgPosition", label: "Avg. position", format: "decimal", invert: true, hint: "Average position over the keywords the domain ranks for." },
  { key: "top3", label: "Top 3", format: "number", hint: "Keywords ranking in positions 1–3." },
  { key: "top10", label: "Top 10", format: "number", hint: "Keywords ranking in positions 1–10." },
];

const formatValue = (m: (typeof METRICS)[number], v: number | null) => (v == null ? "—" : m.format === "percent" ? `${v.toFixed(1)}%` : m.format === "decimal" ? v.toFixed(1) : String(v));

/** Own value uses the same badge as the Overview table; competitors without a stored comparison show the plain position. */
function PositionCell({ pos }: { pos: CompetitorPosition | undefined }) {
  if (!pos) return <span className="text-muted-foreground">-</span>;
  if (pos.previousPosition === undefined) return pos.position != null ? <span className="font-semibold tabular">{pos.position}</span> : <span className="text-muted-foreground">-</span>;
  return <DeviceRankCell result={{ position: pos.position, previousPosition: pos.previousPosition, rankingUrl: null, serpFeatures: [], source: "dataforseo" }} />;
}

/** Competitors tab: metric chart + ranked legend, and the keyword table with one position (+ change) column per brand, own first. */
export function RankCompetitorsView({
  projectId,
  config,
  rows,
  device,
  compare,
  version,
  onKeywordClick,
}: {
  projectId: string;
  config: ConfigLike;
  rows: RankTrackingRow[];
  device: Device;
  compare: ComparePeriod;
  /** Bumped after a check finishes so the data refetches. */
  version: number;
  onKeywordClick: (row: RankTrackingRow) => void;
}) {
  const [metric, setMetric] = useState<CompetitorMetric>("visibility");
  const [chart, setChart] = useState<"line" | "bar">("line");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const { data, loading, error } = useSeoQuery(
    `rank-competitors:${config.id}:${device}:${compare}:${version}`,
    async () => unwrap(await getRankCompetitorDataAction(projectId, config.id, device, compare)),
    { staleMs: 60_000 },
  );

  const m = METRICS.find((x) => x.key === metric)!;
  const brands = useMemo(() => data?.brands ?? [], [data]);
  const ranked = useMemo(() => {
    if (!data) return [];
    const dir = m.invert ? 1 : -1;
    return [...brands].sort((a, b) => {
      const av = data.latest[a.key]?.[metric] ?? null;
      const bv = data.latest[b.key]?.[metric] ?? null;
      if (av == null) return 1;
      if (bv == null) return -1;
      return dir * (av - bv);
    });
  }, [data, brands, metric, m.invert]);
  const shown = ranked.filter((b) => !hidden.has(b.key));
  const series = shown.map((b) => ({ key: b.key, label: b.name, color: b.color }));

  const posById = useMemo(() => new Map((data?.rows ?? []).map((r) => [r.trackingKeywordId, r.positions])), [data]);
  const needle = q.trim().toLowerCase();
  const tableRows = rows.filter((r) => !needle || r.keyword.toLowerCase().includes(needle));

  if (loading && !data)
    return (
      <Panel>
        <div className="flex h-56 items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      </Panel>
    );
  if (error || !data)
    return (
      <Panel>
        <p className="py-10 text-center text-sm text-destructive">{error ?? "Could not load competitor data."}</p>
      </Panel>
    );
  if (brands.length < 2)
    return (
      <Panel>
        <EmptyState
          icon={Swords}
          title="No competitors to compare yet"
          description={
            data.skippedNoDomain.length
              ? `Add a domain to ${data.skippedNoDomain.join(", ")} so its positions can be matched in the search results.`
              : "Add the brands you compete with, including their domain. They are shared with AI Visibility."
          }
          action={
            <Link href={`/p/${projectId}/ai/competitors`} className="text-sm font-medium underline">
              Manage competitors
            </Link>
          }
        />
      </Panel>
    );

  const lineRows = data.dates.map((d, i) => {
    const row: Record<string, unknown> = { date: d };
    for (const b of shown) row[b.key] = data.series[b.key]?.[metric][i] ?? null;
    return row;
  });
  const barRows = [{ slice: m.label, ...Object.fromEntries(shown.map((b) => [b.key, data.latest[b.key]?.[metric] ?? null])) }];

  const columns: Column<RankTrackingRow>[] = [
    {
      id: "keyword",
      header: "Keyword",
      sortValue: (r) => r.keyword,
      cell: (r) => (
        <button type="button" onClick={() => onKeywordClick(r)} className="flex max-w-[22rem] items-center gap-1.5 text-left font-medium hover:underline">
          <span className="truncate">{r.keyword}</span>
        </button>
      ),
    },
    { id: "volume", header: "Volume", align: "right", hideBelow: "md", sortValue: (r) => r.searchVolume, cell: (r) => (r.searchVolume != null ? formatCompact(r.searchVolume) : "-") },
    ...brands.map<Column<RankTrackingRow>>((b) => ({
      id: b.key,
      header: <BrandHead brand={b} />,
      align: "center",
      sortValue: (r) => posById.get(r.trackingKeywordId)?.[b.key]?.position,
      cell: (r) => <PositionCell pos={posById.get(r.trackingKeywordId)?.[b.key]} />,
    })),
  ];

  const exportData = () => ({
    headers: ["Keyword", "Volume", ...brands.flatMap((b) => [`${b.name} Position`, `${b.name} Change`])],
    rows: tableRows.map((r): Cell[] => [
      r.keyword,
      r.searchVolume ?? "",
      ...brands.flatMap((b): Cell[] => {
        const p = posById.get(r.trackingKeywordId)?.[b.key];
        return [p?.position ?? "", p && p.previousPosition !== undefined ? changeCell(p.position, p.previousPosition) : ""];
      }),
    ]),
    filename: `rank-competitors-${fileSafe(config.domain)}`,
  });

  return (
    <div className="space-y-4">
      {!data.hasCompetitorData && (
        <div className="rounded-xl border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          Competitor positions are read from the search results of each check. Run a check to see them — checks made before this feature have no competitor data.
        </div>
      )}
      {data.skippedNoDomain.length > 0 && (
        <div className="rounded-xl border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          {data.skippedNoDomain.join(", ")} {data.skippedNoDomain.length === 1 ? "has" : "have"} no domain and can&apos;t be matched.{" "}
          <Link href={`/p/${projectId}/ai/competitors`} className="font-medium underline">
            Add a domain
          </Link>
        </div>
      )}

      <Panel contentClassName="p-0 sm:p-0">
        <div className="flex flex-col gap-2 border-b px-3 pt-2 sm:flex-row sm:items-center sm:px-4">
          <nav className="scrollbar-none -mb-px flex min-w-0 flex-1 gap-1 overflow-x-auto">
            {METRICS.map((t) => (
              <button
                key={t.key}
                type="button"
                title={t.hint}
                onClick={() => setMetric(t.key)}
                className={cn(
                  "shrink-0 border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors",
                  t.key === metric ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="flex rounded-lg bg-muted p-0.5 pb-0.5 sm:mb-2">
            {[
              { k: "line", icon: LineChart, label: "Line chart" },
              { k: "bar", icon: BarChart3, label: "Bar chart" },
            ].map(({ k, icon: Icon, label }) => (
              <button
                key={k}
                type="button"
                aria-label={label}
                title={label}
                onClick={() => setChart(k as "line" | "bar")}
                className={cn("rounded-md p-1.5", chart === k ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground")}
              >
                <Icon className="size-3.5" />
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-4 p-3 sm:p-5 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-w-0">
            {data.dates.length === 0 ? (
              <EmptyState compact title="No completed checks yet" description="Run a full check to see the trend." />
            ) : chart === "line" ? (
              <TrendChart data={lineRows} series={series} type="line" format={m.format} domain={m.invert ? ["auto", "auto"] : [0, "auto"]} reversed={m.invert} height={320} />
            ) : (
              <BarsChart data={barRows} series={series} xKey="slice" format={m.format} height={320} xFormatter={(v) => v} />
            )}
          </div>
          <ol className="space-y-0.5 lg:border-l lg:pl-4">
            {ranked.map((b, i) => {
              const off = hidden.has(b.key);
              return (
                <li key={b.key}>
                  <button
                    type="button"
                    onClick={() => {
                      const next = new Set(hidden);
                      if (off) next.delete(b.key);
                      else next.add(b.key);
                      setHidden(next);
                    }}
                    className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted", off && "opacity-40")}
                  >
                    <span className="w-4 text-xs text-muted-foreground tabular">{i + 1}</span>
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: b.color }} />
                    <span className="min-w-0 flex-1 truncate">{b.name}</span>
                    {b.isOwn && <YouBadge />}
                    <span className="text-xs font-medium tabular">{formatValue(m, data.latest[b.key]?.[metric] ?? null)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      </Panel>

      <Panel
        title="Keyword positions"
        description={`${device === "desktop" ? "Desktop" : "Mobile"} · change vs. the selected comparison period`}
        actions={
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Filter keywords…" className="sm:w-56" />
            <ExportMenu getData={exportData} disabled={tableRows.length === 0} />
          </>
        }
        contentClassName="p-0 sm:p-0"
      >
        <DataTable
          key={device}
          columns={columns}
          data={tableRows}
          getRowId={(r) => r.trackingKeywordId}
          initialSort={{ id: "own", dir: "asc" }}
          paginate={tableRows.length > 100}
          pageSize={100}
          dense
          empty={<EmptyState compact title={rows.length ? "No keywords match your search." : "No rank data yet"} />}
          mobileCard={(r) => (
            <div className="space-y-2">
              <button type="button" onClick={() => onKeywordClick(r)} className="text-left font-medium">
                {r.keyword}
              </button>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {brands.map((b) => (
                  <div key={b.key} className="flex items-center justify-between gap-2 rounded-lg bg-muted/60 px-2 py-1.5">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="size-2 shrink-0 rounded-full" style={{ background: b.color }} />
                      <span className="truncate">{b.name}</span>
                    </span>
                    <PositionCell pos={posById.get(r.trackingKeywordId)?.[b.key]} />
                  </div>
                ))}
              </div>
            </div>
          )}
        />
      </Panel>
    </div>
  );
}

function BrandHead({ brand }: { brand: RankBrand }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2 shrink-0 rounded-full" style={{ background: brand.color }} />
      <span className="max-w-28 truncate">{brand.name}</span>
      {brand.isOwn && <YouBadge />}
    </span>
  );
}
