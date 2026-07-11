import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { env } from "../config/env.js";

export type EngineLead = {
  name: string;
  address: string;
  city: string;
  country: string;
  query: string;
  niche: string;
  region: string;
  phone: string;
  email: string;
  website: string;
  instagram: string;
  facebook: string;
  contact_form: string;
  maps_link: string;
  rating: number | null;
  reviews: number;
  category: string;
  price_range: string;
  has_photos: boolean;
  has_popular_times: boolean;
  owner_responds_to_reviews: boolean;
  is_google_verified: boolean;
  multi_location: boolean;
  closed: boolean;
  ig_followers: number | null;
  ig_bio: string;
  ig_activity: string;
  ig_last_post_days: number | null;
  ig_legitimacy: number;
  tech_stack: Record<string, unknown>;
  score: number;
  quality: string;
  tier: string;
  action: string;
  fingerprints: string[];
  /** Phase 6 — chain/cannabis verdict from Part 1's own is_chain/is_cannabis */
  is_disqualified: boolean;
  [key: string]: unknown;
};

export type EngineQueryParams = {
  query: string;
  city: string;
  country?: string;
  niche?: string;
  region?: string;
  max_results?: number;
  max_ig_followers?: number;
  max_reviews?: number;
  min_score?: number;
  fast?: boolean;
  skip_ig?: boolean;
  skip_site_crawl?: boolean;
  require_viability?: boolean;
  db_path?: string;
};

export type EngineVerifyParams = {
  website?: string;
  instagram?: string;
  headless?: boolean;
};

export type EngineVerifyResult = {
  website_ok: boolean | null;
  website_data: {
    instagram?: string;
    facebook?: string;
    email?: string;
    contact_form?: string;
    phone?: string;
    tech_stack?: Record<string, unknown>;
  };
  instagram_ok: boolean | null;
  instagram_data: {
    followers?: number | null;
    posts?: number | null;
    bio?: string;
    last_post_days?: number | null;
    legitimacy_score?: number;
    private?: boolean;
    blocked?: boolean;
  };
};

/**
 * One-shot (non-streaming) call to `python service.py verify` — re-checks a
 * single already-known business's website/instagram directly, no Maps
 * search. Separate from runEngineQuery() because this is a single request/
 * response, not a stream of many results.
 */
export async function runEngineVerify(params: EngineVerifyParams, signal?: AbortSignal): Promise<EngineVerifyResult> {
  const enginePath = path.resolve(env.SCRAPER_ENGINE_PATH);

  const child = spawn("python3", ["service.py", "verify"], {
    cwd: enginePath,
    stdio: ["pipe", "pipe", "pipe"],
  });

  signal?.addEventListener("abort", () => child.kill("SIGTERM"));

  child.stdin.write(JSON.stringify(params));
  child.stdin.end();

  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    console.debug(`[scraper-bridge:verify] ${chunk.toString().trimEnd()}`);
  });

  const exitCode: number = await new Promise((resolve) => child.on("close", resolve));
  if (exitCode !== 0) {
    throw new Error(`verify subprocess exited with code ${exitCode}`);
  }

  return JSON.parse(stdout) as EngineVerifyResult;
}

/**
 * Spawns `python service.py` inside the Part 1 engine directory and streams
 * results back as they're discovered — one JSON object per stdout line.
 *
 * This is the entire integration surface with the Python engine. Nothing
 * upstream of this function (job handlers, routes) knows or cares that the
 * engine is Python; they just get an async iterator of lead objects.
 */
export async function* runEngineQuery(params: EngineQueryParams, signal?: AbortSignal): AsyncGenerator<EngineLead> {
  const enginePath = path.resolve(env.SCRAPER_ENGINE_PATH);

  const child = spawn("python3", ["service.py"], {
    cwd: enginePath,
    stdio: ["pipe", "pipe", "pipe"],
  });

  signal?.addEventListener("abort", () => child.kill("SIGTERM"));

  child.stdin.write(JSON.stringify(params));
  child.stdin.end();

  child.stderr.on("data", (chunk) => {
    // The engine logs verbosely to stderr via its own logger (get_logger) —
    // surface it as debug output rather than treating it as failure; only
    // a non-zero exit code is treated as an actual error, below.
    console.debug(`[scraper-bridge] ${chunk.toString().trimEnd()}`);
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  let readError: unknown = null;

  const lineIterator = (async function* () {
    for await (const line of rl) {
      if (!line.trim()) continue;
      yield line;
    }
  })();

  try {
    for await (const line of lineIterator) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        console.error(`[scraper-bridge] non-JSON line from engine, skipping: ${line.slice(0, 200)}`);
        continue;
      }

      if (parsed.__done__) {
        console.log(`[scraper-bridge] engine reported done, delivered=${parsed.delivered}`);
        continue;
      }

      yield parsed as EngineLead;
    }
  } catch (err) {
    readError = err;
    throw err;
  } finally {
    rl.close();
  }

  const exitCode: number = await new Promise((resolve) => child.on("close", resolve));
  if (exitCode !== 0 && !readError) {
    throw new Error(`scraper engine exited with code ${exitCode}`);
  }
}
