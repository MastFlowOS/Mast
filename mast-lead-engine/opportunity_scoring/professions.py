"""
opportunity_scoring/professions.py
==================================

Canonical profession definitions and normalized weight vectors for opportunity scoring
in Engine 2.0.

Design Rules
------------
- Single Python source of truth for the 12 canonical profession slugs.
- Immutable weight vectors normalized to sum to 1.0 per profession.
- Consumes standard library types only.
"""

from __future__ import annotations

from dataclasses import dataclass

PROFESSION_SLUGS: tuple[str, ...] = (
    "graphic_design",
    "digital_marketing",
    "writing_translation",
    "video_animation",
    "music_audio",
    "programming_tech",
    "data",
    "business",
    "personal_growth_hobbies",
    "photography",
    "finance",
    "end_to_end_project",
)


@dataclass(frozen=True, slots=True)
class WeightVector:
    website: float
    branding: float
    social: float
    growth: float
    newness: float
    tech: float


RAW_WEIGHTS: dict[str, dict[str, float]] = {
    "graphic_design":          {"website": 0.10, "branding": 0.45, "social": 0.20, "growth": 0.10, "newness": 0.15, "tech": 0.03},
    "digital_marketing":       {"website": 0.15, "branding": 0.20, "social": 0.40, "growth": 0.15, "newness": 0.10, "tech": 0.05},
    "writing_translation":     {"website": 0.30, "branding": 0.20, "social": 0.20, "growth": 0.15, "newness": 0.15, "tech": 0.03},
    "video_animation":         {"website": 0.10, "branding": 0.30, "social": 0.35, "growth": 0.10, "newness": 0.15, "tech": 0.03},
    "music_audio":             {"website": 0.15, "branding": 0.25, "social": 0.35, "growth": 0.10, "newness": 0.15, "tech": 0.03},
    "programming_tech":        {"website": 0.45, "branding": 0.08, "social": 0.08, "growth": 0.12, "newness": 0.08, "tech": 0.30},
    "data":                    {"website": 0.30, "branding": 0.08, "social": 0.08, "growth": 0.28, "newness": 0.13, "tech": 0.15},
    "business":                {"website": 0.15, "branding": 0.15, "social": 0.12, "growth": 0.28, "newness": 0.12, "tech": 0.20},
    "personal_growth_hobbies": {"website": 0.18, "branding": 0.28, "social": 0.28, "growth": 0.05, "newness": 0.15, "tech": 0.03},
    "photography":             {"website": 0.10, "branding": 0.35, "social": 0.28, "growth": 0.05, "newness": 0.19, "tech": 0.02},
    "finance":                 {"website": 0.13, "branding": 0.08, "social": 0.08, "growth": 0.35, "newness": 0.22, "tech": 0.10},
    "end_to_end_project":      {"website": 0.18, "branding": 0.18, "social": 0.18, "growth": 0.18, "newness": 0.18, "tech": 0.10},
}


def _normalize_weights(raw: dict[str, dict[str, float]]) -> dict[str, WeightVector]:
    normalized: dict[str, WeightVector] = {}
    for slug, w in raw.items():
        total = sum(w.values())
        normalized[slug] = WeightVector(
            website=w["website"] / total,
            branding=w["branding"] / total,
            social=w["social"] / total,
            growth=w["growth"] / total,
            newness=w["newness"] / total,
            tech=w["tech"] / total,
        )
    return normalized


PROFESSION_WEIGHTS: dict[str, WeightVector] = _normalize_weights(RAW_WEIGHTS)
