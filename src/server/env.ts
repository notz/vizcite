import "server-only";
import fs from "node:fs";
import path from "node:path";

/**
 * The only environment configuration the app reads. Everything else is stored in the
 * database and edited in the admin panel.
 */
function normalizeDomain(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "localhost:3000";
  return value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

const domain = normalizeDomain(
  process.env.DOMAIN || process.env.APP_DOMAIN,
);

/** Build metadata written by the Dockerfile (commit + date) — drives local agent auto-updates. */
function readBuildInfo(): { commit?: string; date?: string } {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "build-info.json"), "utf8"));
  } catch {
    return {};
  }
}
const buildInfo = readBuildInfo();

const isLocal = /^(localhost|127\.0\.0\.1|\[::1\]|[^.]+\.localhost|.+\.test)(:\d+)?$/.test(domain);

export const env = {
  domain,
  /** Public base URL, e.g. https://seo.example.com (no trailing slash). */
  appUrl: process.env.APP_URL?.replace(/\/+$/, "") ?? `${isLocal ? "http" : "https"}://${domain}`,
  isLocal,
  isProduction: process.env.NODE_ENV === "production",
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://vizcite:vizcite@localhost:54329/vizcite",
  dataDir: process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
  /** Build metadata injected at image build time (used for agent auto-update). */
  buildCommit: process.env.BUILD_COMMIT || buildInfo.commit || "dev",
  buildDate: process.env.BUILD_DATE || buildInfo.date || new Date(0).toISOString(),
  /** Optional bootstrap values for unattended installs. The admin panel always wins once configured. */
  bootstrap: {
    ownerEmail: process.env.VIZCITE_OWNER_EMAIL?.trim() || null,
    ownerName: process.env.VIZCITE_OWNER_NAME?.trim() || null,
    workspaceName: process.env.VIZCITE_WORKSPACE_NAME?.trim() || null,
    smtpUrl: process.env.VIZCITE_SMTP_URL?.trim() || null,
    mailFrom: process.env.VIZCITE_MAIL_FROM?.trim() || null,
  },
};

