/**
 * /sitemap.xml
 *
 * Previously used @tanstack/react-start server handlers (SSR-only API).
 * MAST is now a pure Vite SPA on Netlify — there are no server routes.
 *
 * Replaced with a static sitemap.xml in /public/sitemap.xml.
 * This file is kept to satisfy the routeTree.gen.ts import but does nothing.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sitemap.xml")({
  component: () => null,
});
