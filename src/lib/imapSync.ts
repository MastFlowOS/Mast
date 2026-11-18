/**
 * SSRF-safe IMAP client wrapper using `imapflow` + `mailparser`.
 *
 * - Validates hostnames & DNS resolutions against private/reserved IP ranges
 *   before connecting (`validateImapHost`).
 * - Decrypts user IMAP credentials only in server memory (`decryptInboxPassword`).
 * - Tracks `last_uid` and `uid_validity` per user so polling is incremental.
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { decryptInboxPassword } from "./inboxCrypto.js";
import { validateImapHost } from "./inboxHostValidator.js";
import { ingestEmailReply, type ReplyDbClient } from "./replyIngestion.js";

export interface ImapConnectionConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  tls: boolean;
}

export interface ImapPollSummary {
  fetched: number;
  matched: number;
  recorded: number;
  filtered: number;
  lastUid: number;
  uidValidity: number | null;
}

async function createImapClient(cfg: ImapConnectionConfig): Promise<ImapFlow> {
  const validated = await validateImapHost(cfg.host);

  return new ImapFlow({
    host: validated.pinnedIp,
    port: cfg.port,
    secure: cfg.tls,
    servername: validated.canonicalHost,
    tls: {
      servername: validated.canonicalHost,
      rejectUnauthorized: true,
    },
    auth: {
      user: cfg.username,
      pass: cfg.password,
    },
    logger: false,
    connectionTimeout: 12_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

export async function testImapConnection(cfg: ImapConnectionConfig): Promise<void> {
  const client = await createImapClient(cfg);
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    lock.release();
    await client.logout();
  } finally {
    try {
      client.close();
    } catch {
      // ignore close cleanup errors
    }
  }
}

function headerMapFromParsed(headers: Map<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of headers.entries()) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.map(String).join(" ");
    } else if (value && typeof value === "object" && "text" in value) {
      out[key] = String((value as { text?: unknown }).text || "");
    }
  }
  return out;
}

export async function pollUserImapInbox(params: {
  db: ReplyDbClient;
  userId: string;
  host: string;
  port: number;
  username: string;
  passwordCiphertext: string;
  tls: boolean;
  lastUid: number;
  uidValidity: number | null;
  igEmailAlertsEnabled: boolean;
  maxMessagesPerRun?: number;
}): Promise<ImapPollSummary> {
  const password = decryptInboxPassword(params.passwordCiphertext, params.userId);
  const client = await createImapClient({
    host: params.host,
    port: params.port,
    username: params.username,
    password,
    tls: params.tls,
  });

  const maxMessages = params.maxMessagesPerRun ?? 30;
  let fetched = 0;
  let matched = 0;
  let recorded = 0;
  let filtered = 0;
  let highestUid = params.lastUid;
  let currentUidValidity = params.uidValidity;

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const status = client.mailbox;
      const mailboxUidValidity =
        status && typeof status === "object" && "uidValidity" in status && status.uidValidity
          ? Number(status.uidValidity)
          : null;
      const mailboxUidNext =
        status && typeof status === "object" && "uidNext" in status && status.uidNext
          ? Number(status.uidNext)
          : null;

      // Reset watermark if UIDVALIDITY changed or on very first sync:
      // On first sync (lastUid === 0), start from recent messages (last 10 UIDs)
      // so we don't ingest years of historical inbox mail.
      let startUid = params.lastUid + 1;
      if (
        params.lastUid === 0 ||
        (mailboxUidValidity !== null &&
          params.uidValidity !== null &&
          mailboxUidValidity !== params.uidValidity)
      ) {
        if (mailboxUidNext && mailboxUidNext > 1) {
          startUid = Math.max(1, mailboxUidNext - 15);
          highestUid = Math.max(0, startUid - 1);
        } else {
          startUid = 1;
          highestUid = 0;
        }
      }
      currentUidValidity = mailboxUidValidity;

      const uids = await client.search({ uid: `${startUid}:*` }, { uid: true });
      const newUids = (Array.isArray(uids) ? uids : [])
        .filter((uid) => uid > highestUid)
        .sort((a, b) => a - b)
        .slice(0, maxMessages);

      if (newUids.length > 0) {
        for await (const msg of client.fetch(newUids, { uid: true, source: true }, { uid: true })) {
          fetched++;
          if (msg.uid > highestUid) highestUid = msg.uid;
          if (!msg.source) continue;

          const parsed = await simpleParser(msg.source);
          const fromText =
            parsed.from?.value?.[0]?.address ||
            parsed.from?.text ||
            null;
          const headers = headerMapFromParsed(parsed.headers as Map<string, unknown>);
          const references = Array.isArray(parsed.references)
            ? parsed.references
            : parsed.references
              ? [parsed.references]
              : [];

          const res = await ingestEmailReply(params.db, {
            userId: params.userId,
            from: fromText,
            subject: parsed.subject || null,
            text: parsed.text || null,
            html: typeof parsed.html === "string" ? parsed.html : null,
            messageId: parsed.messageId || null,
            inReplyTo: parsed.inReplyTo || null,
            references,
            headers,
            receivedAt: parsed.date ? parsed.date.toISOString() : new Date().toISOString(),
            igEmailAlertsEnabled: params.igEmailAlertsEnabled,
            source: "imap",
          });

          if (res.matched) matched++;
          if (res.recorded) recorded++;
          if (res.filteredNonReply) filtered++;
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } finally {
    try {
      client.close();
    } catch {
      // ignore cleanup error
    }
  }

  return {
    fetched,
    matched,
    recorded,
    filtered,
    lastUid: highestUid,
    uidValidity: currentUidValidity,
  };
}
