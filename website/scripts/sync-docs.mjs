// Builds docs pages from the repo's own markdown so the site never drifts from README/docs.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const out = new URL("../src/content/docs/", import.meta.url);
const GH = "https://github.com/notz/vizcite/blob/main/";
mkdirSync(out, { recursive: true });

// Serve the installer at vizcite.com/install.sh without keeping a second copy.
copyFileSync(new URL("deploy/install.sh", root), new URL("../public/install.sh", import.meta.url));

const read = (p) => readFileSync(new URL(p, root), "utf8");
// Relative repo links (../README.md#x, docs/X.md, CONTRIBUTING.md) become GitHub links.
const links = (md, from = "") =>
  md.replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_, href) => {
    const clean = href.replace(/^\.\.\//, "").replace(/^\.\//, "");
    return `](${GH}${from && !href.startsWith("../") ? from : ""}${clean})`;
  });
const page = (name, title, body) =>
  writeFileSync(new URL(name, out), `---\ntitle: ${title}\n---\n\n${body}\n`);
const stripH1 = (md) => md.replace(/^# .*\n/, "");

page("self-hosting.md", "Self-hosting", links(stripH1(read("docs/SELF_HOSTING.md")), "docs/"));
page("changelog.md", "Changelog", stripH1(read("CHANGELOG.md")));
page("contributing.md", "Contributing", links(stripH1(read("CONTRIBUTING.md"))));

const readme = read("README.md");
const m = readme.match(/## Integrations\n([\s\S]*?)\n## /);
if (!m) throw new Error("README.md has no '## Integrations' section");
page("integrations.md", "Integrations", links(m[1]));
