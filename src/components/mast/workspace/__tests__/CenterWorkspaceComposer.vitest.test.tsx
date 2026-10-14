import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import { CenterWorkspace } from "../CenterWorkspace";
import { RichTextEditor } from "../components/RichTextEditor";
import {
  htmlToPlainText,
  plainTextToHtml,
  normalizeUrl,
  countWords,
} from "@/lib/richText";
import { formatHtmlEmail, formatPlainTextAlternative } from "../../../../../api/_formatEmail";
import type { Lead } from "@/lib/api";

const h = vi.hoisted(() => ({
  sendEmailMutate: vi.fn(),
  recordActivityMutate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  toastInfo: vi.fn(),
  clipboardText: "",
  windowOpenedUrl: "",
}));

// Mock window.open
vi.stubGlobal(
  "open",
  vi.fn((url: string) => {
    h.windowOpenedUrl = url;
    return { closed: false };
  })
);

// Mock navigator.clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn(async (text: string) => {
      h.clipboardText = text;
      return Promise.resolve();
    }),
    write: vi.fn(async () => Promise.resolve()),
  },
});

vi.mock("sonner", () => ({
  toast: {
    success: h.toastSuccess,
    error: h.toastError,
    warning: h.toastWarning,
    info: h.toastInfo,
  },
}));

vi.mock("@/hooks/use-mast-api", () => ({
  useSendLeadEmail: () => ({ mutateAsync: h.sendEmailMutate, isPending: false }),
  useRecordLeadActivity: () => ({ mutateAsync: h.recordActivityMutate, isPending: false }),
}));

