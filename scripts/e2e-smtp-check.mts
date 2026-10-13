// Run from the repo root:  npx tsx scripts/e2e-smtp-check.mts
// Needs no real Supabase, SMTP account, or credentials: it starts a mock Supabase and a local SMTP server.
// End-to-end wiring check: REAL handlers + REAL supabase-js + REAL nodemailer,
// against a mock Supabase (auth + PostgREST) and a local SMTP server.
import http from "node:http";
import net from "node:net";

const PASS = "app-pass-E2E-SENTINEL";
const USERS: Record<string, string> = { "tok-A": "11111111-1111-1111-1111-111111111111", "tok-B": "22222222-2222-2222-2222-222222222222" };
const smtpTable = new Map<string, any>();
const profiles = new Map<string, any>(Object.values(USERS).map((id) => [id, { id, settings: { senderName: "Test" } }]));
let rlsDenyProfiles = false;
const smtpLog: string[] = [];

// ── mock Supabase ──
const sb = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const tok = (req.headers.authorization || "").replace("Bearer ", "");
  const uid = USERS[tok];
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const send = (code: number, body: any) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/auth/v1/user") return uid ? send(200, { id: uid, aud: "authenticated", email: "x@y.z", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01" }) : send(401, { msg: "bad jwt" });
    if (!uid) return send(401, { code: "PGRST301", message: "JWT invalid" });
    const f = (k: string) => url.searchParams.get(k)?.replace(/^eq\./, "");
    const wantObj = (req.headers.accept || "").includes("vnd.pgrst.object");
    if (url.pathname === "/rest/v1/profiles") {
      if (rlsDenyProfiles) return send(403, { code: "42501", message: "permission denied for table profiles" });
      const row = profiles.get(f("id")!);
      if (req.method === "GET") return wantObj ? (row ? send(200, row) : send(406, { code: "PGRST116", message: "0 rows" })) : send(200, row ? [row] : []);
      if (req.method === "PATCH") { Object.assign(row, JSON.parse(raw)); return send(204, {}); }
    }
    if (url.pathname === "/rest/v1/user_smtp_credentials") {
      const owner = f("user_id");
      if (req.method === "GET") { const r = owner && owner === uid ? smtpTable.get(owner) : undefined; return wantObj ? (r ? send(200, r) : send(406, { code: "PGRST116" })) : send(200, r ? [r] : []); }
      if (req.method === "POST") { const row = JSON.parse(raw); if (row.user_id !== uid) return send(403, { code: "42501", message: "row-level security" }); smtpTable.set(row.user_id, row); return send(201, {}); }
      if (req.method === "PATCH") { const r = smtpTable.get(owner!); if (!r || owner !== uid || String(r.config_version) !== f("config_version")) return send(200, []); Object.assign(r, JSON.parse(raw)); return send(200, [{ user_id: owner }]); }
      if (req.method === "DELETE") { if (owner === uid) smtpTable.delete(owner!); return send(204, {}); }
    }
    send(404, { code: "PGRST205", message: "not mocked" });
  });
});

// ── local SMTP server (AUTH PLAIN/LOGIN, then accepts mail) ──
const smtp = net.createServer((s) => {
  s.write("220 localhost ESMTP\r\n");
  let buf = ""; let data = false; let authStep = 0;
  s.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\r\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (data) { if (line === ".") { data = false; s.write("250 OK queued\r\n"); } continue; }
      if (authStep === 1) { authStep = 2; s.write("334 UGFzc3dvcmQ6\r\n"); continue; }
      if (authStep === 2) { authStep = 0; const ok = Buffer.from(line, "base64").toString() === PASS; smtpLog.push(`auth:${ok}`); s.write(ok ? "235 OK\r\n" : "535 bad credentials\r\n"); continue; }
      const cmd = line.toUpperCase();
      if (cmd.startsWith("EHLO")) s.write("250-localhost\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (cmd.startsWith("AUTH PLAIN")) { const [, u, p] = Buffer.from(line.split(" ")[2], "base64").toString().split("\0"); const ok = p === PASS; smtpLog.push(`auth:${ok}`); s.write(ok ? "235 OK\r\n" : "535 bad credentials\r\n"); }
      else if (cmd.startsWith("AUTH LOGIN")) { authStep = 1; s.write("334 VXNlcm5hbWU6\r\n"); }
      else if (cmd.startsWith("MAIL") || cmd.startsWith("RCPT")) s.write("250 OK\r\n");
      else if (cmd === "DATA") { data = true; s.write("354 go\r\n"); }
      else if (cmd === "QUIT") { s.write("221 bye\r\n"); s.end(); }
      else s.write("250 OK\r\n");
    }
  });
});

