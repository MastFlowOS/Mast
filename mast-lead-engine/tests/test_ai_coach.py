"""
test_ai_coach.py
================
Pytest suite for Subsystem 17 (AI Coach).
"""

import pytest
from dataclasses import FrozenInstanceError

from engine_context.models import (
    ContextProjectionRequest,
    ContextSubject,
    ContextSubjectType,
)
from engine_context.service import ContextProjectionService

from ai_coach.models import (
    CoachInsight,
    CoachingReport,
    CoachingRequest,
    InsightCategory,
)
from ai_coach.service import AICoachService


def test_coach_insight_creation_and_immutability():
    insight = CoachInsight(
        category=InsightCategory.EXPLANATION,
        title="Valid Title",
        content="Valid Content",
    )
    assert insight.category == InsightCategory.EXPLANATION
    assert insight.title == "Valid Title"
    assert insight.content == "Valid Content"

    with pytest.raises((FrozenInstanceError, AttributeError)):
        insight.title = "New Title"  # type: ignore


def test_coach_insight_validation():
    with pytest.raises(TypeError):
        CoachInsight(category="INVALID", title="T", content="C")  # type: ignore

    with pytest.raises(ValueError):
        CoachInsight(category=InsightCategory.RISK, title="   ", content="C")

    with pytest.raises(ValueError):
        CoachInsight(category=InsightCategory.RISK, title="T", content="")


def test_coaching_request_validation():
    subject = ContextSubject(subject_id="s1", subject_type=ContextSubjectType.BUSINESS)
    req = ContextProjectionRequest(subject=subject)
    ctx = ContextProjectionService.project(req)

    coaching_req = CoachingRequest(engine_context=ctx)
    assert coaching_req.engine_context is ctx

    with pytest.raises(TypeError):
        CoachingRequest(engine_context="invalid")  # type: ignore


def test_coaching_report_tuple_coercion():
    insight = CoachInsight(
        category=InsightCategory.OPPORTUNITY,
        title="Opp Title",
        content="Opp Content",
    )
    report = CoachingReport(
        subject_id="sub-1",
        subject_type="OPPORTUNITY",
        insights=[insight],  # Passed as list
    )
    assert isinstance(report.insights, tuple)
    assert report.insights[0] == insight


def test_ai_coach_service_generate_report():
    subject = ContextSubject(subject_id="sub-100", subject_type=ContextSubjectType.MISSION)
    req = ContextProjectionRequest(subject=subject)
    ctx = ContextProjectionService.project(req)
    coaching_req = CoachingRequest(engine_context=ctx)

    insight = CoachInsight(
        category=InsightCategory.SUMMARY,
        title="Mission Summary",
        content="Mission performance is optimal.",
    )

    report = AICoachService.generate_coaching_report(coaching_req, insights=[insight])
    assert report.subject_id == "sub-100"
    assert report.subject_type == "MISSION"
    assert len(report.insights) == 1
    assert report.insights[0] == insight
