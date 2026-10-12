import assert from "node:assert/strict";
import test from "node:test";
import { classifyDbError } from "../_dbErrors";

test("missing row, auth failure, permission denial, missing table, and other errors are all distinct", () => {
  const missing = classifyDbError({ code: "PGRST116", message: "0 rows" }, "profile")!;
  const jwt = classifyDbError({ code: "PGRST301", message: "JWT expired" }, "profile")!;
  const perm = classifyDbError(
    { code: "42501", message: "permission denied for table profiles" },
    "profile",
  )!;
  const rls = classifyDbError(
    { message: "new row violates row-level security policy" },
    "profile",
  )!;
  const table = classifyDbError(
    { code: "42P01", message: 'relation "x" does not exist' },
    "profile",
  )!;
  const other = classifyDbError({ code: "XX000", message: "boom" }, "profile")!;

  assert.deepEqual([missing.status, missing.code], [404, "profile_not_found"]);
  assert.deepEqual([jwt.status, jwt.code], [401, "auth_failed"]);
  assert.deepEqual([perm.status, perm.code], [403, "db_permission_denied"]);
  assert.equal(rls.status, 403);
  assert.deepEqual([table.status, table.code], [503, "storage_unavailable"]);
  assert.deepEqual([other.status, other.code], [500, "db_error"]);
  assert.equal(new Set([missing.code, jwt.code, perm.code, table.code, other.code]).size, 5);
});

test("only a genuinely missing row says 'not found'; permission errors say so explicitly", () => {
  const perm = classifyDbError({ code: "42501" }, "profile")!;
  assert.ok(!/not found/i.test(perm.message));
  assert.ok(/permission/i.test(perm.message));
});

test("no error means no failure; raw DB messages are never echoed", () => {
  assert.equal(classifyDbError(null, "profile"), null);
  const c = classifyDbError({ code: "XX000", message: "secret-internal-detail" }, "profile")!;
  assert.ok(!c.message.includes("secret-internal-detail"));
});
