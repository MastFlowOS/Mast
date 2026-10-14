/* eslint-disable @typescript-eslint/no-explicit-any -- loose fakes for req/res/db */
import assert from "node:assert/strict";
import test from "node:test";
import { handleSendEmail, type SendEmailDeps } from "../send-email";
import { SmtpServiceError } from "../_smtpService";
import { SECRET } from "./helpers";

type Result = { status: number; body: any };

function fakeRes() {
  const out: Result = { status: 0, body: undefined };
  const res: any = {
    setHeader() {},
    status(code: number) {
      out.status = code;
      return res;
    },
    json(b: any) {
      out.body = b;
      return res;
    },
    end() {
      return res;
    },
  };
  return { res, out };
}

const req = (over: any = {}): any => ({
  method: "POST",
  headers: { authorization: "Bearer t" },
  body: { to: "lead@example.com", subject: "Hello", body: "Hi there" },
  ...over,
});

/** Builds a fake Supabase client whose profiles query returns the given result. */
function dbWithProfile(result: { data: any; error: any }): any {
  const chain: any = { select: () => chain, eq: () => chain, single: async () => result };
  return { from: (t: string) => (assert.equal(t, "profiles"), chain) };
}

function deps(over: Partial<SendEmailDeps> & { db?: any } = {}): SendEmailDeps {
  const { db, ...rest } = over;
  return {
    authenticate: async () => ({
      ok: true,
      user: { id: "u1" } as any,
      userSupabase: db ?? dbWithProfile({ data: { settings: {} }, error: null }),
    }),
    loadCredentials: async () => ({
      host: "h",
      port: 587,
      user: "me@example.com",
      pass: SECRET,
      encryption: "TLS",
    }),
    createTransport: (() => ({ sendMail: async () => ({ messageId: "m1" }) })) as any,
    ...rest,
  };
}

async function run(d: SendEmailDeps, r = req()): Promise<Result> {
  const { res, out } = fakeRes();
  await handleSendEmail(r, res, d);
  return out;
}

test("authentication failures return 401 with auth_failed, not 'profile not found'", async () => {
  const out = await run(
    deps({
      authenticate: async () => ({
        ok: false,
        status: 401,
        code: "auth_failed",
        error: "Unauthorized user token.",
      }),
    }),
  );
  assert.equal(out.status, 401);
  assert.equal(out.body.code, "auth_failed");
});

test("a genuinely missing profile row is reported as profile_not_found (404)", async () => {
  const db = dbWithProfile({ data: null, error: { code: "PGRST116", message: "0 rows" } });
  const out = await run(deps({ db }));
  assert.equal(out.status, 404);
  assert.equal(out.body.code, "profile_not_found");
});

test("a database permission error is reported as 403 db_permission_denied, not 'not found'", async () => {
  const db = dbWithProfile({
    data: null,
    error: { code: "42501", message: "permission denied for table profiles" },
  });
  const out = await run(deps({ db }));
  assert.equal(out.status, 403);
  assert.equal(out.body.code, "db_permission_denied");
  assert.ok(!/not found/i.test(out.body.error));
});

test("an expired/invalid JWT at the database layer is reported as 401", async () => {
  const db = dbWithProfile({ data: null, error: { code: "PGRST301", message: "JWT expired" } });
  const out = await run(deps({ db }));
  assert.equal(out.status, 401);
  assert.equal(out.body.code, "auth_failed");
});

test("unknown database errors are 500 db_error and never echo raw details", async () => {
  const db = dbWithProfile({
    data: null,
    error: { code: "XX000", message: "internal-detail-xyz" },
  });
  const out = await run(deps({ db }));
  assert.equal(out.status, 500);
  assert.ok(!JSON.stringify(out.body).includes("internal-detail-xyz"));
});

test("no SMTP configured is a 400 smtp_not_configured (profile exists)", async () => {
  const out = await run(deps({ loadCredentials: async () => null }));
  assert.equal(out.status, 400);
  assert.equal(out.body.code, "smtp_not_configured");
});

test("missing encryption key surfaces as 503 with the env var name", async () => {
  const out = await run(
    deps({
      loadCredentials: async () => {
        throw new SmtpServiceError(
          503,
          "smtp_key_not_configured",
          "Set the SMTP_CREDENTIALS_KEY environment variable.",
        );
      },
    }),
  );
  assert.equal(out.status, 503);
  assert.equal(out.body.code, "smtp_key_not_configured");
  assert.ok(out.body.error.includes("SMTP_CREDENTIALS_KEY"));
});

test("sends with decrypted credentials and never returns them", async () => {
  let used: any;
  const out = await run(
    deps({
      createTransport: ((cfg: any) => {
        used = cfg;
        return { sendMail: async () => ({ messageId: "abc" }) };
      }) as any,
    }),
  );
  assert.equal(out.status, 200);
  assert.equal(out.body.success, true);
  assert.equal(used.pass, SECRET);
  assert.ok(!JSON.stringify(out.body).includes(SECRET));
});

