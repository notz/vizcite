import { skillsZip } from "@/server/api/plugin";
import { zipResponse } from "@/server/api/plugin-http";

/** GET /api/plugin/skills.zip — every Vizcite skill as vizcite-skills/<name>/SKILL.md. */
export async function GET() {
  const { zip, sha256 } = skillsZip();
  return zipResponse(zip, "vizcite-skills.zip", sha256);
}
