import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import type { Lead, LeadActivity, Followup } from "@/lib/api";

const h = vi.hoisted(() => ({
  updateLeadMutate: vi.fn(),
  createFollowupMutate: vi.fn(),
  updateFollowupMutate: vi.fn(),
  recordActivityMutate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  trustData: null as unknown,
  insightData: null as unknown,
  explanationData: null as unknown,
  followupsData: [] as Followup[],
  activitiesData: [] as LeadActivity[],
  clipboardText: "",
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
  },
}));

vi.mock("@/hooks/use-mast-api", () => ({
  useUpdateLead: () => ({ mutateAsync: h.updateLeadMutate, isPending: false }),
  useCreateFollowup: () => ({ mutateAsync: h.createFollowupMutate, isPending: false }),
  useUpdateFollowup: () => ({ mutateAsync: h.updateFollowupMutate, isPending: false }),
  useRecordLeadActivity: () => ({ mutateAsync: h.recordActivityMutate, isPending: false }),
  useLeadFollowups: () => ({ data: h.followupsData, isLoading: false, isError: false }),
  useLeadActivities: () => ({ data: h.activitiesData, isLoading: false, isError: false }),
  useLeadTrust: () => ({ data: h.trustData, isLoading: false, isError: false }),
  useOpportunityInsight: () => ({ data: h.insightData, isLoading: false, isError: false }),
  useOpportunityExplanation: () => ({ data: h.explanationData, isLoading: false, isError: false }),
}));

import { LeftSidebar } from "../LeftSidebar";
import { ActivityTimeline } from "../components/ActivityTimeline";
import { FollowUpsTab } from "../FollowUpsTab";

const mockLead: Lead = {
  id: 101,
  businessName: "Acme Creative Co",
  email: "contact.longname@verylongcompanydomain.co.uk",
  phone: "+1 (555) 234-5678",
  website: "https://acmecreative.com",
  instagramHandle: "acme_creative_studio",
  niche: "web_design",
  location: "Austin, TX",
  status: "new",
  priority: "normal",
  opportunityScore: 88,
  createdAt: "2026-03-01T10:00:00Z",
  updatedAt: "2026-03-01T10:00:00Z",
  websiteNotes: "Website lacks mobile responsiveness and has outdated 2019 copyright.",
  brandingNotes: "Specializes in artisanal branding for boutique hotels.",
};