test("a send failure never leaks the password and logs only a code", async () => {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    const out = await run(
      deps({
        createTransport: (() => ({
          sendMail: async () => {
            const e: any = new Error("Greeting never received");
            e.code = "ETIMEDOUT";
            throw e;
          },
        })) as any,
      }),
    );
    assert.equal(out.status, 500);
    assert.equal(out.body.code, "send_failed");
  } finally {
    console.error = orig;
  }
  assert.ok(!lines.join("\n").includes(SECRET));
});

test("rejects non-POST methods", async () => {
  const out = await run(deps(), req({ method: "GET" }));
  assert.equal(out.status, 405);
});

test("single source of truth for signature: sends body as composed without duplicate backend signature", async () => {
  let capturedOptions: any;
  const db = dbWithProfile({
    data: {
      settings: {
        signature: "Best regards,\nIbrahim",
        senderName: "Ibrahim",
      },
    },
    error: null,
  });

  const out = await run(
    deps({
      db,
      createTransport: (() => ({
        sendMail: async (opts: any) => {
          capturedOptions = opts;
          return { messageId: "msg-1" };
        },
      })) as any,
    }),
    req({
      body: {
        to: "recipient@example.com",
        subject: "Hello",
        body: "<p>Hi Jane,</p><p>Great connecting with you.</p><p>Best regards,<br>Ibrahim</p>",
      },
    }),
  );

  assert.equal(out.status, 200);
  assert.ok(capturedOptions);

  // HTML: check that "Best regards" appears exactly once
  const html = capturedOptions.html;
  const htmlMatches = html.match(/Best regards/g) || [];
  assert.equal(htmlMatches.length, 1, "Best regards must appear exactly once in HTML");
  const ibrahimMatches = html.match(/Ibrahim/g) || [];
  assert.equal(ibrahimMatches.length, 1, "Ibrahim must appear exactly once in HTML");

  // Plain text: check that "Best regards" appears exactly once
  const text = capturedOptions.text;
  const textMatches = text.match(/Best regards/g) || [];
  assert.equal(textMatches.length, 1, "Best regards must appear exactly once in text");
});

test("single source of truth: does not append signature if message intentionally has none", async () => {
  let capturedOptions: any;
  const db = dbWithProfile({
    data: {
      settings: {
        signature: "Best regards,\nIbrahim",
        senderName: "Ibrahim",
      },
    },
    error: null,
  });

  const out = await run(
    deps({
      db,
      createTransport: (() => ({
        sendMail: async (opts: any) => {
          capturedOptions = opts;
          return { messageId: "msg-2" };
        },
      })) as any,
    }),
    req({
      body: {
        to: "recipient@example.com",
        subject: "Quick question",
        body: "<p>Hi Jane,</p><p>Just checking in on the report.</p>",
      },
    }),
  );

  assert.equal(out.status, 200);
  assert.ok(capturedOptions);

  // Neither HTML nor text should have the signature appended
  assert.ok(!capturedOptions.html.includes("Best regards"));
  assert.ok(!capturedOptions.html.includes("Ibrahim"));
  assert.ok(!capturedOptions.text.includes("Best regards"));
  assert.ok(!capturedOptions.text.includes("Ibrahim"));
});

test("single source of truth: custom sign-off or different sender name is preserved and not overwritten", async () => {
  let capturedOptions: any;
  const db = dbWithProfile({
    data: {
      settings: {
        signature: "Best regards,\nIbrahim",
        senderName: "Ibrahim",
      },
    },
    error: null,
  });

  const out = await run(
    deps({
      db,
      createTransport: (() => ({
        sendMail: async (opts: any) => {
          capturedOptions = opts;
          return { messageId: "msg-3" };
        },
      })) as any,
    }),
    req({
      body: {
        to: "recipient@example.com",
        subject: "Greetings",
        body: "<p>Hi team,</p><p>Warmly,<br>Sarah</p>",
      },
    }),
  );

  assert.equal(out.status, 200);
  assert.ok(capturedOptions.html.includes("Warmly"));
  assert.ok(capturedOptions.html.includes("Sarah"));
  assert.ok(!capturedOptions.html.includes("Best regards"));
  assert.ok(!capturedOptions.html.includes("Ibrahim"));
});

test("preserves unrelated occurrences of sign-off words in message body", async () => {
  let capturedOptions: any;
  const db = dbWithProfile({
    data: {
      settings: {
        signature: "Best regards,\nIbrahim",
      },
    },
    error: null,
  });

  const out = await run(
    deps({
      db,
      createTransport: (() => ({
        sendMail: async (opts: any) => {
          capturedOptions = opts;
          return { messageId: "msg-4" };
        },
      })) as any,
    }),
    req({
      body: {
        to: "recipient@example.com",
        subject: "Team update",
        body: "<p>Please send our best regards to your team on the recent milestone.</p><p>Best regards,<br>Ibrahim</p>",
      },
    }),
  );

  assert.equal(out.status, 200);
  assert.ok(capturedOptions.html.includes("best regards to your team"));
  const matches = capturedOptions.html.match(/best regards/gi) || [];
  assert.equal(matches.length, 2, "Body occurrence and closing sign-off must both be preserved");
});

