import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { passthroughImageService } from "astro/config";

export default defineConfig({
  site: "https://vizcite.com",
  image: { service: passthroughImageService() }, // no native sharp build step needed in CI
  // postcss (bundled by Starlight) default-imports nanoid, which fails as an external under Node ESM.
  vite: { ssr: { noExternal: ["nanoid"] } },
  integrations: [
    starlight({
      title: "Vizcite",
      description: "Open-source AI SEO & GEO platform. Self-host it for free.",
      logo: { src: "./public/favicon.svg" },
      favicon: "/favicon.svg",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/notz/vizcite" },
        { icon: "comment-alt", label: "Discussions", href: "https://github.com/notz/vizcite/discussions" },
      ],
      sidebar: [
        { label: "Start", items: ["self-hosting", "integrations"] },
        { label: "Project", items: ["changelog", "contributing"] },
      ],
    }),
  ],
});
