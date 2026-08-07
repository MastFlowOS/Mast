"""
Ad-hoc validation for Phase 6.5 (Fan-In Runtime), run directly:

    python3 validate_fan_in_runtime.py

Not part of the permanent test suite (no test runner conventions were
inspected/assumed for this codebase) — a standalone script exercising
exactly the four "VALIDATION" bullets the Phase 6.5 prompt lists.
"""

from __future__ import annotations

import threading

from engine.contracts import BusinessCandidate, ContactIntel, InstagramIntel, WebsiteIntel
from engine.fan_in_runtime import FanInRuntime
from queues.queue_definition import QueueDefinition
from queues.queue import Queue


def _business(pipeline_id: str) -> BusinessCandidate:
    return BusinessCandidate(pipeline_id=pipeline_id, session_id="s1", provider="google_maps")


def test_one_merge_input_per_pipeline_id():
    queue = Queue(QueueDefinition(queue_id="merge_q", queue_name="Merge Queue", stage="merge"))
    fan_in = FanInRuntime(merge_queue=queue)

    fan_in.register_business(_business("p1"))
    fan_in.record_website_result("p1", WebsiteIntel(pipeline_id="p1", website_reachable=True))
    fan_in.record_instagram_result("p1", InstagramIntel(pipeline_id="p1", profile_reachable=False))
    result = fan_in.record_contact_result("p1", ContactIntel(pipeline_id="p1"))

    assert result is not None, "expected MergeInput on the closing call"
    assert queue.size() == 1, f"expected exactly one enqueued item, got {queue.size()}"
    print("PASS: one MergeInput emitted per pipeline_id")


def test_duplicate_results_do_not_duplicate_merge():
    queue = Queue(QueueDefinition(queue_id="merge_q", queue_name="Merge Queue", stage="merge"))
    fan_in = FanInRuntime(merge_queue=queue)

    fan_in.register_business(_business("p2"))
    fan_in.record_website_result("p2", WebsiteIntel(pipeline_id="p2"))
    fan_in.record_instagram_result("p2", InstagramIntel(pipeline_id="p2"))
    fan_in.record_contact_result("p2", ContactIntel(pipeline_id="p2"))
    assert queue.size() == 1

    # Duplicate delivery of an already-terminal branch result.
    dup = fan_in.record_website_result("p2", WebsiteIntel(pipeline_id="p2", title="different"))
    assert dup is None, "duplicate branch result must not re-trigger release"
    assert queue.size() == 1, "duplicate branch result must not enqueue a second MergeInput"

    # Duplicate delivery after the pipeline_id has already closed.
    late = fan_in.record_contact_dead_letter("p2")
    assert late is None
    assert queue.size() == 1
    print("PASS: duplicate enrichment results do not produce duplicate merges")


def test_correlation_state_released_after_merge():
    queue = Queue(QueueDefinition(queue_id="merge_q", queue_name="Merge Queue", stage="merge"))
    fan_in = FanInRuntime(merge_queue=queue)

    fan_in.register_business(_business("p3"))
    assert fan_in.pending_count() == 1
    fan_in.record_website_result("p3", WebsiteIntel(pipeline_id="p3"))
    fan_in.record_instagram_result("p3", InstagramIntel(pipeline_id="p3"))
    assert fan_in.pending_count() == 1
    fan_in.record_contact_result("p3", ContactIntel(pipeline_id="p3"))

    assert fan_in.pending_count() == 0, "accumulator must be released once complete"
    assert fan_in.is_closed("p3")
    print("PASS: correlation state released after Merge")


def test_dead_letter_counts_as_terminal():
    queue = Queue(QueueDefinition(queue_id="merge_q", queue_name="Merge Queue", stage="merge"))
    fan_in = FanInRuntime(merge_queue=queue)

    fan_in.register_business(_business("p4"))
    fan_in.record_website_dead_letter("p4")
    fan_in.record_instagram_result("p4", InstagramIntel(pipeline_id="p4"))
    result = fan_in.record_contact_dead_letter("p4")

    assert result is not None
    assert result.website_intel is None
    assert result.contact_intel is None
    assert result.instagram_intel is not None
    print("PASS: DEAD-LETTERED branches count as terminal per AD-042 §2")


def test_concurrent_last_arrivals_release_exactly_once():
    queue = Queue(QueueDefinition(queue_id="merge_q", queue_name="Merge Queue", stage="merge"))
    fan_in = FanInRuntime(merge_queue=queue)

    fan_in.register_business(_business("p5"))
    fan_in.record_website_result("p5", WebsiteIntel(pipeline_id="p5"))
    fan_in.record_instagram_result("p5", InstagramIntel(pipeline_id="p5"))

    results = []

    def deliver_contact():
        results.append(fan_in.record_contact_result("p5", ContactIntel(pipeline_id="p5")))

    threads = [threading.Thread(target=deliver_contact) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    successes = [r for r in results if r is not None]
    assert len(successes) == 1, f"expected exactly one winner, got {len(successes)}"
    assert queue.size() == 1
    print("PASS: concurrent last-arrivals still release exactly once")


if __name__ == "__main__":
    test_one_merge_input_per_pipeline_id()
    test_duplicate_results_do_not_duplicate_merge()
    test_correlation_state_released_after_merge()
    test_dead_letter_counts_as_terminal()
    test_concurrent_last_arrivals_release_exactly_once()
    print("\nAll Phase 6.5 validations passed.")