const mockLead: Lead = {
  id: 123,
  userId: 1,
  businessName: "Bright Horizon Cafe",
  email: "hello@brighthorizon.com",
  phone: "+1 555 123 4567",
  website: "https://brighthorizon.com",
  instagramHandle: "bright_horizon_cafe",
  status: "new",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("Middle Message Composer — CenterWorkspace & RichTextEditor", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.clipboardText = "";
    h.windowOpenedUrl = "";

    // Polyfill document.execCommand & queryCommandState in jsdom environment
    if (!document.execCommand) {
      document.execCommand = vi.fn();
    }
    if (!document.queryCommandState) {
      document.queryCommandState = vi.fn();
    }
  });

  afterEach(() => {
    cleanup();
  });

  /* ─────────────────────────────────────────────────────────────
   * 1. APPLE NOTES RICH-TEXT EDITOR & FORMATTING
   * ───────────────────────────────────────────────────────────── */
  describe("1. Rich-text formatting behavior", () => {
    it("renders all formatting toolbar controls with proper accessibility labels", () => {
      render(
        <RichTextEditor
          value="<p>Test message</p>"
          onChange={() => {}}
        />
      );

      expect(screen.getByRole("button", { name: /^bold/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^italic/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^underline/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^strikethrough/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^bullet list/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^numbered list/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^quote/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^insert link/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^undo/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /^redo/i })).toBeDefined();
    });

    it("triggers document.execCommand on formatting button clicks while preserving selection", () => {
      const execSpy = vi.spyOn(document, "execCommand").mockImplementation(() => true);
      const querySpy = vi.spyOn(document, "queryCommandState").mockImplementation((cmd) => cmd === "bold");

      const handleChange = vi.fn();
      render(<RichTextEditor value="<p>Hello world</p>" onChange={handleChange} />);

      const boldButton = screen.getByRole("button", { name: /^bold/i });
      fireEvent.click(boldButton);

      expect(execSpy).toHaveBeenCalledWith("bold", false, undefined);

      execSpy.mockRestore();
      querySpy.mockRestore();
    });

    it("supports link insertion and validation", async () => {
      const execSpy = vi.spyOn(document, "execCommand").mockImplementation(() => true);
      render(<RichTextEditor value="<p>Click here</p>" onChange={() => {}} />);

      const linkBtn = screen.getByRole("button", { name: /^insert link/i });
      fireEvent.click(linkBtn);

      // Link Popover opens
      const urlInput = screen.getByPlaceholderText(/https:\/\/example.com/i);
      expect(urlInput).toBeDefined();

      fireEvent.change(urlInput, { target: { value: "mast.os" } });

      const saveBtn = screen.getByRole("button", { name: /^insert$/i });
      fireEvent.click(saveBtn);

      // Verify createLink was executed with normalized URL https://mast.os
      expect(execSpy).toHaveBeenCalledWith("createLink", false, "https://mast.os");

      execSpy.mockRestore();
    });

    it("converts bullet list and numbered list commands correctly", () => {
      const execSpy = vi.spyOn(document, "execCommand").mockImplementation(() => true);
      render(<RichTextEditor value="<p>First item</p>" onChange={() => {}} />);

      const bulletBtn = screen.getByRole("button", { name: /^bullet list/i });
      fireEvent.click(bulletBtn);
      expect(execSpy).toHaveBeenCalledWith("insertUnorderedList", false, undefined);

      const numberBtn = screen.getByRole("button", { name: /^numbered list/i });
      fireEvent.click(numberBtn);
      expect(execSpy).toHaveBeenCalledWith("insertOrderedList", false, undefined);

      execSpy.mockRestore();
    });
  });

  /* ─────────────────────────────────────────────────────────────
   * 2. EMAIL FORMATTING & PRESERVATION IN WORKFLOW
   * ───────────────────────────────────────────────────────────── */
  describe("Email and message output formatting", () => {
    it("formats HTML email with bold, italic, underline, strikethrough, links, and lists", () => {
      const richHtml =
        "<p>Hello <strong>Alex</strong>,</p><p>Check <em>this</em> <u style=\"text-decoration: underline;\">underlined</u> and <s style=\"text-decoration: line-through;\">deleted</s> text.</p><ul><li>First feature</li><li>Second feature</li></ul><p>Visit <a href=\"https://mast.os\">MAST</a></p>";

      const formattedHtml = formatHtmlEmail(richHtml);
      expect(formattedHtml).toContain("<strong>Alex</strong>");
      expect(formattedHtml).toContain("<em>this</em>");
      expect(formattedHtml).toContain('<u style="text-decoration: underline;">underlined</u>');
      expect(formattedHtml).toContain('<s style="text-decoration: line-through;">deleted</s>');
      expect(formattedHtml).toContain('<a href="https://mast.os"');
      expect(formattedHtml).toContain("<ul");
      expect(formattedHtml).toContain("First feature</li>");

      const plainText = formatPlainTextAlternative(richHtml);
      expect(plainText).toContain("Hello Alex,");
      expect(plainText).toContain("Check this underlined and deleted text.");
      expect(plainText).toContain("• First feature");
      expect(plainText).toContain("• Second feature");
      expect(plainText).toContain("Visit MAST (https://mast.os)");
      expect(plainText).not.toContain("<");
    });

    it("formats markdown-style bulleted and numbered lists into HTML email correctly", () => {
      const markdown = "Features:\n• Instant delivery\n• Accurate data\n\nSteps:\n1. Register\n2. Launch";
      const formatted = formatHtmlEmail(markdown);

      expect(formatted).toContain("<ul");
      expect(formatted).toContain("Instant delivery</li>");
      expect(formatted).toContain("Accurate data</li>");
      expect(formatted).toContain("<ol");
      expect(formatted).toContain("Register</li>");
      expect(formatted).toContain("Launch</li>");
    });

    it("converts plain text drafts into structured HTML paragraphs", () => {
      const draft = "Hi there,\n\nI noticed your cafe recently opened.\n\nBest,\nMe";
      const html = plainTextToHtml(draft);
      expect(html).toContain("<p>Hi there,</p>");
      expect(html).toContain("<p>I noticed your cafe recently opened.</p>");
      expect(html).toContain("<p>Best,<br />Me</p>");
    });

    it("handles URL normalization and word counts correctly", () => {
      expect(normalizeUrl("google.com")).toBe("https://google.com");
      expect(normalizeUrl("http://example.com")).toBe("http://example.com");
      expect(normalizeUrl("mailto:test@mast.os")).toBe("mailto:test@mast.os");
      expect(normalizeUrl("javascript:alert(1)")).toBe("");

      expect(countWords("<p>Hello <strong>world</strong></p>")).toBe(2);
      expect(countWords("• One • Two • Three")).toBe(6);
    });
  });

  /* ─────────────────────────────────────────────────────────────
   * 3. DISMISSIBLE BOTTOM-ACTION POPUP
   * ───────────────────────────────────────────────────────────── */
  describe("2. Bottom-action popup dismissal", () => {
    it("renders trigger and controls popup visibility", async () => {
      render(
        <CenterWorkspace
          lead={mockLead}
          channel="email"
          setChannel={() => {}}
          subject="Quick Question"
          setSubject={() => {}}
          body="<p>Hello there</p>"
          setBody={() => {}}
          template="initial"
          setTemplate={() => {}}
          tone="friendly"
          setTone={() => {}}
          onGenerate={async () => {}}
          isGenerating={false}
          onRewrite={async () => {}}
        />
      );

      const triggerBtn = screen.getByRole("button", { name: /more send options/i });
      expect(triggerBtn).toBeDefined();

      // In Radix, pointerDown followed by click triggers dropdown open
      fireEvent.pointerDown(triggerBtn, { button: 0 });
      fireEvent.click(triggerBtn);

      expect(await screen.findByText("Send via Connected Email")).toBeDefined();
      expect(screen.getByText("Open in Gmail Web")).toBeDefined();
      expect(screen.getByText("Open in Default Mail Client")).toBeDefined();
      expect(screen.getByText("Mark as Sent (Manual)")).toBeDefined();
    });

    it("closes popup when switching channels or leads", async () => {
      const { rerender } = render(
        <CenterWorkspace
          lead={mockLead}
          channel="email"
          setChannel={() => {}}
          subject="Subject"
          setSubject={() => {}}
          body="<p>Body</p>"
          setBody={() => {}}
          template="initial"
          setTemplate={() => {}}
          tone="friendly"
          setTone={() => {}}
          onGenerate={async () => {}}
          isGenerating={false}
          onRewrite={async () => {}}
        />
      );

      const triggerBtn = screen.getByRole("button", { name: /more send options/i });
      fireEvent.pointerDown(triggerBtn, { button: 0 });
      fireEvent.click(triggerBtn);
      expect(await screen.findByText("Send via Connected Email")).toBeDefined();

      // Switch lead
      rerender(
        <CenterWorkspace
          lead={{ ...mockLead, id: 999 }}
          channel="email"
          setChannel={() => {}}
          subject="Subject"
          setSubject={() => {}}
          body="<p>Body</p>"
          setBody={() => {}}
          template="initial"
          setTemplate={() => {}}
          tone="friendly"
          setTone={() => {}}
          onGenerate={async () => {}}
          isGenerating={false}
          onRewrite={async () => {}}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText("Send via Connected Email")).toBeNull();
      });
    });
  });

  /* ─────────────────────────────────────────────────────────────
   * 4. OPEN INSTAGRAM & COPY CURRENT MESSAGE
   * ───────────────────────────────────────────────────────────── */
  describe("3. Open Instagram and copy current message", () => {
    it("copies latest edited message to clipboard and opens Instagram DM destination", async () => {
      render(
        <CenterWorkspace
          lead={mockLead}
          channel="instagram"
          setChannel={() => {}}
          subject=""
          setSubject={() => {}}
          body="<p>Hey there, loved your recent post on <strong>specialty roasting</strong>!</p>"
          setBody={() => {}}
          template="initial"
          setTemplate={() => {}}
          tone="friendly"
          setTone={() => {}}
          onGenerate={async () => {}}
          isGenerating={false}
          onRewrite={async () => {}}
        />
      );

      const openIgBtn = screen.getByRole("button", { name: /^open instagram$/i });
      fireEvent.click(openIgBtn);

      await waitFor(() => {
        // Clipboard received plain text of the latest edit without raw HTML tags
        expect(h.clipboardText).toBe("Hey there, loved your recent post on specialty roasting!");
        // Opened the correct DM url
        expect(h.windowOpenedUrl).toContain("bright_horizon_cafe");
        // Clear user feedback
        expect(h.toastSuccess).toHaveBeenCalledWith(expect.stringContaining("Message copied to clipboard"));
      });
    });

    it("displays error and avoids opening if Instagram handle is missing", async () => {
      const leadWithoutIg = { ...mockLead, instagramHandle: undefined };
      render(
        <CenterWorkspace
          lead={leadWithoutIg}
          channel="instagram"
          setChannel={() => {}}
          subject=""
          setSubject={() => {}}
          body="<p>Hello</p>"
          setBody={() => {}}
          template="initial"
          setTemplate={() => {}}
          tone="friendly"
          setTone={() => {}}
          onGenerate={async () => {}}
          isGenerating={false}
          onRewrite={async () => {}}
        />
      );

      const openIgBtn = screen.getByRole("button", { name: /^open instagram$/i });
      fireEvent.click(openIgBtn);

      expect(h.toastError).toHaveBeenCalledWith("No Instagram handle recorded for this lead");
      expect(h.windowOpenedUrl).toBe("");
    });
  });

  /* ─────────────────────────────────────────────────────────────
   * 5. REMOVAL OF CALL PHONE BUTTON
   * ───────────────────────────────────────────────────────────── */
  describe("4. Removal of Call Phone button from middle composer", () => {
    it("does NOT render Call Phone button when channel is phone, keeping actions clean", () => {
      render(
        <CenterWorkspace
          lead={mockLead}
          channel="phone"
          setChannel={() => {}}
          subject=""
          setSubject={() => {}}
          body="<p>Call script opener...</p>"
          setBody={() => {}}
          template="initial"
          setTemplate={() => {}}
          tone="friendly"
          setTone={() => {}}
          onGenerate={async () => {}}
          isGenerating={false}
          onRewrite={async () => {}}
        />
      );

      expect(screen.queryByRole("button", { name: /call phone/i })).toBeNull();
      expect(screen.getByRole("button", { name: /generate with ai/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /copy message/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /mark as called/i })).toBeDefined();
    });

    it("still renders Open in Gmail for email and Open Instagram for instagram", () => {
      const { rerender } = render(
        <CenterWorkspace
          lead={mockLead}
          channel="email"
          setChannel={() => {}}
          subject="Subj"
          setSubject={() => {}}
          body="<p>Email body</p>"
          setBody={() => {}}
          template="initial"
          setTemplate={() => {}}
          tone="friendly"
          setTone={() => {}}
          onGenerate={async () => {}}
          isGenerating={false}
          onRewrite={async () => {}}
        />
      );

      expect(screen.getByRole("button", { name: /^open in gmail$/i })).toBeDefined();

      rerender(
        <CenterWorkspace
          lead={mockLead}
          channel="instagram"
          setChannel={() => {}}
          subject=""
          setSubject={() => {}}
          body="<p>IG body</p>"
          setBody={() => {}}
          template="initial"
          setTemplate={() => {}}
          tone="friendly"
          setTone={() => {}}
          onGenerate={async () => {}}
          isGenerating={false}
          onRewrite={async () => {}}
        />
      );

      expect(screen.getByRole("button", { name: /^open instagram$/i })).toBeDefined();
    });
  });
});
