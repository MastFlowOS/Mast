"""
analytics/models.py
===================

Immutable domain models for Analytics Engine (Subsystem 18) in MAST Lead Engine 2.0.

Design Rules
------------
- Frozen, slotted dataclasses — runtime mutation is impossible.
- Collections are stored as immutable `tuple`.
- Pure canonical domain models — zero presentation, charting, UI, AI forecasting, or infrastructure concerns.
- Built strictly from 4 core analytical primitives and universal dimensional breakdowns.
"""

from __future__ import annotations

from dataclasses import dataclass


def _validate_non_empty_str(value: str, label: str) -> None:
    """Raise TypeError if not str, ValueError if empty str."""
    if not isinstance(value, str):
        raise TypeError(f"{label} must be a str; got {type(value)!r}")
    if not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


def _validate_non_negative_int(value: int, label: str) -> None:
    """Raise TypeError if not int or is bool, ValueError if negative."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{label} must be an int; got {type(value)!r}")
    if value < 0:
        raise ValueError(f"{label} must be >= 0; got {value}")


def _validate_float_or_int(value: float | int, label: str) -> float:
    """Raise TypeError if not float or int or is bool; returns float."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{label} must be a float or int; got {type(value)!r}")
    return float(value)


def _validate_ratio(value: float | int, label: str = "ratio") -> float:
    """Raise TypeError if not numeric, ValueError if not within [0.0, 1.0]."""
    val = _validate_float_or_int(value, label)
    if not (0.0 <= val <= 1.0):
        raise ValueError(f"{label} must be within [0.0, 1.0]; got {val}")
    return val


# ──────────────────────────────────────────────────────────────────────────────
# 1. CORE ANALYTICAL PRIMITIVES
# ──────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True, slots=True)
class DescriptiveStats:
    """Canonical descriptive statistics for a numerical metric series."""

    count: int
    mean: float
    median: float
    std_dev: float
    min_val: float
    max_val: float

    def __post_init__(self) -> None:
        _validate_non_negative_int(self.count, "count")
        mean_val = _validate_float_or_int(self.mean, "mean")
        median_val = _validate_float_or_int(self.median, "median")
        std_dev_val = _validate_float_or_int(self.std_dev, "std_dev")
        min_v = _validate_float_or_int(self.min_val, "min_val")
        max_v = _validate_float_or_int(self.max_val, "max_val")

        if std_dev_val < 0.0:
            raise ValueError(f"std_dev must be >= 0.0; got {std_dev_val}")
        if min_v > max_v:
            raise ValueError(f"min_val ({min_v}) cannot exceed max_val ({max_v})")
        if self.count > 0:
            if not (min_v <= mean_val <= max_v):
                raise ValueError(f"mean ({mean_val}) must be within [min_val ({min_v}), max_val ({max_v})]")
            if not (min_v <= median_val <= max_v):
                raise ValueError(f"median ({median_val}) must be within [min_val ({min_v}), max_val ({max_v})]")

        object.__setattr__(self, "mean", mean_val)
        object.__setattr__(self, "median", median_val)
        object.__setattr__(self, "std_dev", std_dev_val)
        object.__setattr__(self, "min_val", min_v)
        object.__setattr__(self, "max_val", max_v)


@dataclass(frozen=True, slots=True)
class DistributionBucket:
    """Histogram bucket representing a numeric range distribution."""

    range_low: float
    range_high: float
    count: int
    ratio: float

    def __post_init__(self) -> None:
        low = _validate_float_or_int(self.range_low, "range_low")
        high = _validate_float_or_int(self.range_high, "range_high")
        if low > high:
            raise ValueError(f"range_low ({low}) cannot exceed range_high ({high})")
        object.__setattr__(self, "range_low", low)
        object.__setattr__(self, "range_high", high)
        _validate_non_negative_int(self.count, "count")
        object.__setattr__(self, "ratio", _validate_ratio(self.ratio, "ratio"))


