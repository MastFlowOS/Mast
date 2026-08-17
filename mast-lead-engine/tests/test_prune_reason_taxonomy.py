"""
Unit tests for engine/prune_reason_taxonomy.py

Lead-Yield Waste Fix — observability step (item 6). These tests cover
the pure classifier only; see test_fan_in_prune_reason_counts in
tests/test_adapters_and_pruning.py for the FanInRuntime-integrated
counting behavior.
"""

from engine.prune_reason_taxonomy import (
    ALL_CATEGORIES,
    CONTACT_FAILURE,
    MISSING_EMAIL,
    MISSING_PHONE,
    OTHER,
    UNREACHABLE_WEBSITE,
    classify_prune_reason,
)


def test_classifies_every_reason_string_actually_used_in_production():
    """
    These four strings are the exact reasons execution_driver.py's
    _website_downstream / _contact_downstream closures pass to
    FanInRuntime.prune_business() today. If any of these ever changes,
    this test should fail loudly rather than silently reclassifying as
    OTHER.
    """
    assert classify_prune_reason("unreachable_website") == UNREACHABLE_WEBSITE
    assert classify_prune_reason("unreachable_website_no_email") == UNREACHABLE_WEBSITE
    assert classify_prune_reason("missing_required_channel:email") == MISSING_EMAIL
    assert classify_prune_reason("missing_required_channel:phone") == MISSING_PHONE


def test_unreachable_website_wins_over_incidental_email_mention():
    """
    'unreachable_website_no_email' contains the substring 'email', but the
    root cause is the website being unreachable, not an email-specific
    failure — this must classify as UNREACHABLE_WEBSITE, not MISSING_EMAIL.
    """
    assert classify_prune_reason("unreachable_website_no_email") == UNREACHABLE_WEBSITE


def test_contact_stage_reason_classifies_as_contact_failure():
    assert classify_prune_reason("contact_extraction_failed") == CONTACT_FAILURE
    assert classify_prune_reason("contact:403") == CONTACT_FAILURE


def test_unrecognized_reason_falls_back_to_other_never_raises():
    """
    A future reason string this table hasn't been extended for must never
    raise — it should report as OTHER so a new reason can never break
    counting.
    """
    assert classify_prune_reason("some_future_reason_not_in_the_table") == OTHER
    assert classify_prune_reason("") == OTHER
    assert classify_prune_reason("early_pruned") == OTHER  # the method's own default


def test_classification_is_case_insensitive_and_whitespace_tolerant():
    assert classify_prune_reason("  UNREACHABLE_WEBSITE  ") == UNREACHABLE_WEBSITE
    assert classify_prune_reason("Missing_Required_Channel:EMAIL") == MISSING_EMAIL


def test_all_categories_lists_every_possible_return_value():
    for reason in [
        "unreachable_website",
        "unreachable_website_no_email",
        "missing_required_channel:email",
        "missing_required_channel:phone",
        "contact_extraction_failed",
        "totally_unknown",
    ]:
        assert classify_prune_reason(reason) in ALL_CATEGORIES
