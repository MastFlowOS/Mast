"""
opportunity_scoring/models.py
==============================

Immutable domain models for Opportunity Quality Scoring in the MAST Lead Engine.

Design Rules
------------
- Frozen, slotted dataclasses — runtime mutation is impossible.
- Collections are stored as immutable `tuple`.
- Pure derived evaluation result — contains zero runtime state, persistent identity, policy metadata, or timestamps.
- Zero reporting taxonomy leakage — dimension classifications belong in presentation/analytics layers.
- Strict isolation: Consumes standard library types only.
"""

from __future__ import annotations

from dataclasses import dataclass


def _validate_non_empty_str(value: str, label: str) -> None:
    """Raise ValueError if value is not a non-empty string."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


@dataclass(frozen=True, slots=True)
class ScoreContribution:
    """
    Immutable representation of an individual positive bonus or negative penalty contribution
    applied to an Opportunity score.

    Fields
    ------
    contribution_id
        Normalized contribution rule identifier (e.g. 'missing_website', 'direct_email_validated').
    delta
        Point adjustment contributed to the total score (e.g. +25.0 or -10.0).
    reason
        Human-readable explanation of why this contribution was applied.
    """

    contribution_id: str
    delta: float
    reason: str

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.contribution_id, "contribution_id")

        if not isinstance(self.delta, (int, float)):
            raise TypeError(f"delta must be a float or int; got {type(self.delta)!r}")
        object.__setattr__(self, "delta", float(self.delta))

        _validate_non_empty_str(self.reason, "reason")


@dataclass(frozen=True, slots=True)
class OpportunityScore:
    """
    Immutable derived evaluation value object representing the quality score of an Opportunity.

    Fields
    ------
    opportunity_id
        Canonical reference identifier of the evaluated Opportunity.
    overall_score
        Normalized score clamped to range [0.0, 100.0].
    contributions
        Immutable tuple of flat score contributions providing complete explainability.
    """

    opportunity_id: str
    overall_score: float
    contributions: tuple[ScoreContribution, ...] = ()

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.opportunity_id, "opportunity_id")

        if not isinstance(self.overall_score, (int, float)):
            raise TypeError(
                f"overall_score must be a float or int; got {type(self.overall_score)!r}"
            )

        # Clamp overall score to valid range [0.0, 100.0]
        clamped_score = float(max(0.0, min(100.0, float(self.overall_score))))
        object.__setattr__(self, "overall_score", clamped_score)

        # Coerce contributions collection to immutable tuple
        if not isinstance(self.contributions, tuple):
            contrib_tuple = tuple(self.contributions)
        else:
            contrib_tuple = self.contributions

        for item in contrib_tuple:
            if not isinstance(item, ScoreContribution):
                raise TypeError(
                    f"items in contributions must be ScoreContribution instances; got {type(item)!r}"
                )

        object.__setattr__(self, "contributions", contrib_tuple)


@dataclass(frozen=True, slots=True)
class UniversalBreakdown:
    """
    Immutable representation of the 6 universal business opportunity signals (0.0-100.0).
    Higher values mean higher opportunity/need for a freelancer.
    """

    website: float
    branding: float
    social: float
    growth: float
    newness: float
    tech: float

    def __post_init__(self) -> None:
        for field_name in ("website", "branding", "social", "growth", "newness", "tech"):
            val = float(getattr(self, field_name))
            clamped = max(0.0, min(100.0, val))
            object.__setattr__(self, field_name, clamped)

    def to_dict(self) -> dict[str, float]:
        return {
            "website": self.website,
            "branding": self.branding,
            "social": self.social,
            "growth": self.growth,
            "newness": self.newness,
            "tech": self.tech,
        }


@dataclass(frozen=True, slots=True)
class ProfessionOpportunityScore:
    """
    Immutable derived opportunity score result for a single profession.
    """

    profession_slug: str
    score: float
    breakdown: UniversalBreakdown
    summary: str = ""
    reasons: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.profession_slug, "profession_slug")
        if not isinstance(self.score, (int, float)):
            raise TypeError(f"score must be a float or int; got {type(self.score)!r}")
        clamped_score = float(max(0.0, min(100.0, float(self.score))))
        object.__setattr__(self, "score", round(clamped_score, 2))

        if not isinstance(self.breakdown, UniversalBreakdown):
            raise TypeError(f"breakdown must be a UniversalBreakdown instance; got {type(self.breakdown)!r}")

        if not isinstance(self.reasons, tuple):
            reasons_tuple = tuple(self.reasons)
        else:
            reasons_tuple = self.reasons
        object.__setattr__(self, "reasons", reasons_tuple)


@dataclass(frozen=True, slots=True)
class BusinessOpportunityResult:
    """
    Complete canonical result of evaluating a business across universal breakdown
    and all 12 profession scores.
    """

    business_id: str
    is_disqualified: bool
    universal_breakdown: UniversalBreakdown
    profession_scores: tuple[ProfessionOpportunityScore, ...] = ()

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.business_id, "business_id")
        object.__setattr__(self, "is_disqualified", bool(self.is_disqualified))

        if not isinstance(self.universal_breakdown, UniversalBreakdown):
            raise TypeError(
                f"universal_breakdown must be a UniversalBreakdown instance; got {type(self.universal_breakdown)!r}"
            )

        if not isinstance(self.profession_scores, tuple):
            scores_tuple = tuple(self.profession_scores)
        else:
            scores_tuple = self.profession_scores

        for s in scores_tuple:
            if not isinstance(s, ProfessionOpportunityScore):
                raise TypeError(
                    f"items in profession_scores must be ProfessionOpportunityScore instances; got {type(s)!r}"
                )

        object.__setattr__(self, "profession_scores", scores_tuple)

    def scores_by_slug(self) -> dict[str, ProfessionOpportunityScore]:
        return {s.profession_slug: s for s in self.profession_scores}

