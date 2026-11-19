import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ingestEmailReply, ingestInstagramSyncEvents, type ReplyDbClient } from "../replyIngestion.js";

function createMockDb(seed: {
  leads?: any[];
  leadMessages?: any[];
  notifications?: any[];
  activities?: any[];
  profileSettings?: Record<string, unknown>;
}) {
  const state = {
    leads: seed.leads ? [...seed.leads] : [],
    lead_messages: seed.leadMessages ? [...seed.leadMessages] : [],
    user_notifications: seed.notifications ? [...seed.notifications] : [],
    lead_activities: seed.activities ? [...seed.activities] : [],
    profiles: [{ id: "user-1", settings: seed.profileSettings ?? {} }],
  };

  const db: ReplyDbClient = {
    from(table: keyof typeof state) {
      const filters: Array<(row: any) => boolean> = [];
      let pendingUpdate: Record<string, unknown> | null = null;
      let op: "select" | "insert" | "update" = "select";
      let insertPayload: any = null;

      const applyFilters = () => state[table].filter((r) => filters.every((fn) => fn(r)));

      const builder: any = {
        select() {
          return builder;
        },
        insert(row: any) {
          op = "insert";
          insertPayload = row;
          if (table === "user_notifications" && row.dedupe_key) {
            const dup = state.user_notifications.find(
              (n) => n.user_id === row.user_id && n.dedupe_key === row.dedupe_key,
            );
            if (dup) {
              return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } });
            }
          }
          state[table].push({ id: `${table}-${state[table].length + 1}`, ...row });
          return Promise.resolve({ data: row, error: null });
        },
        update(patch: Record<string, unknown>) {
          op = "update";
          pendingUpdate = patch;
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push((r) => r[col] === val);
          if (op === "update" && filters.length >= 2) {
            for (const row of applyFilters()) {
              Object.assign(row, pendingUpdate);
            }
            return Promise.resolve({ data: null, error: null });
          }
          return builder;
        },
        ilike(col: string, val: string) {
          const target = val.toLowerCase();
          filters.push((r) => String(r[col] || "").toLowerCase() === target);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          const set = new Set(vals);
          filters.push((r) => set.has(r[col]));
          return builder;
        },
        not(col: string, _op: string, val: unknown) {
          if (val === null) {
            filters.push((r) => r[col] !== null && r[col] !== undefined);
          }
          return builder;
        },
        limit() {
          return Promise.resolve({ data: applyFilters(), error: null });
        },
        maybeSingle() {
          const rows = applyFilters();
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        },
        then(resolve: (val: any) => void, reject?: (err: any) => void) {
          return Promise.resolve({ data: applyFilters(), error: null }).then(resolve, reject);
        },
      };

      void insertPayload;
      return builder;
    },
  };

  return { db, state };
}

const fakeHumanTriage = async () => ({
  isHumanReply: true,
  intent: "interested" as const,
  summary: "Interested in seeing pricing and portfolio.",
  suggestedReply: "Glad to hear! Here is my portfolio.",
  usedAi: true,
});

