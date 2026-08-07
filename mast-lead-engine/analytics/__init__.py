"""
analytics
=========

Subsystem 18 — Analytics Engine for MAST Lead Engine 2.0.

Provides deterministic, immutable analytical computation over canonical EngineContext snapshots.
"""

from analytics.models import (
    AnalyticsReport,
    CategoryFrequency,
    DescriptiveStats,
    DimensionBreakdown,
    DistributionBucket,
    EngineVolumeAnalytics,
    GroupedMetric,
    PriorityAnalytics,
    QualificationFunnelAnalytics,
    RatioMetric,
    ScoreAnalytics,
    WorkflowAnalytics,
)
from analytics.service import AnalyticsService

__all__ = [
    "DescriptiveStats",
    "DistributionBucket",
    "CategoryFrequency",
    "RatioMetric",
    "EngineVolumeAnalytics",
    "QualificationFunnelAnalytics",
    "ScoreAnalytics",
    "PriorityAnalytics",
    "WorkflowAnalytics",
    "GroupedMetric",
    "DimensionBreakdown",
    "AnalyticsReport",
    "AnalyticsService",
]
