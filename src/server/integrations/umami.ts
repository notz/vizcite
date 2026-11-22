import "server-only";
import { PROVIDERS } from "@/lib/integrations-catalog";
import { getIntegration, readSecret } from "./store";
import { httpText, IntegrationHttpError } from "./http";

export type UmamiCredentials = { url: string; websiteId: string; apiKey: string; currency: string };

export class UmamiError extends Error {}

const CLOUD_API = "https://api.umami.is/v1";

/** API base for the configured instance: empty / umami.is → Cloud, anything else → `<url>/api` (self-hosted). */
export function umamiBase(url: string): { base: string; cloud: boolean } {
  const raw = url.trim();
  if (!raw) return { base: CLOUD_API, cloud: true };
  const u = new URL(raw);
  if (u.hostname === "api.umami.is" || u.hostname === "cloud.umami.is") return { base: CLOUD_API, cloud: true };
  const path = u.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return { base: `${u.origin}${path}/api`, cloud: false };
}

/** Request headers: Cloud documents `x-umami-api-key`, self-hosted a Bearer token — Cloud accepts both. */
export function umamiHeaders(apiKey: string, cloud: boolean): Record<string, string> {
  return cloud ? { "x-umami-api-key": apiKey, Authorization: `Bearer ${apiKey}` } : { Authorization: `Bearer ${apiKey}` };
}

// Umami Cloud allows 50 calls / 15 s per key: space the requests (self-hosted has no limit).
const CLOUD_GAP_MS = 320;
const nextSlot = new Map<string, number>();
async function throttle(key: string) {
  const at = Math.max(nextSlot.get(key) ?? 0, Date.now());
  nextSlot.set(key, at + CLOUD_GAP_MS);
  const wait = at - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** GET on the Umami API. The key is sent as a header only; user-supplied URL → SSRF-protected request. */
export async function umamiGet<T = unknown>(
  creds: UmamiCredentials,
  path: string,
  params: Record<string, string | number> = {},
  timeoutMs = 60_000,
): Promise<T> {
  const { base, cloud } = umamiBase(creds.url);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  if (cloud) await throttle(creds.apiKey.slice(0, 12));
  const { text } = await httpText(`${base}${path}${qs.size ? `?${qs}` : ""}`, {
    headers: umamiHeaders(creds.apiKey, cloud),
    untrusted: true,
    timeoutMs,
  });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UmamiError("Umami returned an unexpected response — is the URL correct?");
  }
}

export async function testUmamiConnection(creds: UmamiCredentials): Promise<string> {
  try {
    const site = await umamiGet<{ name?: string; domain?: string }>(creds, `/websites/${encodeURIComponent(creds.websiteId)}`, {}, 20_000);
    if (!site?.name) throw new UmamiError("Website not found or the API key has no access to it.");
    return `Connected to “${site.name}” (${site.domain ?? "no domain"}).`;
  } catch (err) {
    if (err instanceof IntegrationHttpError && (err.status === 401 || err.status === 403)) throw new UmamiError("Umami rejected the API key.");
    if (err instanceof IntegrationHttpError && err.status === 404) throw new UmamiError("Website not found — check the website ID and URL.");
    throw err;
  }
}

export async function getUmamiCredentials(projectId: string): Promise<UmamiCredentials | null> {
  const row = await getIntegration(projectId, PROVIDERS.umami);
  if (!row) return null;
  const secret = readSecret<{ apiKey?: string }>(row);
  const url = typeof row.config.url === "string" ? row.config.url : "";
  const websiteId = row.config.websiteId != null ? String(row.config.websiteId) : "";
  const currency = (typeof row.config.currency === "string" && row.config.currency ? row.config.currency : "EUR").toUpperCase();
  if (!websiteId || !secret?.apiKey) return null;
  return { url, websiteId, apiKey: secret.apiKey, currency };
}
