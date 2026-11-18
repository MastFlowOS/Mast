/**
 * Smart IMAP defaults derived from existing SMTP server hostnames so users
 * don't have to look up IMAP settings manually for common email providers.
 */
export interface ImapServerGuess {
  imapHost: string;
  imapPort: string;
  imapTls: boolean;
}

const KNOWN_SMTP_TO_IMAP: Record<string, ImapServerGuess> = {
  "smtp.gmail.com": { imapHost: "imap.gmail.com", imapPort: "993", imapTls: true },
  "smtp.googlemail.com": { imapHost: "imap.gmail.com", imapPort: "993", imapTls: true },
  "smtp.office365.com": { imapHost: "outlook.office365.com", imapPort: "993", imapTls: true },
  "smtp-mail.outlook.com": { imapHost: "outlook.office365.com", imapPort: "993", imapTls: true },
  "smtp.mail.yahoo.com": { imapHost: "imap.mail.yahoo.com", imapPort: "993", imapTls: true },
  "smtp.zoho.com": { imapHost: "imap.zoho.com", imapPort: "993", imapTls: true },
  "smtppro.zoho.com": { imapHost: "imappro.zoho.com", imapPort: "993", imapTls: true },
  "smtp.hostinger.com": { imapHost: "imap.hostinger.com", imapPort: "993", imapTls: true },
  "smtp.titan.email": { imapHost: "imap.titan.email", imapPort: "993", imapTls: true },
  "mail.privateemail.com": { imapHost: "mail.privateemail.com", imapPort: "993", imapTls: true },
  "smtp.fastmail.com": { imapHost: "imap.fastmail.com", imapPort: "993", imapTls: true },
  "smtp.mail.me.com": { imapHost: "imap.mail.me.com", imapPort: "993", imapTls: true },
};

export function deriveImapDefaultsFromSmtp(smtpHost?: string | null): ImapServerGuess {
  const clean = (smtpHost || "").trim().toLowerCase();
  if (!clean) {
    return { imapHost: "", imapPort: "993", imapTls: true };
  }
  if (KNOWN_SMTP_TO_IMAP[clean]) {
    return KNOWN_SMTP_TO_IMAP[clean];
  }
  if (clean.startsWith("smtp.")) {
    return { imapHost: `imap.${clean.slice(5)}`, imapPort: "993", imapTls: true };
  }
  return { imapHost: clean, imapPort: "993", imapTls: true };
}
