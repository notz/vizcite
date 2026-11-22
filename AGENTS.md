<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Demo data

The demo project generator (`src/server/ai/demo/`, modules in `src/server/ai/demo/modules/`, CLI in `cli.ts`) fills every feature with sample data for screenshots and the "Load demo project" action. When you add or change a feature that stores or shows data (new table or column, new metric, chart, report or page), update the matching demo module in the same change so the demo project shows realistic values for it, and check it by regenerating a demo project (`cli.ts --regenerate=<projectId>`). Demo data must stay fictional: no real brands, people or customer data.
