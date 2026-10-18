import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export function validateSupabaseEnv(rootDir = process.cwd()) {
  // Load environment following Vite precedence
  const envLocalPath = path.join(rootDir, ".env.local");
  const envPath = path.join(rootDir, ".env");

  const env = { ...process.env };

  if (fs.existsSync(envPath)) {
    const parsed = dotenv.parse(fs.readFileSync(envPath));
    Object.assign(env, parsed);
  }
  if (fs.existsSync(envLocalPath)) {
    const parsedLocal = dotenv.parse(fs.readFileSync(envLocalPath));
    Object.assign(env, parsedLocal);
  }

  const url = env.VITE_SUPABASE_URL;
  const anonKey = env.VITE_SUPABASE_ANON_KEY;

  const issues = [];

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
    issues.push("VITE_SUPABASE_ANON_KEY contains a private service-role secret key (sb_secret_...). Only public anon/publishable keys are permitted.");
  }

  const apiUrl = env.VITE_API_BASE_URL;
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

  return {
    valid: issues.length === 0,
    issues,
    url: url ? url.replace(/:(\d+)/, "") : undefined,
    apiUrl,
    anonKeyLength: anonKey ? anonKey.length : 0,
  };
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith("validate-env.mjs")) {
  const result = validateSupabaseEnv();
  if (!result.valid) {
    console.error(`\n\x1b[31m[BUILD VALIDATION ERROR] Supabase environment configuration is invalid:\x1b[0m`);
    for (const issue of result.issues) {
      console.error(`  \x1b[31m•\x1b[0m ${issue}`);
    }
    console.error(`\n\x1b[33mPlease configure valid credentials in .env or .env.local before building.\x1b[0m\n`);
    process.exit(1);
  } else {
    console.log(`\x1b[32m[BUILD VALIDATION] Supabase environment configuration is valid (URL: ${result.url}, Key length: ${result.anonKeyLength})\x1b[0m`);
    process.exit(0);
  }
}
