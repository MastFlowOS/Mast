import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

/**
 * Regression coverage: the lead-update / outreach "Mark Sent" handlers
 * used to swallow every failure into a single hard-coded generic message
 * (`catch { toast.error("Failed to update status") }`), which is how the
 * pipeline-capability 403 from the root-cause bug went invisible to users.
 * Each of these handlers now surfaces `ApiError.message` when available
 * and keeps its existing generic string as the fallback — the same
 * pattern already used elsewhere in the app (dashboard.relationships.tsx,
 * dashboard.settings.tsx, login.tsx), which never leaks raw SQL/stack
 * traces because ApiError's message is already whatever was safe to throw.
 */

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

const expectations: Array<{ file: string; genericFallbacks: string[] }> = [
  {
    file: "src/components/mast/workspace/LeadWorkspaceHeader.tsx",
    genericFallbacks: [
      "Failed to update lead",
      "Failed to update status",
      "Action failed — please try again",
      "Failed to duplicate lead",
    ],
  },
  {
    file: "src/components/mast/workspace/components/EmailForm.tsx",
    genericFallbacks: ["Could not mark email as sent"],
  },
  {
    file: "src/components/mast/workspace/components/InstagramForm.tsx",
    genericFallbacks: ["Could not mark Instagram DM as sent"],
  },
  {
    file: "src/components/mast/workspace/components/PhoneForm.tsx",
    genericFallbacks: ["Could not save call notes", "Could not mark call as completed"],
  },
  {
    file: "src/components/mast/workspace/components/ContactForm.tsx",
    genericFallbacks: ["Could not mark contact form as sent"],
  },
];

for (const { file, genericFallbacks } of expectations) {
  test(`${path.basename(file)} imports ApiError from @/lib/api`, () => {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    assert.match(source, /import\s*{[^}]*\bApiError\b[^}]*}\s*from\s*["']@\/lib\/api["']/);
  });

  for (const fallback of genericFallbacks) {
    test(`${path.basename(file)}: "${fallback}" is only shown when the error isn't a safe-message ApiError`, () => {
      const source = readFileSync(path.join(repoRoot, file), "utf8");
      const pattern = new RegExp(
        `error instanceof ApiError \\? error\\.message : ["']${fallback.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
      );
      assert.match(
        source,
        pattern,
        `expected "${fallback}" in ${file} to be gated behind "error instanceof ApiError ? error.message : ..."`,
      );
    });
  }
}
