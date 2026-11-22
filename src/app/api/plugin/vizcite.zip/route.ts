import { pluginZip } from "@/server/api/plugin";
import { pluginInstance, zipResponse } from "@/server/api/plugin-http";

/** GET /api/plugin/vizcite.zip — the plugin root, pre-configured with this instance's MCP URL. */
export async function GET() {
  const { zip, sha256 } = pluginZip(await pluginInstance());
  return zipResponse(zip, "vizcite-plugin.zip", sha256);
}