@dataclass(frozen=True, slots=True)
class CategoryFrequency:
    """Frequency count and ratio for a discrete categorical item."""

    category: str
    count: int
    ratio: float

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.category, "category")
        _validate_non_negative_int(self.count, "count")
        object.__setattr__(self, "ratio", _validate_ratio(self.ratio, "ratio"))


@dataclass(frozen=True, slots=True)
class RatioMetric:
    """Part-to-whole ratio measurement."""

    total: int
    count: int
    ratio: float

    def __post_init__(self) -> None:
        _validate_non_negative_int(self.total, "total")
        _validate_non_negative_int(self.count, "count")
        if self.count > self.total:
            raise ValueError(f"count ({self.count}) cannot exceed total ({self.total})")
        object.__setattr__(self, "ratio", _validate_ratio(self.ratio, "ratio"))


# ──────────────────────────────────────────────────────────────────────────────
# 2. CANONICAL DOMAIN METRIC COMPOSITIONS
# ──────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True, slots=True)
class EngineVolumeAnalytics:
    """Volume breakdown across canonical engine components."""

    total_records: int
    component_frequencies: tuple[CategoryFrequency, ...] = ()

    def __post_init__(self) -> None:
        _validate_non_negative_int(self.total_records, "total_records")
        if not isinstance(self.component_frequencies, tuple):
            object.__setattr__(self, "component_frequencies", tuple(self.component_frequencies))
        for item in self.component_frequencies:
            if not isinstance(item, CategoryFrequency):
                raise TypeError(
                    f"items in component_frequencies must be CategoryFrequency instances; got {type(item)!r}"
                )


@dataclass(frozen=True, slots=True)
class QualificationFunnelAnalytics:
    """Qualification conversion funnel metrics."""

    qualification_ratio: RatioMetric
    status_frequencies: tuple[CategoryFrequency, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.qualification_ratio, RatioMetric):
            raise TypeError(
                f"qualification_ratio must be a RatioMetric instance; got {type(self.qualification_ratio)!r}"
            )
        if not isinstance(self.status_frequencies, tuple):
            object.__setattr__(self, "status_frequencies", tuple(self.status_frequencies))
        for item in self.status_frequencies:
            if not isinstance(item, CategoryFrequency):
                raise TypeError(
                    f"items in status_frequencies must be CategoryFrequency instances; got {type(item)!r}"
                )


@dataclass(frozen=True, slots=True)
class ScoreAnalytics:
    """Opportunity score descriptive stats and decile distribution."""

    stats: DescriptiveStats
    histogram: tuple[DistributionBucket, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.stats, DescriptiveStats):
            raise TypeError(f"stats must be a DescriptiveStats instance; got {type(self.stats)!r}")
        if not isinstance(self.histogram, tuple):
            object.__setattr__(self, "histogram", tuple(self.histogram))
        for item in self.histogram:
            if not isinstance(item, DistributionBucket):
                raise TypeError(
                    f"items in histogram must be DistributionBucket instances; got {type(item)!r}"
                )


@dataclass(frozen=True, slots=True)
class PriorityAnalytics:
    """Opportunity priority score stats, eligibility ratio, and distribution."""

    stats: DescriptiveStats
    eligibility_ratio: RatioMetric
    histogram: tuple[DistributionBucket, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.stats, DescriptiveStats):
            raise TypeError(f"stats must be a DescriptiveStats instance; got {type(self.stats)!r}")
        if not isinstance(self.eligibility_ratio, RatioMetric):
            raise TypeError(
                f"eligibility_ratio must be a RatioMetric instance; got {type(self.eligibility_ratio)!r}"
            )
        if not isinstance(self.histogram, tuple):
            object.__setattr__(self, "histogram", tuple(self.histogram))
        for item in self.histogram:
            if not isinstance(item, DistributionBucket):
                raise TypeError(
                    f"items in histogram must be DistributionBucket instances; got {type(item)!r}"
                )


