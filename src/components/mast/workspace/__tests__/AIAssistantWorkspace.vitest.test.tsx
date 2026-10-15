import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import { AIAssistant } from "../components/AIAssistant";
import type { Lead } from "@/lib/api";

const h = vi.hoisted(() => ({
  generateDraftMutate: vi.fn(),
  recordActivityMutate: vi.fn(),
  freeGenerateMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  clipboardText: "",
  userPlan: "free",
  aiConfigured: true,
}));

// Mock clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn(async (text: string) => {
      h.clipboardText = text;
      return Promise.resolve();
    }),
  },
});

vi.mock("sonner", () => ({
  toast: {
    success: h.toastSuccess,
    error: h.toastError,
    info: h.toastInfo,
  },
}));

vi.mock("@/hooks/use-mast-api", () => ({
  useSettings: () => ({
    data: { senderName: "Alex Rivera", focusArea: "Web Designer" },
  }),
  useMe: () => ({
    data: { user: { fullName: "Alex Rivera", email: "alex@example.com", plan: h.userPlan } },
  }),
  useOutreachStatus: () => ({
    data: { aiConfigured: h.aiConfigured, model: "openrouter/free" },
    isLoading: false,
  }),
  useGenerateOutreachDraft: () => ({
    mutateAsync: h.generateDraftMutate,
    isPending: false,
  }),
  useRecordLeadActivity: () => ({
    mutateAsync: h.recordActivityMutate,
    isPending: false,
  }),
  useOpportunityExplanation: (leadId: number) => ({
    data: {
      score: 82,
      summary: "High conversion potential for website redesign.",
      reasons: [
        { reason: "Website mobile load time exceeds 4.5 seconds", component: "website", weight: 3 },
        { reason: "Active social following but outdated landing page", component: "social", weight: 2 },
      ],
      breakdown: { website: 40, social: 25 },
    },
    isLoading: false,
  }),
  useLeadTrust: (leadId: number) => ({
    data: {
      overallConfidence: 0.95,
      lastVerifiedAt: "2026-04-10T10:00:00Z",
      businessHealth: { score: 88 },
      contacts: { emails: ["info@brighthorizon.com"], phones: ["+1 555 123 4567"] },
    },
    isLoading: false,
  }),
  useOpportunityInsight: (bizId?: string) => ({
    data: {
      headline: "High potential café with outdated mobile presence",
      talking_points: [
        "Mention their strong 4.8-star reputation in Seattle",
        "Offer a mobile ordering speed audit",
      ],
      opening_line: "Hi — loved seeing Bright Horizon Cafe's community reviews in Seattle.",
    },
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-free-outreach", () => ({
  useFreeOutreach: () => ({
    generate: h.freeGenerateMock,
  }),
}));

const mockLead: Lead = {
  id: 101,
  userId: 1,
  businessName: "Bright Horizon Cafe",
  niche: "cafe",
  email: "hello@brighthorizon.com",
  phone: "+1 555 123 4567",
  website: "https://brighthorizon.com",
  instagramHandle: "bright_horizon_cafe",
  location: "Seattle, WA",
  opportunityScore: 82,
  status: "new",
  createdAt: "2026-04-01T00:00:00Z",
  updatedAt: "2026-04-01T00:00:00Z",
};

const mockLead2: Lead = {
  id: 202,
  userId: 1,
  businessName: "Cascade Dental Studio",
  niche: "dental",
  email: "smile@cascadedental.com",
  phone: "+1 555 987 6543",
  website: "https://cascadedental.com",
  instagramHandle: "cascade_dental",
  location: "Portland, OR",
  opportunityScore: 91,
  status: "new",
  createdAt: "2026-04-02T00:00:00Z",
  updatedAt: "2026-04-02T00:00:00Z",
};

describe("AIAssistant Workspace — Tabs, Interactions, and Integration", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.clipboardText = "";
    h.userPlan = "free";
    h.aiConfigured = true;
    h.freeGenerateMock.mockResolvedValue({
      ok: true,
      subject: "Quick question regarding Bright Horizon Cafe",
      body: "Hi team — came across Bright Horizon Cafe and had a couple ideas.",
      angleComponent: "website",
      angleSource: "scoring",
    });
    h.generateDraftMutate.mockResolvedValue({
      body: "AI generated message for Bright Horizon Cafe",
      subject: "AI Subject Line",
    });
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  /* ─────────────────────────────────────────────────────────────
   * 1. ACCESSIBLE TAB SWITCHING & ACTIVE STATE
   * ───────────────────────────────────────────────────────────── */
  describe("1. Tab Switching & Workspaces", () => {
    it("renders all four accessible tabs with Write active by default", () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      const writeTab = screen.getByRole("tab", { name: /write/i });
      const improveTab = screen.getByRole("tab", { name: /improve/i });
      const ideasTab = screen.getByRole("tab", { name: /ideas/i });
      const researchTab = screen.getByRole("tab", { name: /research/i });

      expect(writeTab).toBeInTheDocument();
      expect(improveTab).toBeInTheDocument();
      expect(ideasTab).toBeInTheDocument();
      expect(researchTab).toBeInTheDocument();

      // Write is active by default
      expect(writeTab).toHaveAttribute("aria-selected", "true");
      expect(improveTab).toHaveAttribute("aria-selected", "false");
      expect(screen.getByText("Create Outreach Draft")).toBeInTheDocument();
    });

    it("switches to Improve workspace and reflects active state", () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject="Test subject"
          body="Hello, I am reaching out about your website."
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      const improveTab = screen.getByRole("tab", { name: /improve/i });
      fireEvent.click(improveTab);

      expect(improveTab).toHaveAttribute("aria-selected", "true");
      expect(screen.getByText("Improve Existing Draft")).toBeInTheDocument();
      expect(screen.getByText("Current Message")).toBeInTheDocument();
    });

    it("switches to Ideas workspace and reflects active state", () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      const ideasTab = screen.getByRole("tab", { name: /ideas/i });
      fireEvent.click(ideasTab);

      expect(ideasTab).toHaveAttribute("aria-selected", "true");
      expect(screen.getByText("Outreach Ideas & Angles")).toBeInTheDocument();
      expect(screen.getByText("Outreach Angles")).toBeInTheDocument();
    });

    it("switches to Research workspace and reflects active state", () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      const researchTab = screen.getByRole("tab", { name: /research/i });
      fireEvent.click(researchTab);

      expect(researchTab).toHaveAttribute("aria-selected", "true");
      expect(screen.getByText("Business Research")).toBeInTheDocument();
      expect(screen.getByText("Business Summary")).toBeInTheDocument();
    });
  });

  /* ─────────────────────────────────────────────────────────────
   * 2. WRITE WORKSPACE — CREATE A MESSAGE
   * ───────────────────────────────────────────────────────────── */
  describe("2. Write Workspace", () => {
    it("displays context of selected lead without making user re-enter info", () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      expect(screen.getByText("Bright Horizon Cafe")).toBeInTheDocument();
      expect(screen.getByText("Café")).toBeInTheDocument();
    });

    it("generates a draft and allows inserting it into the composer", async () => {
      const onInsertMock = vi.fn();

      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={onInsertMock}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      const generateBtn = screen.getByRole("button", { name: /generate draft/i });
      fireEvent.click(generateBtn);

      await waitFor(() => {
        expect(screen.getByText("Generated Draft")).toBeInTheDocument();
      });

      // Verify draft preview contains subject and body
      expect(screen.getByText("Quick question regarding Bright Horizon Cafe")).toBeInTheDocument();
      expect(screen.getByText("Hi team — came across Bright Horizon Cafe and had a couple ideas.")).toBeInTheDocument();

      // Action: Insert into Composer
      const insertBtn = screen.getByRole("button", { name: /insert into composer/i });
      fireEvent.click(insertBtn);

      expect(onInsertMock).toHaveBeenCalledWith(
        "Hi team — came across Bright Horizon Cafe and had a couple ideas.",
        "Quick question regarding Bright Horizon Cafe"
      );
    });

    it("allows copying generated draft to clipboard", async () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /^copy/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /^copy/i }));

      expect(navigator.clipboard.writeText).toHaveBeenCalled();
      expect(h.clipboardText).toContain("Quick question regarding Bright Horizon Cafe");
    });
  });

  /* ─────────────────────────────────────────────────────────────
   * 3. IMPROVE WORKSPACE — IMPROVE AN EXISTING DRAFT
   * ───────────────────────────────────────────────────────────── */
  describe("3. Improve Workspace", () => {
    it("shows helpful empty state when middle composer has no message", () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("tab", { name: /improve/i }));

      expect(screen.getByText("No draft in composer")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /go to write tab/i })).toBeInTheDocument();
    });

    it("navigates to Write tab when clicking 'Go to Write Tab' from empty state", () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("tab", { name: /improve/i }));
      fireEvent.click(screen.getByRole("button", { name: /go to write tab/i }));

      expect(screen.getByRole("tab", { name: /write/i })).toHaveAttribute("aria-selected", "true");
    });

    it("displays live preview of composer draft when present", () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject="Check this out"
          body="I noticed your cafe has great reviews."
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("tab", { name: /improve/i }));

      expect(screen.getByText("Current Message")).toBeInTheDocument();
      expect(screen.getByText("I noticed your cafe has great reviews.")).toBeInTheDocument();
      expect(screen.getByText(/7 words/i)).toBeInTheDocument();
    });

    it("does not overwrite composer silently, allows review and explicit apply or discard", async () => {
      const onInsertMock = vi.fn();
      h.generateDraftMutate.mockResolvedValueOnce({
        subject: "Improved Subject",
        body: "I noticed your Seattle cafe has great reviews and an active following.",
      });

      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject="Initial"
          body="I noticed your cafe has great reviews."
          onInsert={onInsertMock}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("tab", { name: /improve/i }));
      fireEvent.click(screen.getByRole("button", { name: /improve draft/i }));

      await waitFor(() => {
        expect(screen.getByText("Improved Version")).toBeInTheDocument();
      });

      // Composer has NOT been called yet (no silent overwrite!)
      expect(onInsertMock).not.toHaveBeenCalled();

      // Review area displays improved draft
      expect(screen.getByText("I noticed your Seattle cafe has great reviews and an active following.")).toBeInTheDocument();

      // Click Apply
      fireEvent.click(screen.getByRole("button", { name: /apply to composer/i }));
      expect(onInsertMock).toHaveBeenCalledWith(
        "I noticed your Seattle cafe has great reviews and an active following.",
        "Improved Subject"
      );
    });

    it("allows discarding improved draft without mutating composer", async () => {
      const onInsertMock = vi.fn();
      h.generateDraftMutate.mockResolvedValueOnce({
        body: "New improved text.",
      });

      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject="Initial"
          body="Original text."
          onInsert={onInsertMock}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("tab", { name: /improve/i }));
      fireEvent.click(screen.getByRole("button", { name: /improve draft/i }));

      await waitFor(() => {
        expect(screen.getByText("Improved Version")).toBeInTheDocument();
      });

      // Discard
      fireEvent.click(screen.getByRole("button", { name: /discard/i }));

      expect(screen.queryByText("Improved Version")).not.toBeInTheDocument();
      expect(onInsertMock).not.toHaveBeenCalled();
    });
  });

  /* ─────────────────────────────────────────────────────────────
   * 4. IDEAS WORKSPACE — GENERATE OUTREACH IDEAS
   * ───────────────────────────────────────────────────────────── */
  describe("4. Ideas Workspace", () => {
    it("displays grounded talking points from intelligence and allows inserting into composer", () => {
      const onInsertMock = vi.fn();

      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body="Existing draft."
          onInsert={onInsertMock}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("tab", { name: /ideas/i }));

      // Grounded talking points are rendered
      expect(screen.getByText(/Mention their strong 4.8-star reputation in Seattle/i)).toBeInTheDocument();
      expect(screen.getByText(/Offer a mobile ordering speed audit/i)).toBeInTheDocument();

      // Action: Use in composer (finds first "Use in composer" button)
      const useBtns = screen.getAllByRole("button", { name: /use in composer/i });
      fireEvent.click(useBtns[0]);

      expect(onInsertMock).toHaveBeenCalledWith(
        expect.stringContaining("Mention their strong 4.8-star reputation in Seattle")
      );
    });

    it("honestly communicates that custom topic brainstorming requires a dedicated endpoint", () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("tab", { name: /ideas/i }));

      expect(screen.getByText(/Grounded Intelligence Live/i)).toBeInTheDocument();
      expect(screen.getByText(/Freeform AI brainstorming for custom topics requires a dedicated AI ideas route/i)).toBeInTheDocument();
    });
  });

  /* ─────────────────────────────────────────────────────────────
   * 5. RESEARCH WORKSPACE — UNDERSTAND THE BUSINESS
   * ───────────────────────────────────────────────────────────── */
  describe("5. Research Workspace", () => {
    it("presents verified business details, opportunity findings, and evidence vs inference", () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("tab", { name: /research/i }));

      // Business overview
      expect(screen.getByText("Bright Horizon Cafe")).toBeInTheDocument();
      expect(screen.getByText("brighthorizon.com")).toBeInTheDocument();
      expect(screen.getByText("hello@brighthorizon.com")).toBeInTheDocument();

      // Opportunity score & findings
      expect(screen.getByText("Opportunity Findings")).toBeInTheDocument();
      expect(screen.getByText("Website mobile load time exceeds 4.5 seconds")).toBeInTheDocument();

      // Evidence vs Inference
      expect(screen.getByText("Verified Evidence")).toBeInTheDocument();
      expect(screen.getByText("Inferred Opportunity")).toBeInTheDocument();

      // Pre-outreach discovery questions
      expect(screen.getByText("Questions to Investigate Before Contacting")).toBeInTheDocument();
    });

    it("honestly communicates that live web crawling is unavailable when querying a question", () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("tab", { name: /research/i }));

      expect(screen.getByText(/Telemetry & Verified Data Only/i)).toBeInTheDocument();
      expect(screen.getByText(/Live web crawling and autonomous web research are not configured on this server/i)).toBeInTheDocument();
    });
  });

  /* ─────────────────────────────────────────────────────────────
   * 6. PERSONALIZATION CONTEXT — COLLAPSE / EXPAND & PERSISTENCE
   * ───────────────────────────────────────────────────────────── */
  describe("6. Personalization Context Collapse / Expand", () => {
    it("can be collapsed and expanded, reclaiming space while keeping heading visible", () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      const heading = screen.getByText("Personalization Context");
      expect(heading).toBeInTheDocument();

      // Checkboxes visible by default
      expect(screen.getByText("Business name and niche")).toBeInTheDocument();
      expect(screen.getByText("Recent Instagram activity")).toBeInTheDocument();

      // Collapse
      const collapseToggle = screen.getByRole("button", { name: /collapse personalization context/i });
      fireEvent.click(collapseToggle);

      // Checkboxes hidden when collapsed
      expect(screen.queryByText("Business name and niche")).not.toBeInTheDocument();
      // Heading still visible
      expect(screen.getByText("Personalization Context")).toBeInTheDocument();

      // Expand again
      const expandToggle = screen.getByRole("button", { name: /expand personalization context/i });
      fireEvent.click(expandToggle);

      // Checkboxes restored
      expect(screen.getByText("Business name and niche")).toBeInTheDocument();
    });

    it("preserves checkbox states and custom notes when collapsing and expanding", () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      // Open notes edit
      fireEvent.click(screen.getByRole("button", { name: /edit context notes/i }));
      const notesInput = screen.getByLabelText(/custom business context notes/i);
      fireEvent.change(notesInput, { target: { value: "Founded in 2018 by two brothers" } });

      // Uncheck one option
      const bizNameCheckbox = screen.getByRole("checkbox", { name: /business name and niche/i });
      fireEvent.click(bizNameCheckbox);

      // Collapse
      fireEvent.click(screen.getByRole("button", { name: /collapse personalization context/i }));

      // Expand
      fireEvent.click(screen.getByRole("button", { name: /expand personalization context/i }));

      // Custom notes & uncheck preserved!
      expect(screen.getByRole("button", { name: /done/i })).toBeInTheDocument();
      expect(screen.getByLabelText(/custom business context notes/i)).toHaveValue("Founded in 2018 by two brothers");
    });

    it("persists collapse state to localStorage", () => {
      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /collapse personalization context/i }));
      expect(localStorage.getItem("mast:ai-personalization-collapsed")).toBe("true");
    });
  });

  /* ─────────────────────────────────────────────────────────────
   * 7. LEAD SWITCHING & STATE ISOLATION
   * ───────────────────────────────────────────────────────────── */
  describe("7. Lead Switching Isolation", () => {
    it("clears generated drafts when switching from Lead A to Lead B so text does not leak", async () => {
      const { rerender } = render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      // Generate draft for Lead A (Bright Horizon Cafe)
      fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));
      await waitFor(() => {
        expect(screen.getByText("Quick question regarding Bright Horizon Cafe")).toBeInTheDocument();
      });

      // Switch lead to Lead B (Cascade Dental Studio)
      rerender(
        <AIAssistant
          lead={mockLead2}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      // Lead A's generated draft must NOT leak into Lead B's session
      expect(screen.queryByText("Quick question regarding Bright Horizon Cafe")).not.toBeInTheDocument();
      expect(screen.getByText("Cascade Dental Studio")).toBeInTheDocument();
    });
  });

  /* ─────────────────────────────────────────────────────────────
   * 8. AI GENERATION MODE & RESILIENT LOADING
   * ───────────────────────────────────────────────────────────── */
  describe("8. AI Generation Mode & Resilient Loading", () => {
    // 1. Free plan with AI configured uses fallback templates
    it("uses fallback templates when user is on Free plan even if AI is configured", async () => {
      h.userPlan = "free";
      h.aiConfigured = true;

      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));

      await waitFor(() => {
        expect(h.freeGenerateMock).toHaveBeenCalled();
      });
      expect(h.generateDraftMutate).not.toHaveBeenCalled();
      expect(screen.getByText("Quick question regarding Bright Horizon Cafe")).toBeInTheDocument();
    });

    // 2. Free plan without AI configured uses fallback templates
    it("uses fallback templates when user is on Free plan and AI is not configured", async () => {
      h.userPlan = "free";
      h.aiConfigured = false;

      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));

      await waitFor(() => {
        expect(h.freeGenerateMock).toHaveBeenCalled();
      });
      expect(h.generateDraftMutate).not.toHaveBeenCalled();
      expect(screen.getByText("Quick question regarding Bright Horizon Cafe")).toBeInTheDocument();
    });

    // 3. Paid plan with AI configured calls the AI provider and displays AI output instead of fallback templates
    it("calls AI provider and displays AI output on Paid plan with AI configured", async () => {
      h.userPlan = "pro";
      h.aiConfigured = true;

      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));

      await waitFor(() => {
        expect(h.generateDraftMutate).toHaveBeenCalled();
      });
      expect(h.freeGenerateMock).not.toHaveBeenCalled();
      expect(screen.getByText("AI generated message for Bright Horizon Cafe")).toBeInTheDocument();
      expect(screen.getByText("AI Subject Line")).toBeInTheDocument();
    });

    // 4. Paid plan without AI configuration uses fallback templates
    it("uses fallback templates on Paid plan when backend AI is not configured", async () => {
      h.userPlan = "pro";
      h.aiConfigured = false;

      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));

      await waitFor(() => {
        expect(h.freeGenerateMock).toHaveBeenCalled();
      });
      expect(h.generateDraftMutate).not.toHaveBeenCalled();
      expect(screen.getByText("Quick question regarding Bright Horizon Cafe")).toBeInTheDocument();
    });

    // 5. A failed AI request clears loading state and displays a retryable error without falling back to templates
    it("clears loading state and displays a retryable error on AI failure without silent template switch", async () => {
      h.userPlan = "pro";
      h.aiConfigured = true;
      h.generateDraftMutate.mockRejectedValueOnce(new Error("AI connection failed"));

      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));

      await waitFor(() => {
        expect(screen.getByText("Generation Error")).toBeInTheDocument();
      });

      // Crucial: do NOT silently fallback to templates on failure!
      expect(h.freeGenerateMock).not.toHaveBeenCalled();
      expect(screen.queryByText("Quick question regarding Bright Horizon Cafe")).not.toBeInTheDocument();

      // Retry button is displayed and button is not stuck in disabled loading state
      const retryBtn = screen.getByRole("button", { name: /retry/i });
      expect(retryBtn).toBeInTheDocument();
      expect(retryBtn).not.toBeDisabled();

      // Click Retry after error recovers
      h.generateDraftMutate.mockResolvedValueOnce({
        body: "Recovered AI message",
        subject: "Recovered Subject",
      });
      fireEvent.click(retryBtn);

      await waitFor(() => {
        expect(screen.getByText("Recovered AI message")).toBeInTheDocument();
      });
    });

    // 6. A rate-limit response does not leave the UI stuck
    it("handles rate-limit (429) response without getting stuck in loading state", async () => {
      h.userPlan = "pro";
      h.aiConfigured = true;
      const rateLimitErr: any = new Error("Provider rate limit reached (openrouter free pool 20 RPM)");
      rateLimitErr.status = 429;
      h.generateDraftMutate.mockRejectedValueOnce(rateLimitErr);

      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      const generateBtn = screen.getByRole("button", { name: /generate draft/i });
      fireEvent.click(generateBtn);

      await waitFor(() => {
        expect(screen.getByText(/AI request rate-limited/i)).toBeInTheDocument();
      });

      // Button is not permanently disabled
      expect(generateBtn).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });

    // 7. An empty or malformed response does not leave the UI loading indefinitely
    it("handles empty or malformed AI response and does not load indefinitely", async () => {
      h.userPlan = "pro";
      h.aiConfigured = true;
      h.generateDraftMutate.mockResolvedValueOnce({ body: "", subject: null });

      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));

      await waitFor(() => {
        expect(screen.getByText(/empty message body/i)).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });

    // 8. Switching leads or workflows does not display stale results
    it("ignores delayed in-flight responses when switching leads to prevent stale overwrites", async () => {
      h.userPlan = "pro";
      h.aiConfigured = true;

      let resolveLeadA!: (val: any) => void;
      const delayedLeadAPromise = new Promise((resolve) => {
        resolveLeadA = resolve;
      });
      h.generateDraftMutate.mockReturnValueOnce(delayedLeadAPromise);

      const { rerender } = render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      // Trigger generation for Lead A
      fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));

      // Switch context to Lead B while Lead A is still in-flight
      rerender(
        <AIAssistant
          lead={mockLead2}
          channel="email"
          subject=""
          body=""
          onInsert={vi.fn()}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      // Now resolve Lead A's delayed response
      resolveLeadA({
        body: "Lead A Delayed AI message",
        subject: "Lead A Subject",
      });

      // Lead A's text must not be rendered into Lead B's workspace
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByText("Lead A Delayed AI message")).not.toBeInTheDocument();
    });

    // 9. Existing composer insertion and copy actions continue to work
    it("inserts AI generated draft into composer and copies to clipboard", async () => {
      h.userPlan = "pro";
      h.aiConfigured = true;
      const onInsertMock = vi.fn();

      render(
        <AIAssistant
          lead={mockLead}
          channel="email"
          subject=""
          body=""
          onInsert={onInsertMock}
          template="initial"
          setTemplate={vi.fn()}
          tone="friendly"
          setTone={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /generate draft/i }));

      await waitFor(() => {
        expect(screen.getByText("AI generated message for Bright Horizon Cafe")).toBeInTheDocument();
      });

      // Insert into Composer
      fireEvent.click(screen.getByRole("button", { name: /insert into composer/i }));
      expect(onInsertMock).toHaveBeenCalledWith(
        "AI generated message for Bright Horizon Cafe",
        "AI Subject Line"
      );

      // Copy
      fireEvent.click(screen.getByRole("button", { name: /^copy/i }));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining("AI generated message for Bright Horizon Cafe")
      );
    });
  });
});
