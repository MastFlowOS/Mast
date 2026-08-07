"""
analytics/service.py
====================

Stateless mathematical computation engine for Subsystem 18 (Analytics Engine).
"""

from __future__ import annotations

import math
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
from engine_context.models import EngineContext
from workflow.models import WorkflowStatus


class AnalyticsService:
    """Stateless service computing canonical analytics over EngineContext snapshots."""

    @classmethod
    def compute_analytics(cls, context: EngineContext) -> AnalyticsReport:
        """
        Compute canonical analytics snapshot deterministically.

        Raises:
            TypeError: If context is not an EngineContext instance.
        """
        if not isinstance(context, EngineContext):
            raise TypeError(
                f"context must be an EngineContext instance; got {type(context)!r}"
            )

        volume = cls._compute_volume(context)
        qualification = cls._compute_qualification(context)
        scores = cls._compute_scores(context)
        priorities = cls._compute_priorities(context)
        workflows = cls._compute_workflows(context)
        breakdowns = cls._compute_dimension_breakdowns(context)

        return AnalyticsReport(
            volume=volume,
            qualification=qualification,
            scores=scores,
            priorities=priorities,
            workflows=workflows,
            dimension_breakdowns=breakdowns,
        )

    @classmethod
    def _compute_volume(cls, context: EngineContext) -> EngineVolumeAnalytics:
        """Compute volume distribution across canonical engine context components."""
        biz_count = 1 if context.business is not None else 0
        opp_count = len(context.opportunities)
        qual_count = len(context.qualifications)
        score_count = len(context.scores)
        prio_count = len(context.priorities)
        rank_count = len(context.ranks)
        mission_count = len(context.missions)
        wf_count = len(context.workflows)

        total_records = (
            biz_count
            + opp_count
            + qual_count
            + score_count
            + prio_count
            + rank_count
            + mission_count
            + wf_count
        )

        counts = [
            ("BUSINESS", biz_count),
            ("OPPORTUNITY", opp_count),
            ("QUALIFICATION", qual_count),
            ("SCORE", score_count),
            ("PRIORITY", prio_count),
            ("RANK", rank_count),
            ("MISSION", mission_count),
            ("WORKFLOW", wf_count),
        ]

        frequencies = tuple(
            CategoryFrequency(
                category=cat,
                count=cnt,
                ratio=float(cnt / total_records) if total_records > 0 else 0.0,
            )
            for cat, cnt in counts
        )

        return EngineVolumeAnalytics(
            total_records=total_records,
            component_frequencies=frequencies,
        )

    @classmethod
    def _compute_qualification(cls, context: EngineContext) -> QualificationFunnelAnalytics:
        """Compute qualification conversion funnel metrics."""
        total_opps = len(context.opportunities)
        quals = context.qualifications
        total_quals = len(quals)

        status_counts: dict[str, int] = {}
        qualified_count = 0

        for q in quals:
            status_counts[q.status] = status_counts.get(q.status, 0) + 1
            if q.status == "QUALIFIED":
                qualified_count += 1

        ratio_val = float(qualified_count / total_opps) if total_opps > 0 else 0.0
        qualification_ratio = RatioMetric(
            total=total_opps,
            count=qualified_count,
            ratio=ratio_val,
        )

        status_frequencies = tuple(
            CategoryFrequency(
                category=status,
                count=cnt,
                ratio=float(cnt / total_quals) if total_quals > 0 else 0.0,
            )
            for status, cnt in sorted(status_counts.items())
        )

        return QualificationFunnelAnalytics(
            qualification_ratio=qualification_ratio,
            status_frequencies=status_frequencies,
        )

    @classmethod
    def _compute_scores(cls, context: EngineContext) -> ScoreAnalytics:
        """Compute opportunity score statistics and decile distribution histogram."""
        values = tuple(float(s.overall_score) for s in context.scores)
        stats = cls._compute_stats(values)
        histogram = cls._compute_histogram(values)
        return ScoreAnalytics(stats=stats, histogram=histogram)

    @classmethod
    def _compute_priorities(cls, context: EngineContext) -> PriorityAnalytics:
        """Compute priority score statistics, eligibility ratio, and distribution histogram."""
        values = tuple(float(p.priority_score) for p in context.priorities)
        stats = cls._compute_stats(values)

        total_prios = len(context.priorities)
        eligible_count = sum(1 for p in context.priorities if p.is_eligible)
        ratio_val = float(eligible_count / total_prios) if total_prios > 0 else 0.0
        eligibility_ratio = RatioMetric(
            total=total_prios,
            count=eligible_count,
            ratio=ratio_val,
        )

        histogram = cls._compute_histogram(values)
        return PriorityAnalytics(
            stats=stats,
            eligibility_ratio=eligibility_ratio,
            histogram=histogram,
        )

    @classmethod
    def _compute_workflows(cls, context: EngineContext) -> WorkflowAnalytics:
        """Compute workflow execution status frequencies and completion ratio."""
        wfs = context.workflows
        total_wfs = len(wfs)

        status_counts: dict[str, int] = {}
        completed_count = 0

        for w in wfs:
            status_str = w.status.value if isinstance(w.status, WorkflowStatus) else str(w.status)
            status_counts[status_str] = status_counts.get(status_str, 0) + 1
            if status_str == WorkflowStatus.COMPLETED.value:
                completed_count += 1

        comp_ratio_val = float(completed_count / total_wfs) if total_wfs > 0 else 0.0
        completion_ratio = RatioMetric(
            total=total_wfs,
            count=completed_count,
            ratio=comp_ratio_val,
        )

        status_frequencies = tuple(
            CategoryFrequency(
                category=status,
                count=cnt,
                ratio=float(cnt / total_wfs) if total_wfs > 0 else 0.0,
            )
            for status, cnt in sorted(status_counts.items())
        )

        return WorkflowAnalytics(
            completion_ratio=completion_ratio,
            status_frequencies=status_frequencies,
        )

    @classmethod
    def _compute_dimension_breakdowns(
        cls, context: EngineContext
    ) -> tuple[DimensionBreakdown, ...]:
        """Compute grouped analytics grouped by canonical engine dimensions (e.g. niche_id)."""
        qual_by_opp = {q.opportunity_id: q for q in context.qualifications}
        score_by_opp = {s.opportunity_id: s for s in context.scores}

        niche_opps_map: dict[str, list] = {}
        for opp in context.opportunities:
            niche_opps_map.setdefault(opp.niche_id, []).append(opp)

        grouped_metrics = []
        for niche_id, opps in sorted(niche_opps_map.items()):
            niche_total = len(opps)
            niche_qualified = 0
            niche_scores: list[float] = []

            for opp in opps:
                q = qual_by_opp.get(opp.opportunity_id)
                if q and q.status == "QUALIFIED":
                    niche_qualified += 1
                s = score_by_opp.get(opp.opportunity_id)
                if s:
                    niche_scores.append(float(s.overall_score))

            qual_ratio_val = float(niche_qualified / niche_total) if niche_total > 0 else 0.0
            qual_ratio = RatioMetric(
                total=niche_total,
                count=niche_qualified,
                ratio=qual_ratio_val,
            )
            mean_score = (
                float(sum(niche_scores) / len(niche_scores)) if niche_scores else 0.0
            )

            grouped_metrics.append(
                GroupedMetric(
                    group_key=niche_id,
                    count=niche_total,
                    qualification_ratio=qual_ratio,
                    mean_score=mean_score,
                )
            )

        niche_breakdown = DimensionBreakdown(
            dimension_name="niche_id",
            groups=tuple(grouped_metrics),
        )

        return (niche_breakdown,)

    @staticmethod
    def _compute_stats(values: tuple[float, ...]) -> DescriptiveStats:
        """Pure math calculation for descriptive statistics over a numeric sequence (population variance)."""
        count = len(values)
        if count == 0:
            return DescriptiveStats(
                count=0,
                mean=0.0,
                median=0.0,
                std_dev=0.0,
                min_val=0.0,
                max_val=0.0,
            )

        mean_val = float(sum(values) / count)
        sorted_vals = sorted(values)
        mid = count // 2
        median_val = (
            float(sorted_vals[mid])
            if count % 2 != 0
            else float((sorted_vals[mid - 1] + sorted_vals[mid]) / 2.0)
        )

        variance = sum((x - mean_val) ** 2 for x in values) / count
        std_dev_val = float(math.sqrt(variance))

        return DescriptiveStats(
            count=count,
            mean=mean_val,
            median=median_val,
            std_dev=std_dev_val,
            min_val=float(sorted_vals[0]),
            max_val=float(sorted_vals[-1]),
        )

    @staticmethod
    def _compute_histogram(
        values: tuple[float, ...], num_buckets: int = 10
    ) -> tuple[DistributionBucket, ...]:
        """Pure math calculation for histogram range buckets over a numeric sequence."""
        count = len(values)
        if count == 0:
            return ()

        min_val = float(min(values))
        max_val = float(max(values))

        if min_val == max_val:
            return (
                DistributionBucket(
                    range_low=min_val,
                    range_high=max_val,
                    count=count,
                    ratio=1.0,
                ),
            )

        step = (max_val - min_val) / num_buckets
        bucket_counts = [0] * num_buckets

        for v in values:
            if v == max_val:
                idx = num_buckets - 1
            else:
                idx = int((v - min_val) / step)
                if idx < 0:
                    idx = 0
                elif idx >= num_buckets:
                    idx = num_buckets - 1
            bucket_counts[idx] += 1

        buckets = []
        for i in range(num_buckets):
            low = min_val + i * step
            high = min_val + (i + 1) * step if i < num_buckets - 1 else max_val
            ratio = float(bucket_counts[i] / count)

            buckets.append(
                DistributionBucket(
                    range_low=float(low),
                    range_high=float(high),
                    count=bucket_counts[i],
                    ratio=ratio,
                )
            )

        return tuple(buckets)