describe("LeftSidebar — Lead Details Panel Enhancements", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.clipboardText = "";
    h.trustData = {
      isDisqualified: false,
      disqualifyReason: null,
      fieldTrust: {
        email: {
          value: mockLead.email,
          source: "Google Business",
          method: "google_business",
          confidence: 0.95,
          verifiedAt: "2026-03-01T00:00:00Z",
        },
      },
      businessHealth: {
        score: 72,
        breakdown: { website: 45, brand: 80, seo: 60, social: 75, reviews: 90, trust: 85, tech: 50, freshness: 70 },
        computedAt: "2026-03-01T00:00:00Z",
      },
    };
    h.insightData = {
      headline: "Boutique agency with high-margin hospitality clients but lagging web infrastructure.",
      talking_points: [
        "Modernizing mobile responsiveness to capture mobile booking inquiries.",
        "Aligning website performance with their high-end client roster.",
      ],
      opening_line: "I loved your recent branding work with the boutique hotel in Austin.",
      score_snapshot: 88,
      generated_at: "2026-03-01T00:00:00Z",
      cached: true,
      explanation: {} as any,
    };
    h.explanationData = {
      score: 88,
      professionSlug: "web_designer",
      professionMatch: "strong",
      summary: "High potential opportunity for web design modernization and mobile optimization.",
      reasons: [
        {
          component: "website",
          label: "Mobile Responsiveness Gap",
          detail: "Website exists but runs slowly and lacks modern mobile viewport structure.",
          weight: 0.8,
          value: 85,
        },
        {
          component: "branding",
          label: "Strong Visual Identity",
          detail: "Artisanal portfolio quality provides strong foundation for premium revamp.",
          weight: 0.5,
          value: 70,
        },
      ],
    };
    h.followupsData = [];
    h.activitiesData = [];
  });

  afterEach(() => {
    cleanup();
  });

  describe("1. Contact Methods — Fix Clipped Contact Information", () => {
    it("renders complete contact values with wrapping text and without clipping classes", () => {
      const setChannel = vi.fn();
      render(<LeftSidebar lead={mockLead} channel="email" setChannel={setChannel} />);

      // Complete email must be present in the document
      const emailEl = screen.getByText("contact.longname@verylongcompanydomain.co.uk");
      expect(emailEl).toBeDefined();
      // Email should have break-all or break-words so long addresses wrap cleanly without truncation
      expect(emailEl.className).toMatch(/break-words|break-all/);
      expect(emailEl.className).not.toContain("truncate");

      // Complete phone must be present and retain recognizable grouping without mid-number wrapping
      const phoneEl = screen.getByText("+1 (555) 234-5678");
      expect(phoneEl).toBeDefined();
      expect(phoneEl.className).toContain("whitespace-nowrap");
      expect(phoneEl.className).not.toContain("truncate");

      // Instagram handle
      const igEl = screen.getByText("@acme_creative_studio");
      expect(igEl).toBeDefined();
      expect(igEl.className).not.toContain("truncate");
    });

    it("provides accessible copy action that copies exact raw value and provides feedback", async () => {
      const setChannel = vi.fn();
      render(<LeftSidebar lead={mockLead} channel="email" setChannel={setChannel} />);

      const copyEmailBtn = screen.getByRole("button", { name: "Copy email address" });
      expect(copyEmailBtn).toBeDefined();

      fireEvent.click(copyEmailBtn);

      await waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(mockLead.email);
        expect(h.toastSuccess).toHaveBeenCalledWith("Email copied to clipboard");
      });
      // Clicking copy button must not trigger channel change
      expect(setChannel).not.toHaveBeenCalled();
    });

    it("does not show copy buttons for missing contact values", () => {
      const setChannel = vi.fn();
      const leadMissingContacts: Lead = {
        ...mockLead,
        email: null,
        phone: null,
        website: null,
        instagramHandle: null,
      };

      render(<LeftSidebar lead={leadMissingContacts} channel="email" setChannel={setChannel} />);

      expect(screen.queryByRole("button", { name: "Copy email address" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Copy phone number" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Copy website" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Copy Instagram handle" })).toBeNull();
    });

    it("switches channel when contact row is clicked", () => {
      const setChannel = vi.fn();
      render(<LeftSidebar lead={mockLead} channel="email" setChannel={setChannel} />);

      const phoneLabel = screen.getByText("Phone");
      const phoneRow = phoneLabel.closest('[role="button"]')!;
      fireEvent.click(phoneRow);

      expect(setChannel).toHaveBeenCalledWith("phone");
    });

    it("organizes each contact card into a clean 2-row layout separating header metadata from full contact value", () => {
      const setChannel = vi.fn();
      render(<LeftSidebar lead={mockLead} channel="email" setChannel={setChannel} />);

      // Find the email contact card container
      const emailLabel = screen.getByText("Email");
      const card = emailLabel.closest('[role="button"]') as HTMLElement;
      expect(card).toBeDefined();

      // Row 1 elements: Label "Email", Availability badge "Available", and Copy button
      expect(card.querySelector('button[aria-label="Copy email address"]')).not.toBeNull();

      // Row 2 element: full email value
      const emailValueEl = card.querySelector('[title="contact.longname@verylongcompanydomain.co.uk"]');
      expect(emailValueEl).not.toBeNull();
      expect(emailValueEl?.textContent).toBe("contact.longname@verylongcompanydomain.co.uk");
    });
  });

  describe("2. Business Insight — Surface Real Business Value", () => {
    it("surfaces core specialty, digital presence observation, primary intelligence and personalization hook", () => {
      const setChannel = vi.fn();
      render(<LeftSidebar lead={mockLead} channel="email" setChannel={setChannel} />);

      // Expand Business Insights accordion
      const insightsHeader = screen.getByRole("button", { name: /Business Insights/i });
      fireEvent.click(insightsHeader);

      // Primary intelligence headline
      expect(
        screen.getByText("Boutique agency with high-margin hospitality clients but lagging web infrastructure."),
      ).toBeDefined();

      // Digital presence observation from website notes
      expect(
        screen.getByText("Website lacks mobile responsiveness and has outdated 2019 copyright."),
      ).toBeDefined();

      // Personalization hook
      expect(
        screen.getByText("I loved your recent branding work with the boutique hotel in Austin."),
      ).toBeDefined();

      // Key talking points
      expect(screen.getByText("Modernizing mobile responsiveness to capture mobile booking inquiries.")).toBeDefined();

      // Business Health score
      expect(screen.getByText("72%")).toBeDefined();

      // Redundant metadata (like "Created: [date]") must not be present in the primary insights area
      expect(screen.queryByText(/Created 3\/1\/2026/)).toBeNull();
    });

    it("displays honest empty state when no business insights exist", () => {
      const setChannel = vi.fn();
      h.insightData = null;
      h.explanationData = null;
      h.trustData = null;
      const minimalLead: Lead = {
        ...mockLead,
        websiteNotes: null,
        brandingNotes: null,
        notes: null,
        igBio: null,
      };

      render(<LeftSidebar lead={minimalLead} channel="email" setChannel={setChannel} />);

      const insightsHeader = screen.getByRole("button", { name: /Business Insights/i });
      fireEvent.click(insightsHeader);

      expect(screen.getByText("No business insights available yet")).toBeDefined();
    });
  });

  describe("3. Why This Opportunity — Specific to Each Lead", () => {
    it("ranks the strongest reason first and displays supporting evidence and next steps", () => {
      const setChannel = vi.fn();
      render(<LeftSidebar lead={mockLead} channel="email" setChannel={setChannel} />);

      // Expand Why This Opportunity accordion
      const whyHeader = screen.getByRole("button", { name: /Why This Opportunity/i });
      fireEvent.click(whyHeader);

      // Strongest reason (Mobile Responsiveness Gap with impact 0.8 * 85 = 68) ranked first
      expect(screen.getByText("Strongest Reason")).toBeDefined();
      expect(screen.getByText("Mobile Responsiveness Gap")).toBeDefined();
      expect(
        screen.getByText("Website exists but runs slowly and lacks modern mobile viewport structure."),
      ).toBeDefined();

      // Supporting signal (Strong Visual Identity)
      expect(screen.getByText("Supporting Signals")).toBeDefined();
      expect(screen.getByText("Strong Visual Identity")).toBeDefined();

      // Service match summary
      expect(
        screen.getByText("High potential opportunity for web design modernization and mobile optimization."),
      ).toBeDefined();

      // Recommended next step
      expect(screen.getByText("Recommended Next Step")).toBeDefined();
      expect(screen.getByText(/Send a tailored pitch focusing on mobile responsiveness gap/i)).toBeDefined();
    });

    it("displays honest unscored state when lead opportunityScore is missing without concatenated debug tags", () => {
      const setChannel = vi.fn();
      h.explanationData = null;
      const unscoredLead: Lead = {
        ...mockLead,
        opportunityScore: null,
      };

      render(<LeftSidebar lead={unscoredLead} channel="email" setChannel={setChannel} />);

      const whyHeader = screen.getByRole("button", { name: /Why This Opportunity/i });
      fireEvent.click(whyHeader);

      expect(screen.getByText("Opportunity Not Yet Scored")).toBeDefined();
      expect(
        screen.getByText(/This opportunity has not been evaluated by the Opportunity Engine yet/i),
      ).toBeDefined();
      // Must NOT display technical/debug-like concatenated text
      expect(screen.queryByText(/Email on file · Phone on file/i)).toBeNull();
    });

    it("renders ranked opportunity safely when reasons are string arrays (live Engine 2.0 format) without crashing", () => {
      const setChannel = vi.fn();
      // Live Engine 2.0 sends reasons as string[]
      h.explanationData = {
        score: 92,
        professionSlug: "web_designer",
        summary: "Exceptional candidate for website redesign and modern branding upgrade.",
        reasons: [
          "Website exists but runs slowly and has critical mobile viewport defects.",
          "Branding and visual identity is strong with active local clientele.",
          "Social media presence is inactive with no updates in 6 months.",
        ],
      };

      // Rendering should NOT crash with TypeError: Cannot read properties of undefined (reading 'toLowerCase')
      render(<LeftSidebar lead={mockLead} channel="email" setChannel={setChannel} />);

      const whyHeader = screen.getByRole("button", { name: /Why This Opportunity/i });
      fireEvent.click(whyHeader);

      // Verify strongest reason is extracted and inferred cleanly
      expect(screen.getByText("Strongest Reason")).toBeDefined();
      expect(
        screen.getByText("Website exists but runs slowly and has critical mobile viewport defects."),
      ).toBeDefined();
      expect(screen.getByText("Website Opportunity")).toBeDefined();

      // Supporting signals
      expect(screen.getByText("Supporting Signals")).toBeDefined();
      expect(
        screen.getByText("Branding and visual identity is strong with active local clientele."),
      ).toBeDefined();
      expect(screen.getByText("Social Presence")).toBeDefined();

      // Recommended next step should be cleanly rendered
      expect(screen.getByText("Recommended Next Step")).toBeDefined();
      expect(
        screen.getByText(/Send a tailored pitch focusing on website opportunity/i),
      ).toBeDefined();
    });

    it("renders safely when ranked opportunity has empty or partially populated reasons", () => {
      const setChannel = vi.fn();
      h.explanationData = {
        score: 80,
        professionSlug: "web_designer",
        summary: "Good opportunity based on domain status.",
        reasons: [],
      };

      render(<LeftSidebar lead={mockLead} channel="email" setChannel={setChannel} />);

      const whyHeader = screen.getByRole("button", { name: /Why This Opportunity/i });
      fireEvent.click(whyHeader);

      expect(screen.getByText("Good opportunity based on domain status.")).toBeDefined();
      expect(screen.getByText("Recommended Next Step")).toBeDefined();
      expect(
        screen.getByText(/Send a tailored pitch focusing on their online presence/i),
      ).toBeDefined();
    });

    it("handles switching between ranked, partially ranked, and unranked leads without crashing", () => {
      const setChannel = vi.fn();
      h.explanationData = {
        score: 85,
        reasons: ["Outdated website structure."],
      };

      const { rerender } = render(<LeftSidebar lead={mockLead} channel="email" setChannel={setChannel} />);

      // Switch to unranked lead
      h.explanationData = null;
      const unrankedLead: Lead = { ...mockLead, id: 102, opportunityScore: null };
      rerender(<LeftSidebar lead={unrankedLead} channel="email" setChannel={setChannel} />);

      const whyHeader = screen.getByRole("button", { name: /Why This Opportunity/i });
      fireEvent.click(whyHeader);
      expect(screen.getByText("Opportunity Not Yet Scored")).toBeDefined();

      // Switch back to ranked lead with string reasons
      h.explanationData = {
        score: 95,
        reasons: ["No responsive mobile layout detected."],
      };
      rerender(<LeftSidebar lead={mockLead} channel="email" setChannel={setChannel} />);
      expect(screen.getByText("No responsive mobile layout detected.")).toBeDefined();
    });

    it("displays disqualification warning when lead is disqualified", () => {
      const setChannel = vi.fn();
      h.trustData = {
        isDisqualified: true,
        disqualifyReason: "Corporate franchise location with strict centralized procurement.",
        fieldTrust: {},
        businessHealth: null,
      };

      render(<LeftSidebar lead={mockLead} channel="email" setChannel={setChannel} />);

      const whyHeader = screen.getByRole("button", { name: /Why This Opportunity/i });
      fireEvent.click(whyHeader);

      expect(screen.getByText("Disqualified")).toBeDefined();
      expect(
        screen.getByText("Corporate franchise location with strict centralized procurement."),
      ).toBeDefined();
    });
  });

  describe("4. Follow-ups — Rebuild Internal Layout", () => {
    it("displays upcoming follow-ups with clear status badge, notes preview, and prominent Done button", () => {
      const today = new Date().toISOString();
      h.followupsData = [
        {
          id: 1,
          leadId: mockLead.id,
          channel: "email",
          dueAt: today,
          status: "pending",
          notes: "Send custom mockup for mobile hero section",
          createdAt: today,
          updatedAt: today,
        },
      ];

      render(<FollowUpsTab lead={mockLead} />);

      expect(screen.getByText("Upcoming Follow-ups")).toBeDefined();
      expect(screen.getByText("Due Today")).toBeDefined();
      expect(screen.getByText("Send custom mockup for mobile hero section")).toBeDefined();

      // Prominent Done action button
      const doneBtn = screen.getByRole("button", { name: /Done/i });
      expect(doneBtn).toBeDefined();

      fireEvent.click(doneBtn);
      expect(h.updateFollowupMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          body: expect.objectContaining({ status: "completed" }),
        }),
      );
    });

    it("renders spacious scheduling form with separate channel, date, notes and submit button", () => {
      h.followupsData = [];
      render(<FollowUpsTab lead={mockLead} />);

      expect(screen.getAllByText("Schedule Follow-up").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("Channel")).toBeDefined();
      expect(screen.getByText("Due Date")).toBeDefined();
      expect(screen.getByText("Notes (optional)")).toBeDefined();
      expect(screen.getByRole("button", { name: /Schedule Follow-up/i })).toBeDefined();
    });
  });

  describe("5. Recent Activity — Show Three at a Time", () => {
    it("initially shows three activities, expands by three with Show more, and collapses with Show less", () => {
      const mockActivities: LeadActivity[] = [
        { id: "act-1", leadId: mockLead.id, type: "email_sent", timestamp: "2026-03-01T15:00:00Z", content: "Email outreach sent #1" },
        { id: "act-2", leadId: mockLead.id, type: "email_opened", timestamp: "2026-03-01T14:00:00Z", content: "Email opened #2" },
        { id: "act-3", leadId: mockLead.id, type: "note_added", timestamp: "2026-03-01T13:00:00Z", content: "Note added #3" },
        { id: "act-4", leadId: mockLead.id, type: "call_completed", timestamp: "2026-03-01T12:00:00Z", content: "Phone call completed #4" },
        { id: "act-5", leadId: mockLead.id, type: "followup_scheduled", timestamp: "2026-03-01T11:00:00Z", content: "Follow-up scheduled #5" },
        { id: "act-6", leadId: mockLead.id, type: "opportunity_discovered", timestamp: "2026-03-01T10:00:00Z", content: "Discovered #6" },
        { id: "act-7", leadId: mockLead.id, type: "lead_created", timestamp: "2026-03-01T09:00:00Z", content: "Created #7" },
      ];
      h.activitiesData = mockActivities;

      render(<ActivityTimeline lead={mockLead} />);

      // Initially only first 3 activities shown
      expect(screen.getByText("Email outreach sent #1")).toBeDefined();
      expect(screen.getByText("Email opened #2")).toBeDefined();
      expect(screen.getByText("Note added #3")).toBeDefined();
      expect(screen.queryByText("Phone call completed #4")).toBeNull();

      // Show more button displays increment
      const showMoreBtn = screen.getByRole("button", { name: /Show more \(3\)/i });
      expect(showMoreBtn).toBeDefined();

      // Click Show more -> reveals 3 more (total 6)
      fireEvent.click(showMoreBtn);
      expect(screen.getByText("Phone call completed #4")).toBeDefined();
      expect(screen.getByText("Follow-up scheduled #5")).toBeDefined();
      expect(screen.getByText("Discovered #6")).toBeDefined();
      expect(screen.queryByText("Created #7")).toBeNull();

      // Show less button is now available
      const showLessBtn = screen.getByRole("button", { name: /Show less/i });
      expect(showLessBtn).toBeDefined();

      // Click Show less -> collapses back to initial 3
      fireEvent.click(showLessBtn);
      expect(screen.getByText("Email outreach sent #1")).toBeDefined();
      expect(screen.getByText("Email opened #2")).toBeDefined();
      expect(screen.getByText("Note added #3")).toBeDefined();
      expect(screen.queryByText("Phone call completed #4")).toBeNull();
    });

    it("hides pagination controls when there are 3 or fewer activities", () => {
      h.activitiesData = [
        { id: "act-1", leadId: mockLead.id, type: "email_sent", timestamp: "2026-03-01T15:00:00Z", content: "Email sent" },
        { id: "act-2", leadId: mockLead.id, type: "lead_created", timestamp: "2026-03-01T10:00:00Z", content: "Lead created" },
      ];

      render(<ActivityTimeline lead={mockLead} />);

      expect(screen.getByText("Email sent")).toBeDefined();
      expect(screen.getByText("Lead created")).toBeDefined();
      expect(screen.queryByRole("button", { name: /Show more/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /Show less/i })).toBeNull();
    });

    it("displays clean empty state when there are zero activities", () => {
      h.activitiesData = [];
      render(<ActivityTimeline lead={mockLead} />);

      expect(screen.getByText(/No outreach activity yet/i)).toBeDefined();
    });
  });

  describe("7. Automatically Scroll Expanded Sections Into View", () => {
    it("scrolls the sidebar container when an expanded section extends below the visible area", async () => {
      const setChannel = vi.fn();
      const scrollByMock = vi.fn();

      const { container } = render(<LeftSidebar lead={mockLead} channel="email" setChannel={setChannel} />);
      const aside = container.querySelector("aside")!;
      aside.scrollBy = scrollByMock;

      // Mock getBoundingClientRect
      vi.spyOn(aside, "getBoundingClientRect").mockReturnValue({
        top: 0,
        bottom: 500,
        height: 500,
        width: 320,
        left: 0,
        right: 320,
        x: 0,
        y: 0,
        toJSON: () => {},
      });

      // Expand Notes (near bottom)
      const notesBtn = screen.getByRole("button", { name: /Notes/i });
      fireEvent.click(notesBtn);

      // Find the notes accordion element
      const notesSection = notesBtn.closest(".rounded-xl") as HTMLElement;
      expect(notesSection).toBeDefined();

      // Mock the section extending below container bottom (e.g. bottom = 650 > 500)
      vi.spyOn(notesSection, "getBoundingClientRect").mockReturnValue({
        top: 350,
        bottom: 650,
        height: 300,
        width: 300,
        left: 10,
        right: 310,
        x: 10,
        y: 350,
        toJSON: () => {},
      });

      // Wait for RAF
      await new Promise((resolve) => requestAnimationFrame(resolve));

      // Must have called scrollBy with the overflow amount + padding
      expect(scrollByMock).toHaveBeenCalledWith(
        expect.objectContaining({
          top: expect.any(Number),
          behavior: "smooth",
        }),
      );
    });
  });
});

