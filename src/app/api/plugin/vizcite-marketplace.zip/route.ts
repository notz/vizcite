import { marketplaceBundleZip } from "@/server/api/plugin";
import { pluginInstance, zipResponse } from "@/server/api/plugin-http";

/**
 * GET /api/plugin/vizcite-marketplace.zip — a local marketplace root (Claude Code, Codex and Cursor
 * manifests + plugins/vizcite), e.g. `codex plugin marketplace add ./vizcite-marketplace`.
 */
export async function GET() {
  const { zip, sha256 } = marketplaceBundleZip(await pluginInstance());
  return zipResponse(zip, "vizcite-marketplace.zip", sha256);
}
