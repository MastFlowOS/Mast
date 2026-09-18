import test from "node:test";
import assert from "node:assert/strict";
import { PROFESSION_SLUGS } from "@/lib/professions";
import {
  PROFESSION_OUTREACH_PROFILES,
  getProfessionOutreachProfile,
  type ProfessionProfile,
} from "@/lib/outreach/professions";
import { generateFreeOutreach } from "@/lib/outreach/pipeline";

const REVIEWED_GRAPHIC_DESIGN: ProfessionProfile = {
  slug: "graphic_design",
  displayLabel: "Graphic Design",
  selfDescription: [
    "a freelance graphic designer who helps businesses improve their visual identity",
    "an independent designer focused on helping businesses present themselves consistently",
    "a graphic designer who helps businesses bring their logo, colors, and visual materials into a cohesive look",
  ],
  commonProblems: [
    {
      component: "branding",
      problemConcept:
        "a business's visual identity can become inconsistent or dated across different materials over time",
      safeWhen:
        "use when the deterministic opportunity signal identifies branding as relevant, or another verified lead signal supports a branding observation; otherwise fall back to a generic angle",
    },
    {
      component: "social",
      problemConcept: "a business's social presence can lack a consistent visual style across its content",
      safeWhen:
        "use when the deterministic opportunity signal identifies social as relevant and the business has a usable social presence; otherwise omit this angle",
    },
  ],
  valuePropAngles: {
    branding:
      "graphic design can bring a business's visual materials into a more consistent system across the places people encounter it",
    social:
      "consistent templates and visual elements can make a business's social presence feel more intentional from post to post",
  },
  ctaStyle: "showWork",
  voice: { formality: "casual", technicality: "plain" },
  terminology: ["visual identity", "brand look", "brand assets", "look and feel", "design work", "visual consistency"],
  genericFallbackAngle:
    "graphic design can help a business make its visual materials feel more consistent wherever people encounter the brand",
  openingVariants: [
    "Hi, I'm a freelance graphic designer — I help businesses improve their visual identity.",
    "I'm an independent designer focused on helping businesses bring their visual look together.",
    "I do graphic design work around branding and visual consistency.",
  ],
  ctaVariants: [
    "Would it be useful if I shared a few quick thoughts?",
    "Happy to put together a direction or two if you're open to it.",
    "Let me know if you'd like to see how I'd approach it.",
  ],
};

test("all 12 canonical professions resolve", () => {
  for (const slug of PROFESSION_SLUGS) {
    const profile = getProfessionOutreachProfile(slug);
    assert.ok(profile, `missing profile for ${slug}`);
    assert.equal(profile.slug, slug);
  }
});

test("no profession is missing and no extra profession exists", () => {
  const keys = Object.keys(PROFESSION_OUTREACH_PROFILES).sort();
  const canonical = [...PROFESSION_SLUGS].sort();
  assert.deepEqual(keys, canonical);
});

test("graphic_design exactly matches the reviewed profile", () => {
  assert.deepEqual(PROFESSION_OUTREACH_PROFILES.graphic_design, REVIEWED_GRAPHIC_DESIGN);
});

test("commonProblems component keys match valuePropAngles keys for every profession", () => {
  for (const slug of PROFESSION_SLUGS) {
    const profile = getProfessionOutreachProfile(slug);
    const problemComponents = new Set(profile.commonProblems.map((p) => p.component));
    const angleComponents = new Set(Object.keys(profile.valuePropAngles));
    assert.deepEqual([...problemComponents].sort(), [...angleComponents].sort(), `mismatch for ${slug}`);
  }
});

test("openingVariants are valid (3-5 non-empty, no line breaks)", () => {
  for (const slug of PROFESSION_SLUGS) {
    const profile = getProfessionOutreachProfile(slug);
    assert.ok(profile.openingVariants.length >= 3 && profile.openingVariants.length <= 5, slug);
    for (const variant of profile.openingVariants) {
      assert.ok(variant.trim().length > 0, slug);
      assert.equal(variant.includes("\n"), false, slug);
    }
  }
});

test("ctaVariants are valid (3-5 non-empty, no line breaks)", () => {
  for (const slug of PROFESSION_SLUGS) {
    const profile = getProfessionOutreachProfile(slug);
    assert.ok(profile.ctaVariants.length >= 3 && profile.ctaVariants.length <= 5, slug);
    for (const variant of profile.ctaVariants) {
      assert.ok(variant.trim().length > 0, slug);
      assert.equal(variant.includes("\n"), false, slug);
    }
  }
});

test("ctaStyle is always one of the three allowed values", () => {
  for (const slug of PROFESSION_SLUGS) {
    const profile = getProfessionOutreachProfile(slug);
    assert.ok(["lowCommitment", "consult", "showWork"].includes(profile.ctaStyle), slug);
  }
});

test("missing profession refuses generation via the pipeline", () => {
  const result = generateFreeOutreach({
    lead: { id: 1, businessName: "Test Biz", niche: null, status: "new", createdAt: "", updatedAt: "" } as any,
    profession: null,
    templateKey: "initial",
    channel: "email",
    activities: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_profession");
});

test("unknown profession string also refuses generation", () => {
  const result = generateFreeOutreach({
    lead: { id: 1, businessName: "Test Biz", niche: null, status: "new", createdAt: "", updatedAt: "" } as any,
    profession: "not_a_real_profession",
    templateKey: "initial",
    channel: "email",
    activities: [],
  });
  assert.equal(result.ok, false);
});
