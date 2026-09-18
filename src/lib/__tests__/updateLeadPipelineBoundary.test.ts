import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

/**
 * Regression coverage for the pipeline-capability boundary bug (see audit).
 *
 * `updateLead()` used to gate any status other than the stale
 * `["new", "ready"]` whitelist behind `enforceCapability("pipeline")`,
 * which broke ordinary Free/Starter CRM actions (status changes, Mark
 * Sent, Mark Called) — `updateLead()` is a general-purpose lead
 * data-access function used by every plan, not a Pipeline-only endpoint.
 *
 * These are source-contract checks rather than a live import of api.ts /
 * dashboard.pipeline.tsx: this repo's `tsx --test` harness has no
 * Vite-aware shim for `import.meta.env`, which both files read at module
 * scope (confirmed no existing test in this repo imports `src/lib/api.ts`
 * either), so a real runtime import isn't viable without adding new test
 * infrastructure. Extracting and asserting on the exact function bodies
 * still fails loudly the moment either invariant regresses.
 */

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

function extractFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `could not locate "${signature}" in source`);
  let depth = 0;
  let i = source.indexOf("{", start);
  const bodyStart = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(bodyStart, i + 1);
}

test("updateLead() no longer enforces the pipeline capability or the stale ['new','ready'] whitelist", () => {
  const apiSource = readFileSync(path.join(repoRoot, "src/lib/api.ts"), "utf8");
  const body = extractFunctionBody(
    apiSource,
    "export async function updateLead(id: number, body: UpdateLeadBody): Promise<Lead> {",
  );

  assert.ok(
    !/enforceCapability/.test(body),
    "updateLead() must not call enforceCapability — it is a general-purpose lead update used by every plan",
  );
  assert.ok(
    !/\[\s*["']new["']\s*,\s*["']ready["']\s*\]/.test(body),
    "updateLead() must not reintroduce the stale ['new','ready'] status whitelist",
  );
  // Still performs a normal, unrestricted write.
  assert.match(body, /leadToDbRow\(body/);
  assert.match(body, /from\("leads"\)\.update\(row\)/);
});

test('getPipelineStats() — a genuinely Pipeline-only read — still enforces the pipeline capability', () => {
  const apiSource = readFileSync(path.join(repoRoot, "src/lib/api.ts"), "utf8");
  const body = extractFunctionBody(apiSource, "export async function getPipelineStats(): Promise<PipelineStat[]> {");
  assert.match(body, /enforceCapability\("pipeline"\)/);
});

test("Pipeline Kanban drag/reorder handlers enforce the pipeline capability at the point of the user action", () => {
  const pipelineSource = readFileSync(path.join(repoRoot, "src/routes/dashboard.pipeline.tsx"), "utf8");

  const handleDrop = extractFunctionBody(pipelineSource, "const handleDrop = async (status: LeadStatus) => {");
  const handleMoveLeadStage = extractFunctionBody(
    pipelineSource,
    "const handleMoveLeadStage = async (leadId: number, targetStage: FlowStage) => {",
  );

  for (const [name, body] of [
    ["handleDrop", handleDrop],
    ["handleMoveLeadStage", handleMoveLeadStage],
  ] as const) {
    assert.match(
      body,
      /permissions\.can\(\s*["']pipeline["']\s*\)/,
      `${name} must gate the Pipeline-specific reorder action on permissions.can("pipeline")`,
    );
  }

  // The whole route is already wrapped in a pipeline FeatureGate — the
  // handlers must reuse that same permissions mechanism, not introduce a
  // second, independent gating system (e.g. a direct enforceCapability call
  // or a hard-coded plan check).
  assert.match(pipelineSource, /<FeatureGate feature="pipeline">/);
});