await new Promise<void>((r) => sb.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
const sbPort = (sb.address() as any).port, smtpPort = (smtp.address() as any).port;
process.env.VITE_SUPABASE_URL = `http://127.0.0.1:${sbPort}`;
process.env.VITE_SUPABASE_ANON_KEY = "anon";
process.env.SMTP_CREDENTIALS_KEY = Buffer.alloc(32, 5).toString("base64");

const settingsH = (await import("../api/smtp-settings.ts")).default;
const testH = (await import("../api/test-smtp.ts")).default;
const sendH = (await import("../api/send-email.ts")).default;

async function call(h: any, method: string, tok: string | null, body?: any) {
  const out: any = { status: 0, body: undefined };
  const res: any = { setHeader() {}, status(c: number) { out.status = c; return res; }, json(b: any) { out.body = b; return res; }, end() { return res; } };
  await h({ method, headers: tok ? { authorization: `Bearer ${tok}` } : {}, body }, res);
  return out;
}
let fails = 0;
const check = (name: string, cond: boolean, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!cond) fails++; };
const cfg = { host: "127.0.0.1", port: String(smtpPort), username: "me@example.com", encryption: "None", password: PASS };

let r = await call(settingsH, "GET", "tok-A");
check("fresh user: GET → not_configured", r.status === 200 && r.body.settings.status === "not_configured");
r = await call(settingsH, "GET", null);
check("no token → 401", r.status === 401);
r = await call(settingsH, "PUT", "tok-A", cfg);
check("PUT saves config (status untested, no password echoed)", r.status === 200 && r.body.settings.status === "untested" && !JSON.stringify(r.body).includes(PASS), JSON.stringify(r.body).slice(0, 120));
check("DB row holds ciphertext, not the password", !JSON.stringify([...smtpTable.values()]).includes(PASS) && smtpTable.get(USERS["tok-A"])?.password_ciphertext?.startsWith("v1."));
r = await call(testH, "POST", "tok-A");
check("POST test-smtp against real SMTP → success + connected", r.status === 200 && r.body.success === true && r.body.settings.status === "connected", JSON.stringify(r.body).slice(0, 160));
// "leave Settings and come back" / refresh / new session = independent GETs
for (const label of ["return to Settings", "page refresh", "new session"]) {
  r = await call(settingsH, "GET", "tok-A");
  check(`${label}: still connected with timestamp`, r.body.settings.status === "connected" && !!r.body.settings.lastTestedAt);
}
r = await call(settingsH, "GET", "tok-B");
check("other user sees nothing of A's config", r.body.settings.configured === false);
r = await call(sendH, "POST", "tok-A", { to: "lead@example.com", subject: "Hi", body: "Hello there" });
check("send-email with stored encrypted creds → 200 (no 'profile not found')", r.status === 200 && r.body.success === true, JSON.stringify(r.body).slice(0, 160));
r = await call(settingsH, "PUT", "tok-A", { ...cfg, port: String(smtpPort + 1) });
check("changing port invalidates the test", r.body.settings.status === "untested");
await call(settingsH, "PUT", "tok-A", cfg);
r = await call(testH, "POST", "tok-A"); 
check("re-save original + retest → connected again", r.body.settings?.status === "connected");
r = await call(settingsH, "PUT", "tok-A", { ...cfg, password: "wrong-password" });
r = await call(testH, "POST", "tok-A");
check("wrong password → 422 failed, shown as failed, password not leaked", r.status === 422 && r.body.settings.status === "failed" && !JSON.stringify(r.body).includes("wrong-password"), JSON.stringify(r.body).slice(0, 140));
r = await call(settingsH, "DELETE", "tok-A");
check("DELETE clears everything", r.body.settings.configured === false && !smtpTable.has(USERS["tok-A"]));
rlsDenyProfiles = true;
await call(settingsH, "PUT", "tok-A", cfg);
r = await call(sendH, "POST", "tok-A", { to: "lead@example.com", subject: "Hi", body: "Hello there" });
check("profiles permission denied → 403 db_permission_denied (not 'not found')", r.status === 403 && r.body.code === "db_permission_denied", JSON.stringify(r.body).slice(0, 140));
rlsDenyProfiles = false; profiles.delete(USERS["tok-A"]);
r = await call(sendH, "POST", "tok-A", { to: "lead@example.com", subject: "Hi", body: "Hello there" });
check("profile row missing → 404 profile_not_found", r.status === 404 && r.body.code === "profile_not_found", JSON.stringify(r.body).slice(0, 140));
console.log(fails ? `\n${fails} FAILED` : "\nALL E2E CHECKS PASSED");
sb.close(); smtp.close(); process.exit(fails ? 1 : 0);