describe("replyIngestion", () => {
  it("matches email replies by In-Reply-To message ID, notifies user, logs activity, and upgrades lead status", async () => {
    const { db, state } = createMockDb({
      leads: [
        {
          id: 10,
          user_id: "user-1",
          business_name: "Kissa Coffee",
          email: "team@kissacoffee.com",
          status: "email_sent",
          last_contacted_at: "2026-11-17T10:00:00Z",
        },
      ],
      leadMessages: [
        {
          id: "msg-out-1",
          lead_id: 10,
          user_id: "user-1",
          external_message_id: "<out-10@mast.ai>",
        },
      ],
    });

    const result = await ingestEmailReply(
      db,
      {
        userId: "user-1",
        from: "Founder <founder@kissacoffee.com>",
        subject: "Re: Coffee shop branding",
        text: "Hey! Yes, send over your portfolio.",
        inReplyTo: "<out-10@mast.ai>",
        messageId: "<reply-1@kissacoffee.com>",
      },
      fakeHumanTriage,
    );

    assert.equal(result.matched, true);
    assert.equal(result.recorded, true);
    assert.equal(result.channel, "email");
    assert.equal(result.leadId, 10);
    assert.equal(state.user_notifications.length, 1);
    assert.equal(state.user_notifications[0].title, "Kissa Coffee replied on Email");
    assert.equal(state.user_notifications[0].action_url, "/dashboard/leads/10?channel=email");
    assert.equal(state.lead_activities.length, 1);
    assert.equal(state.lead_activities[0].type, "reply_received");
    assert.equal(state.leads[0].status, "replied");

    // Re-ingesting the same message ID is idempotent (no duplicate notification)
    const dup = await ingestEmailReply(
      db,
      {
        userId: "user-1",
        from: "Founder <founder@kissacoffee.com>",
        subject: "Re: Coffee shop branding",
        text: "Hey! Yes, send over your portfolio.",
        inReplyTo: "<out-10@mast.ai>",
        messageId: "<reply-1@kissacoffee.com>",
      },
      fakeHumanTriage,
    );
    assert.equal(dup.duplicate, true);
    assert.equal(dup.recorded, false);
    assert.equal(state.user_notifications.length, 1);
  });

  it("detects personal Instagram DM email alerts and routes them as Instagram replies without downgrading meeting_booked", async () => {
    const { db, state } = createMockDb({
      leads: [
        {
          id: 22,
          user_id: "user-1",
          business_name: "Luna Bakery",
          instagram_handle: "https://instagram.com/luna_bakery/",
          status: "meeting_booked",
          last_contacted_at: "2026-11-17T12:00:00Z",
        },
      ],
    });

    const res = await ingestEmailReply(
      db,
      {
        userId: "user-1",
        from: "Instagram <notifications@mail.instagram.com>",
        subject: "@luna_bakery sent you a message",
        text: 'luna_bakery sent you a message: "Can we move our call to 3pm?"',
        messageId: "<ig-alert-99@mail.instagram.com>",
      },
      fakeHumanTriage,
    );

    assert.equal(res.matched, true);
    assert.equal(res.recorded, true);
    assert.equal(res.channel, "instagram");
    assert.equal(state.user_notifications[0].title, "Luna Bakery replied on Instagram");
    assert.equal(state.user_notifications[0].action_url, "/dashboard/leads/22?channel=instagram");
    // Must not downgrade meeting_booked -> replied
    assert.equal(state.leads[0].status, "meeting_booked");
  });

  it("filters local Instagram observer sync strictly to contacted leads so personal DMs never leak", async () => {
    const { db, state } = createMockDb({
      leads: [
        {
          id: 30,
          user_id: "user-1",
          business_name: "Contacted Studio",
          instagram_handle: "@contacted_studio",
          status: "instagram_sent",
          last_contacted_at: "2026-11-18T09:00:00Z",
        },
        {
          id: 31,
          user_id: "user-1",
          business_name: "Uncontacted Lead",
          instagram_handle: "@uncontacted_lead",
          status: "new",
          last_contacted_at: null,
        },
      ],
    });

    const summary = await ingestInstagramSyncEvents(
      db,
      "user-1",
      [
        { handle: "@contacted_studio", previewText: "Sure, let's talk!", unread: true },
        { handle: "@uncontacted_lead", previewText: "Random DM", unread: true },
        { handle: "@best_friend_personal", previewText: "Dinner tonight?", unread: true },
      ],
      fakeHumanTriage,
    );

    assert.equal(summary.processed, 3);
    assert.equal(summary.recorded, 1);
    assert.equal(summary.unmatched, 2);
    assert.equal(state.user_notifications.length, 1);
    assert.equal(state.user_notifications[0].lead_id, 30);
    assert.equal(state.leads[0].status, "replied");
    assert.equal(state.leads[1].status, "new");
  });

  it("matches contacted IG leads unambiguously by displayName when Instagram omits @handle", async () => {
    const { db, state } = createMockDb({
      leads: [
        {
          id: 40,
          user_id: "user-1",
          business_name: "Northframe Coffee",
          instagram_handle: "@northframe.coffee",
          status: "instagram_sent",
          last_contacted_at: "2026-11-18T10:00:00Z",
        },
        {
          id: 41,
          user_id: "user-1",
          business_name: "Personal Friend",
          instagram_handle: "@personalfriend",
          status: "new",
          last_contacted_at: null,
        },
      ],
    });

    const summary = await ingestInstagramSyncEvents(
      db,
      "user-1",
      [
        { displayName: "Northframe Coffee", previewText: "What are your rates?", unread: true },
        { displayName: "Personal Friend", previewText: "Yo!", unread: true },
      ],
      fakeHumanTriage,
    );

    assert.equal(summary.processed, 2);
    assert.equal(summary.recorded, 1);
    assert.equal(summary.unmatched, 1);
    assert.equal(state.user_notifications[0].lead_id, 40);
    assert.equal(state.leads[0].status, "replied");
  });
});
