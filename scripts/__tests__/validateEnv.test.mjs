import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateSupabaseEnv } from "../validate-env.mjs";

console.log("Running validateSupabaseEnv tests...");

// Test 1: Real workspace environment passes
const currentResult = validateSupabaseEnv(process.cwd());
assert.strictEqual(currentResult.valid, true, "Current workspace should be valid");
assert.ok(currentResult.url.includes("supabase.co"), "URL should be valid Supabase domain");
assert.ok(currentResult.anonKeyLength > 50, "Anon key length should be > 50");
console.log("✓ Test 1 passed: Current workspace environment is valid");

// Test 2: Placeholder URL fails
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mast-env-test-"));
try {
  fs.writeFileSync(path.join(tempDir, ".env"), `
VITE_SUPABASE_URL=https://placeholder.supabase.co
VITE_SUPABASE_ANON_KEY=eyJh...placeholder
  `.trim());

  const placeholderResult = validateSupabaseEnv(tempDir);
  assert.strictEqual(placeholderResult.valid, false, "Placeholder environment should fail");
  assert.ok(placeholderResult.issues.some(i => i.includes("placeholder domain")), "Should detect placeholder domain");
  assert.ok(placeholderResult.issues.some(i => i.includes("placeholder or dummy value")), "Should detect placeholder key");
  console.log("✓ Test 2 passed: Placeholder URL and key are correctly rejected");

  // Test 3: Secret key in VITE_SUPABASE_ANON_KEY fails
  const dummySecretKey = ["sb", "secret", "fake_test_dummy_key_for_unit_tests"].join("_");
  fs.writeFileSync(path.join(tempDir, ".env"), `
VITE_SUPABASE_URL=https://myproject.supabase.co
VITE_SUPABASE_ANON_KEY=${dummySecretKey}
  `.trim());

  const secretResult = validateSupabaseEnv(tempDir);
  assert.strictEqual(secretResult.valid, false, "Secret key in client variable should fail");
  assert.ok(secretResult.issues.some(i => i.includes("service-role secret key")), "Should detect secret key exposure");
  console.log("✓ Test 3 passed: Secret key in client variable is blocked");

  // Test 4: Missing variables fail
  fs.writeFileSync(path.join(tempDir, ".env"), "");
  const emptyResult = validateSupabaseEnv(tempDir);
  assert.strictEqual(emptyResult.valid, false, "Empty environment should fail");
  assert.ok(emptyResult.issues.some(i => i.includes("VITE_SUPABASE_URL is missing")), "Should detect missing URL");
  assert.ok(emptyResult.issues.some(i => i.includes("VITE_SUPABASE_ANON_KEY is missing")), "Should detect missing key");
  console.log("✓ Test 4 passed: Missing variables are caught");

} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("\nAll validateSupabaseEnv tests passed successfully!");
