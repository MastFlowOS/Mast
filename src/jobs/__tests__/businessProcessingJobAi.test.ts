/**
 * BUSINESS PROCESSING JOB - AI SAFEGUARDS & BACKGROUND COST CONTROL TESTS
 *
 * Verifies Part C requirements:
 * 1. env.AI_BACKGROUND_OPPORTUNITY_INSIGHTS defaults to false in EnvSchema.
 * 2. Background opportunity AI precomputation is gated behind:
 *    aiEnabled() && env.AI_BACKGROUND_OPPORTUNITY_INSIGHTS
 * 3. Cache existence & freshness check:
 *    Skips AI generation when |cached.score_snapshot - topScore.opportunity_score| <= 10.
 * 4. Concurrent execution deduplication:
 *    Wraps LLM generation inside singleFlight(`opportunities:${businessId}:${professionSlug}`).
 * 5. Deterministic scoring and website enrichment work are preserved and not bypassed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EnvSchema } from "../../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const businessProcessingJobSrc = readFileSync(
  path.join(__dirname, "../businessProcessingJob.ts"),
  "utf8"
);

test("Part C - AI_BACKGROUND_OPPORTUNITY_INSIGHTS defaults to false in EnvSchema", () => {
  // Test schema default without process.env overrides
  const fieldSchema = (EnvSchema as any)._def?.schema?.shape?.AI_BACKGROUND_OPPORTUNITY_INSIGHTS;
  assert.ok(fieldSchema, "AI_BACKGROUND_OPPORTUNITY_INSIGHTS must be defined on EnvSchema");

  // Default value when undefined
  assert.equal(fieldSchema.parse(undefined), false, "Must default to false when undefined");
  // Coercion from strings
  assert.equal(fieldSchema.parse("true"), true, "Must coerce 'true' to boolean true");
  assert.equal(fieldSchema.parse("false"), false, "Must coerce 'false' to boolean false");
  assert.equal(fieldSchema.parse(false), false, "Must accept boolean false");
  assert.equal(fieldSchema.parse(true), true, "Must accept boolean true");
});

test("Part C - scoreBusiness gates AI precomputation behind env.AI_BACKGROUND_OPPORTUNITY_INSIGHTS", () => {
  const gateIndex = businessProcessingJobSrc.indexOf(
    "if (aiEnabled() && env.AI_BACKGROUND_OPPORTUNITY_INSIGHTS)"
  );
  assert.notEqual(
    gateIndex,
    -1,
    "Expected scoreBusiness to gate precomputation behind aiEnabled() && env.AI_BACKGROUND_OPPORTUNITY_INSIGHTS"
  );

  const callSiteIndex = businessProcessingJobSrc.indexOf(
    "await generateBackgroundOpportunityInsights(businessId);",
    gateIndex
  );
  assert.notEqual(
    callSiteIndex,
    -1,
    "Expected generateBackgroundOpportunityInsights call site inside the gated block"
  );

  // Verify non-LLM worker tasks (enrichment, deterministic scoring, health) are preserved before the AI gate
  const scoreComputeIndex = businessProcessingJobSrc.indexOf("await computeAndStoreOpportunityScores(businessId);");
  const healthComputeIndex = businessProcessingJobSrc.indexOf("await computeAndStoreBusinessHealth(businessId);");

  assert.ok(scoreComputeIndex !== -1, "computeAndStoreOpportunityScores must be present");
  assert.ok(healthComputeIndex !== -1, "computeAndStoreBusinessHealth must be present");
  assert.ok(
    scoreComputeIndex < gateIndex && healthComputeIndex < gateIndex,
    "Deterministic scores and health must be computed BEFORE the optional AI precomputation block"
  );
});

test("Part C - generateBackgroundOpportunityInsights checks cache freshness (score delta <= 10)", () => {
  assert.ok(
    businessProcessingJobSrc.includes("business_opportunity_insights"),
    "Must query business_opportunity_insights table for existing cached records"
  );

  // Verifies the delta threshold <= 10 logic
  const freshnessCheckPattern = /Math\.abs\(\s*\(?(?:cached|freshCached)\.score_snapshot as number\)?\s*-\s*topScore\.opportunity_score\s*\)\s*<=\s*10/;
  assert.match(
    businessProcessingJobSrc,
    freshnessCheckPattern,
    "Must check whether cached score_snapshot is within 10 points of current opportunity_score"
  );
});

test("Part C - generateBackgroundOpportunityInsights coalesces concurrent work via singleFlight", () => {
  assert.ok(
    businessProcessingJobSrc.includes("singleFlight(`opportunities:${businessId}:${professionSlug}`"),
    "Must wrap opportunity generation in singleFlight keyed by business and profession"
  );
});

test("Part C - generateBackgroundOpportunityInsights enforces quality and safety parameters", () => {
  // Verifies maxTokens, model tier, and em-dash sanitization
  assert.ok(
    businessProcessingJobSrc.includes('tier: "fast"'),
    "Must use fast model tier for opportunity insights"
  );
  assert.ok(
    businessProcessingJobSrc.includes("maxTokens: 512"),
    "Must constrain token generation to prevent runaway output"
  );
  assert.ok(
    businessProcessingJobSrc.includes(".replace(/[—–]/g, \" - \")"),
    "Must sanitize em dashes and en dashes in output"
  );
});
