import { describe, it, expect } from "vitest";
import { deriveImapDefaultsFromSmtp } from "../inboxDefaults";

describe("deriveImapDefaultsFromSmtp", () => {
  it("maps known SMTP providers to standard IMAP endpoints", () => {
    expect(deriveImapDefaultsFromSmtp("smtp.gmail.com")).toEqual({
      imapHost: "imap.gmail.com",
      imapPort: "993",
      imapTls: true,
    });
    expect(deriveImapDefaultsFromSmtp("smtp.office365.com")).toEqual({
      imapHost: "outlook.office365.com",
      imapPort: "993",
      imapTls: true,
    });
    expect(deriveImapDefaultsFromSmtp("smtp.hostinger.com")).toEqual({
      imapHost: "imap.hostinger.com",
      imapPort: "993",
      imapTls: true,
    });
  });

  it("derives generic smtp.<domain> to imap.<domain>", () => {
    expect(deriveImapDefaultsFromSmtp("SMTP.myagency.io")).toEqual({
      imapHost: "imap.myagency.io",
      imapPort: "993",
      imapTls: true,
    });
  });

  it("returns empty host when SMTP is blank", () => {
    expect(deriveImapDefaultsFromSmtp("")).toEqual({
      imapHost: "",
      imapPort: "993",
      imapTls: true,
    });
  });
});
