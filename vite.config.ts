import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

function supabaseEnvValidator(): Plugin {
  return {
    name: "vite-plugin-supabase-env-validator",
    configResolved(config) {
      if (config.command !== "build") return;
      const env = loadEnv(config.mode, process.cwd(), "");
      const url = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
      const anonKey = env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

      const issues: string[] = [];
      if (!url) {
        issues.push("VITE_SUPABASE_URL is missing.");
      } else if (
        url.includes("placeholder.supabase.co") ||
        url.includes("your-project.supabase.co") ||
        url.includes("example.supabase.co")
      ) {
        issues.push(`VITE_SUPABASE_URL contains placeholder domain: "${url}"`);
      } else {
        try {
          const parsed = new URL(url);
          if (!parsed.protocol.startsWith("http")) {
            issues.push(`VITE_SUPABASE_URL must use http or https protocol: "${url}"`);
          }
        } catch {
          issues.push(`VITE_SUPABASE_URL is not a valid URL: "${url}"`);
        }
      }

      if (!anonKey) {
        issues.push("VITE_SUPABASE_ANON_KEY is missing.");
      } else if (
        anonKey.includes("placeholder") ||
        anonKey.includes("your-anon-key") ||
        anonKey.length < 20
      ) {
        issues.push("VITE_SUPABASE_ANON_KEY contains a placeholder or dummy value.");
      } else if (anonKey.startsWith("sb_secret_")) {
        issues.push(
          "VITE_SUPABASE_ANON_KEY contains a private service-role secret key (sb_secret_...). Only public anon/publishable keys are permitted."
        );
      }

      const apiUrl = env.VITE_API_BASE_URL || process.env.VITE_API_BASE_URL;
      if (!apiUrl) {
        issues.push("VITE_API_BASE_URL is missing.");
      } else if (
        apiUrl.includes("placeholder") ||
        apiUrl.includes("your-mast-backend") ||
        apiUrl.includes("example.com")
      ) {
        issues.push(`VITE_API_BASE_URL contains placeholder domain: "${apiUrl}"`);
      } else {
        try {
          const parsed = new URL(apiUrl);
          if (!parsed.protocol.startsWith("http")) {
            issues.push(`VITE_API_BASE_URL must use http or https protocol: "${apiUrl}"`);
          }
        } catch {
          issues.push(`VITE_API_BASE_URL is not a valid URL: "${apiUrl}"`);
        }
      }

      if (issues.length > 0) {
        throw new Error(
          `\n\n[BUILD CONFIG ERROR] Cannot build with invalid environment:\n` +
            issues.map((i) => `  • ${i}`).join("\n") +
            `\n\nConfigure valid credentials in .env or .env.local.\n`
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [
    supabaseEnvValidator(),
    TanStackRouterVite({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
    tsconfigPaths(),
  ],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          router: ["@tanstack/react-router"],
          query: ["@tanstack/react-query"],
          radix: [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-popover",
            "@radix-ui/react-select",
            "@radix-ui/react-tabs",
            "@radix-ui/react-tooltip",
          ],
        },
      },
    },
  },
});