@dataclass(frozen=True, slots=True)
class WorkflowAnalytics:
    """Workflow execution status frequencies and completion ratio."""

    completion_ratio: RatioMetric
    status_frequencies: tuple[CategoryFrequency, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.completion_ratio, RatioMetric):
            raise TypeError(
                f"completion_ratio must be a RatioMetric instance; got {type(self.completion_ratio)!r}"
            )
        if not isinstance(self.status_frequencies, tuple):
            object.__setattr__(self, "status_frequencies", tuple(self.status_frequencies))
        for item in self.status_frequencies:
            if not isinstance(item, CategoryFrequency):
                raise TypeError(
                    f"items in status_frequencies must be CategoryFrequency instances; got {type(item)!r}"
                )


@dataclass(frozen=True, slots=True)
class GroupedMetric:
    """Analytical metrics calculated for a single categorical group key."""

    group_key: str
    count: int
    qualification_ratio: RatioMetric
    mean_score: float

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.group_key, "group_key")
        _validate_non_negative_int(self.count, "count")
        if not isinstance(self.qualification_ratio, RatioMetric):
            raise TypeError(
                f"qualification_ratio must be a RatioMetric instance; got {type(self.qualification_ratio)!r}"
            )
        object.__setattr__(self, "mean_score", _validate_float_or_int(self.mean_score, "mean_score"))


@dataclass(frozen=True, slots=True)
class DimensionBreakdown:
    """Categorical breakdown across a named engine dimension (e.g. niche_id, country)."""

    dimension_name: str
    groups: tuple[GroupedMetric, ...] = ()

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.dimension_name, "dimension_name")
        if not isinstance(self.groups, tuple):
            object.__setattr__(self, "groups", tuple(self.groups))
        for item in self.groups:
            if not isinstance(item, GroupedMetric):
                raise TypeError(
                    f"items in groups must be GroupedMetric instances; got {type(item)!r}"
                )


# ──────────────────────────────────────────────────────────────────────────────
# 3. TOP-LEVEL OUTPUT BOUNDARY
# ──────────────────────────────────────────────────────────────────────────────

@dataclass(frozen=True, slots=True)
class AnalyticsReport:
    """Immutable, pure canonical analytical computation result."""

    volume: EngineVolumeAnalytics
    qualification: QualificationFunnelAnalytics
    scores: ScoreAnalytics
    priorities: PriorityAnalytics
    workflows: WorkflowAnalytics
    dimension_breakdowns: tuple[DimensionBreakdown, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.volume, EngineVolumeAnalytics):
            raise TypeError(f"volume must be an EngineVolumeAnalytics instance; got {type(self.volume)!r}")
        if not isinstance(self.qualification, QualificationFunnelAnalytics):
            raise TypeError(
                f"qualification must be a QualificationFunnelAnalytics instance; got {type(self.qualification)!r}"
            )
        if not isinstance(self.scores, ScoreAnalytics):
            raise TypeError(f"scores must be a ScoreAnalytics instance; got {type(self.scores)!r}")
        if not isinstance(self.priorities, PriorityAnalytics):
            raise TypeError(f"priorities must be a PriorityAnalytics instance; got {type(self.priorities)!r}")
        if not isinstance(self.workflows, WorkflowAnalytics):
            raise TypeError(f"workflows must be a WorkflowAnalytics instance; got {type(self.workflows)!r}")
        if not isinstance(self.dimension_breakdowns, tuple):
            object.__setattr__(self, "dimension_breakdowns", tuple(self.dimension_breakdowns))
        for item in self.dimension_breakdowns:
            if not isinstance(item, DimensionBreakdown):
                raise TypeError(
                    f"items in dimension_breakdowns must be DimensionBreakdown instances; got {type(item)!r}"
                )
