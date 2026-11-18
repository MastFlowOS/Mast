import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { env } from "../../../config/env.js";
import { inboxDeps, inboxRouter } from "../inbox.js";

describe("Inbox routes (/v1/inbox)", () => {
  let server: any;
  let baseUrl = "";
  const userId = "user-inbox-1";
  const token = jwt.sign({ sub: userId, email: "freelancer@example.com" }, env.SUPABASE_JWT_SECRET, {
    algorithm: "HS256",
  });

  let connections: any[] = [];
  let savedSyncCalls = 0;
  let capturedEmailInput: any = null;
  let capturedIgEvents: any[] = [];

  const origDeps = { ...inboxDeps };

  before(async () => {
    inboxDeps.db = {
      from(table: string) {
        const filters: Array<(r: any) => boolean> = [];
        let op: "select" | "insert" | "update" | "upsert" = "select";
        let payload: any = null;

        const apply = () =>
          (table === "user_inbox_connections" ? connections : []).filter((r) =>
            filters.every((fn) => fn(r)),
          );

        const builder: any = {
          select() {
            return builder;
          },
          insert(row: any) {
            op = "insert";
            payload = row;
            connections.push(row);
            return builder;
          },
          upsert(row: any) {
            op = "upsert";
            payload = row;
            const idx = connections.findIndex((c) => c.user_id === row.user_id);
            if (idx >= 0) connections[idx] = { ...connections[idx], ...row };
            else connections.push(row);
            return builder;
          },
          update(patch: any) {
            op = "update";
            payload = patch;
            return builder;
          },
          eq(col: string, val: unknown) {
            filters.push((r) => r[col] === val);
            if (op === "update") {
              for (const row of apply()) Object.assign(row, payload);
              return Promise.resolve({ data: null, error: null });
            }
            return builder;
          },
          maybeSingle() {
            return Promise.resolve({ data: apply()[0] ?? null, error: null });
          },
          single() {
            if (op === "insert" || op === "upsert") {
              return Promise.resolve({ data: payload, error: null });
            }
            return Promise.resolve({ data: apply()[0] ?? null, error: null });
          },
        };
        return builder;
      },
    };
    inboxDeps.isEncryptionConfigured = () => true;
    inboxDeps.encryptPassword = (pass: string, uid: string) => `enc:${uid}:${pass}`;
    inboxDeps.decryptPassword = (cipher: string) => cipher.split(":")[2] || "";
    inboxDeps.validateImapHost = async (host: string) => ({
      canonicalHost: host,
      pinnedIp: "93.184.216.34",
      family: 4,
    });
    inboxDeps.testImapConnection = async () => {};
    inboxDeps.pollUserImapInbox = async () => {
      savedSyncCalls++;
      return { fetched: 3, matched: 1, recorded: 1, filtered: 0, lastUid: 45, uidValidity: 1 };
    };
    inboxDeps.ingestEmailReply = async (_db, input) => {
      capturedEmailInput = input;
      return {
        matched: true,
        recorded: true,
        duplicate: false,
        filteredNonReply: false,
        channel: "email",
        leadId: 77,
        businessName: "Studio Beta",
        intent: "interested",
      };
    };
    inboxDeps.ingestInstagramSyncEvents = async (_db, _uid, events) => {
      capturedIgEvents = events;
      return { processed: events.length, recorded: 1, duplicates: 0, unmatched: 0 };
    };

    const app = express();
    app.use(express.json());
    app.use("/v1/inbox", inboxRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    Object.assign(inboxDeps, origDeps);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    connections = [];
    savedSyncCalls = 0;
    capturedEmailInput = null;
    capturedIgEvents = [];
  });

  it("lazily provisions an inbound token on GET /settings and never leaks passwords", async () => {
    const res = await fetch(`${baseUrl}/v1/inbox/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const data: any = await res.json();
    assert.equal(data.provider, "inbound_only");
    assert.ok(data.inboundToken);
    assert.match(data.inboundWebhookPath, /^\/v1\/inbox\/inbound\//);
    assert.equal("password_ciphertext" in data, false);
  });

  it("saves encrypted IMAP credentials, verifies connection, and supports sync-now", async () => {
    const saveRes = await fetch(`${baseUrl}/v1/inbox/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        provider: "imap",
        imapHost: "imap.gmail.com",
        imapPort: 993,
        imapUsername: "me@gmail.com",
        imapPassword: "super-secret-app-password",
        imapTls: true,
        igEmailAlertsEnabled: true,
      }),
    });
    assert.equal(saveRes.status, 200);
    const saved: any = await saveRes.json();
    assert.equal(saved.configured, true);
    assert.equal(saved.hasPassword, true);
    assert.equal(connections[0].password_ciphertext, `enc:${userId}:super-secret-app-password`);

    const syncRes = await fetch(`${baseUrl}/v1/inbox/sync-now`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(syncRes.status, 200);
    const syncData: any = await syncRes.json();
    assert.equal(syncData.recorded, 1);
    assert.equal(savedSyncCalls, 1);
  });

  it("routes inbound webhook payloads authenticated by inbound_token", async () => {
    connections.push({
      user_id: userId,
      inbound_token: "valid_inbound_token_123456",
      enabled: true,
      ig_email_alerts_enabled: true,
    });

    const res = await fetch(`${baseUrl}/v1/inbox/inbound/valid_inbound_token_123456`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        From: "client@studiobeta.com",
        Subject: "Re: Design audit",
        TextBody: "Let's book a call!",
        MessageID: "<msg-inbound-1@studiobeta.com>",
      }),
    });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.recorded, true);
    assert.equal(capturedEmailInput.userId, userId);
    assert.equal(capturedEmailInput.from, "client@studiobeta.com");
  });

  it("accepts authenticated passive Instagram sync events on POST /ig-sync", async () => {
    const res = await fetch(`${baseUrl}/v1/inbox/ig-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        events: [{ handle: "@luna_bakery", previewText: "Yes interested!", unread: true }],
      }),
    });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.equal(body.recorded, 1);
    assert.equal(capturedIgEvents.length, 1);
  });
});
