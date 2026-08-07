"""
MAST Engine V2 — Batch Intelligence Persistence Backend
==========================================================

Source: Persistence Integration milestone, Parts 3-5. Persists and
retrieves the five previously-in-memory-only domain outputs of the
batch intelligence chain (Qualification -> Scoring -> Prioritization ->
Ranking -> Mission Generation -> Workflow Initialization):

    opportunity_prioritization.models.OpportunityPriority
    opportunity_ranking.models.RankedOpportunity
    mission_generation.models.Mission
    workflow.models.WorkflowState
    feedback.models.FeedbackRecord

against the five tables migrations/022_batch_intelligence_persistence.sql
defines.

Responsibility
--------------
Exactly the same shape as storage_backends/supabase_backend.py's
SupabaseStorageBackend, deliberately not a new abstraction:

    domain dataclasses -> persist_*() -> one or more PostgREST inserts
    PostgREST rows -> fetch_*() -> domain dataclasses

It does not validate, qualify, score, rank, or make any business
decision — all of that already happened upstream (opportunity_
prioritization, opportunity_ranking, mission_generation, workflow,
feedback are the exclusive owners of that logic). It does not retry,
cache, own a queue, or own runtime state. It does not catch or retry on
failure — `urllib.error.HTTPError` / `URLError` / a malformed response
propagate unmodified, exactly like SupabaseStorageBackend's own
`persist()`.

Why one class for five tables, unlike SupabaseStorageBackend (one
table)
------------------------------------------------------------------------
SupabaseStorageBackend implements exactly one protocol method for
exactly one table because that is everything
_StoragePersistenceProtocol asks for. Nothing in this codebase defines
an equivalent shared protocol for the batch intelligence chain's five
outputs — they are five distinct dataclasses persisted and retrieved
together, at the same two call sites (session-completion write in
service.py, on-demand reads in the workflow/mission_intelligence/
analytics/ai_coach CLI modes in service.py). Splitting this into five
single-table classes would scatter one coherent transactional unit (see
`persist_batch_result()`) across five constructor-injected objects a
caller would have to wire up identically every time; one class with
five narrow methods mirrors how run_batch_intelligence() itself already
returns all five as one dict, not five separate calls.

Transactional consistency (Part 4 requirement) — an honest limitation
------------------------------------------------------------------------
PostgREST (accessed here the same way SupabaseStorageBackend already
does — plain HTTP via `urllib`, no supabase-py dependency) has no
client-driven multi-table transaction primitive over its REST surface;
a single POST is atomic only for the rows within that one request.
`persist_batch_result()` therefore issues its four inserts in strict
dependency order — priorities, then ranks, then missions, then
workflow_states — the same order run_batch_intelligence() itself
computes them in (Ranking depends on Prioritization; Mission Generation
depends on Ranking + eligibility; Workflow Initialization depends on
Mission Generation). If a later insert in the sequence fails, every
row already written references only already-written parents (no
workflow_state row can exist for a mission that failed to insert,
etc.) — the persisted state is always a *consistent prefix* of the
batch result, never a row pointing at nothing. This is the same
honesty standard engine/coordinator.py's own `build_runtime_context()`
docstring and storage_backends/supabase_backend.py's own module
docstring already hold themselves to when a real gap exists in the
surrounding architecture (no Postgres transaction handle is exposed
anywhere in this repository's Python layer) — flagged here rather than
silently presented as a real cross-table transaction.

Upsert semantics
------------------
opportunity_priorities / ranked_opportunities / missions /
workflow_states are all keyed by immutable identifiers
(opportunity_id, or (session_id, opportunity_id) for the
session-scoped ranked_opportunities table — see that table's own
migration comment). Every insert here uses PostgREST's
`Prefer: resolution=merge-duplicates` upsert semantics against each
table's declared primary key, so persisting the same opportunity_id
twice (e.g. a retried write after a transient network failure) is
idempotent rather than raising a duplicate-key error. feedback_records
is the one exception — feedback is an append-only observation stream
(see that table's own migration comment) and is always a plain insert.

Configuration
-------------
Identical convention to SupabaseStorageBackend: `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` from the environment, both constructor-injected
and overridable, both required (raises at construction, not inside a
call), because this backend needs to bypass Row Level Security the same
way SupabaseStorageBackend already does.

Status
------
Persistence Integration milestone, Part 3/Storage Backend. Uses only
the standard library (`urllib`, `json`), matching
storage_backends/supabase_backend.py's own justification for not adding
a new third-party dependency.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Iterable, Optional, Sequence

from feedback.models import (
    FeedbackEvidence,
    FeedbackOutcomeType,
    FeedbackRecord,
    FeedbackTargetType,
)
from mission_generation.models import Mission, MissionType
from opportunity_prioritization.models import OpportunityPriority
from opportunity_ranking.models import RankedOpportunity
from workflow.models import WorkflowState, WorkflowStatus

#: Matches storage_backends/supabase_backend.py's own default — same HTTP
#: budget, same rationale (workers/storage_worker.py's
#: DEFAULT_TIMEOUT_SECONDS).
DEFAULT_HTTP_TIMEOUT_SECONDS = 3.0

TABLE_PRIORITIES = "opportunity_priorities"
TABLE_RANKS = "ranked_opportunities"
TABLE_MISSIONS = "missions"
TABLE_WORKFLOW_STATES = "workflow_states"
TABLE_FEEDBACK = "feedback_records"


class BatchIntelligenceBackendError(Exception):
    """
    Raised only for a malformed *successful* PostgREST response (2xx
    body that cannot be turned into the expected domain dataclass(es))
    — mirrors SupabaseStorageBackendError's identical role. Network /
    HTTP failures propagate as the underlying
    `urllib.error.HTTPError` / `URLError` unchanged.
    """


class SupabaseBatchIntelligenceBackend:
    """
    Concrete persistence backend for the batch intelligence chain's five
    domain outputs, backed by Supabase (PostgREST). See module
    docstring for full rationale.
    """

    def __init__(
        self,
        *,
        supabase_url: Optional[str] = None,
        supabase_key: Optional[str] = None,
        timeout_seconds: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
    ) -> None:
        resolved_url = supabase_url or os.environ.get("SUPABASE_URL")
        resolved_key = supabase_key or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not resolved_url:
            raise ValueError(
                "SupabaseBatchIntelligenceBackend requires supabase_url or "
                "the SUPABASE_URL environment variable."
            )
        if not resolved_key:
            raise ValueError(
                "SupabaseBatchIntelligenceBackend requires supabase_key or "
                "the SUPABASE_SERVICE_ROLE_KEY environment variable."
            )
        self._base_url = resolved_url.rstrip("/")
        self._key = resolved_key
        self._timeout_seconds = timeout_seconds

    # -- Part 4: write path -------------------------------------------------

    def persist_batch_result(
        self,
        session_id: str,
        *,
        priorities: Sequence[OpportunityPriority] = (),
        ranked_opportunities: Sequence[RankedOpportunity] = (),
        missions: Sequence[Mission] = (),
        workflow_states: Sequence[WorkflowState] = (),
    ) -> None:
        """
        Persist one session's complete batch intelligence result. Must
        only be called with the output of a successfully-completed
        run_batch_intelligence() call (Part 4: "persist only after
        successful completion... do not persist partially-computed
        intelligence") — this method performs no eligibility/lineage
        re-validation of its own; that already happened in the domain
        services that produced these tuples.

        Writes in strict dependency order (see module docstring,
        "Transactional consistency"). Raises on the first failure and
        does not attempt the remaining tables — the caller (service.py)
        already logs-not-raises around the whole batch intelligence
        chain, matching how it already treats run_batch_intelligence()
        failures.
        """
        if priorities:
            self._upsert_rows(
                TABLE_PRIORITIES,
                [self._priority_to_row(p, session_id) for p in priorities],
                on_conflict="opportunity_id",
            )
        if ranked_opportunities:
            self._upsert_rows(
                TABLE_RANKS,
                [self._rank_to_row(r, session_id) for r in ranked_opportunities],
                on_conflict="session_id,opportunity_id",
            )
        if missions:
            self._upsert_rows(
                TABLE_MISSIONS,
                [self._mission_to_row(m, session_id) for m in missions],
                on_conflict="opportunity_id",
            )
        if workflow_states:
            self._upsert_rows(
                TABLE_WORKFLOW_STATES,
                [self._workflow_state_to_row(w, session_id) for w in workflow_states],
                on_conflict="opportunity_id",
            )

    def persist_feedback(self, record: FeedbackRecord) -> FeedbackRecord:
        """
        Append one FeedbackRecord (feedback_records is append-only —
        see that table's own migration comment). Returns the same
        record unchanged (feedback.models.FeedbackRecord carries no
        surrogate id for a response to populate back into — nothing to
        round-trip, unlike StorageWorker's StoredOpportunity).
        """
        if not isinstance(record, FeedbackRecord):
            raise TypeError(
                f"record must be a FeedbackRecord instance; got {type(record)!r}"
            )
        self._insert_rows(TABLE_FEEDBACK, [self._feedback_to_row(record)])
        return record

    # -- Part 5: read path ----------------------------------------------------

    def fetch_priority(self, opportunity_id: str) -> Optional[OpportunityPriority]:
        rows = self._select(
            TABLE_PRIORITIES, {"opportunity_id": f"eq.{opportunity_id}"}
        )
        if not rows:
            return None
        return self._row_to_priority(rows[0])

    def fetch_priorities_for_session(
        self, session_id: str
    ) -> tuple[OpportunityPriority, ...]:
        rows = self._select(TABLE_PRIORITIES, {"session_id": f"eq.{session_id}"})
        return tuple(self._row_to_priority(r) for r in rows)

    def fetch_ranked_opportunities(
        self, session_id: str
    ) -> tuple[RankedOpportunity, ...]:
        """Session-scoped, ordered by rank ascending (matches OpportunityRankingService's own output ordering)."""
        rows = self._select(
            TABLE_RANKS,
            {"session_id": f"eq.{session_id}", "order": "rank.asc"},
        )
        return tuple(self._row_to_rank(r) for r in rows)

    def fetch_mission(self, opportunity_id: str) -> Optional[Mission]:
        rows = self._select(TABLE_MISSIONS, {"opportunity_id": f"eq.{opportunity_id}"})
        if not rows:
            return None
        return self._row_to_mission(rows[0])

    def fetch_missions_for_session(self, session_id: str) -> tuple[Mission, ...]:
        rows = self._select(TABLE_MISSIONS, {"session_id": f"eq.{session_id}"})
        return tuple(self._row_to_mission(r) for r in rows)

    def fetch_workflow_state(self, opportunity_id: str) -> Optional[WorkflowState]:
        rows = self._select(
            TABLE_WORKFLOW_STATES, {"opportunity_id": f"eq.{opportunity_id}"}
        )
        if not rows:
            return None
        return self._row_to_workflow_state(rows[0])

    def fetch_workflow_states_for_session(
        self, session_id: str
    ) -> tuple[WorkflowState, ...]:
        rows = self._select(TABLE_WORKFLOW_STATES, {"session_id": f"eq.{session_id}"})
        return tuple(self._row_to_workflow_state(r) for r in rows)

    def fetch_feedback_for_target(
        self, target_type: FeedbackTargetType, target_id: str
    ) -> tuple[FeedbackRecord, ...]:
        """Most-recent-first (created_at desc — see table's own index)."""
        resolved_type = (
            target_type.value
            if isinstance(target_type, FeedbackTargetType)
            else str(target_type)
        )
        rows = self._select(
            TABLE_FEEDBACK,
            {
                "target_type": f"eq.{resolved_type}",
                "target_id": f"eq.{target_id}",
                "order": "created_at.desc",
            },
        )
        return tuple(self._row_to_feedback(r) for r in rows)

    def update_workflow_state(self, state: WorkflowState) -> None:
        """
        Persist an on-demand WorkflowEngineService.transition() result
        back to storage. Upserts on opportunity_id, identical semantics
        to persist_batch_result()'s workflow_states write — this is not
        a new code path, just this same table's declared upsert
        behavior invoked outside the batch-completion call site (e.g.
        after service.py's evaluate_workflow_v2() "transition" action).
        """
        self._upsert_rows(
            TABLE_WORKFLOW_STATES,
            [self._workflow_state_to_row(state, session_id=None)],
            on_conflict="opportunity_id",
        )

    # -- row <-> dataclass mapping (Part 2: canonical mapping) ---------------

    @staticmethod
    def _priority_to_row(priority: OpportunityPriority, session_id: str) -> dict:
        return {
            "opportunity_id": priority.opportunity_id,
            "session_id": session_id,
            "priority_score": priority.priority_score,
            "score_contribution": priority.score_contribution,
            "recency_contribution": priority.recency_contribution,
            "is_eligible": priority.is_eligible,
        }

    @staticmethod
    def _row_to_priority(row: dict) -> OpportunityPriority:
        return OpportunityPriority(
            opportunity_id=row["opportunity_id"],
            priority_score=row["priority_score"],
            score_contribution=row["score_contribution"],
            recency_contribution=row["recency_contribution"],
            is_eligible=row["is_eligible"],
        )

    @staticmethod
    def _rank_to_row(rank: RankedOpportunity, session_id: str) -> dict:
        return {
            "session_id": session_id,
            "opportunity_id": rank.opportunity_id,
            "rank": rank.rank,
            "priority_score": rank.priority_score,
        }

    @staticmethod
    def _row_to_rank(row: dict) -> RankedOpportunity:
        return RankedOpportunity(
            opportunity_id=row["opportunity_id"],
            rank=row["rank"],
            priority_score=row["priority_score"],
        )

    @staticmethod
    def _mission_to_row(mission: Mission, session_id: str) -> dict:
        return {
            "opportunity_id": mission.opportunity_id,
            "business_id": mission.business_id,
            "mission_type": mission.mission_type.value,
            "session_id": session_id,
        }

    @staticmethod
    def _row_to_mission(row: dict) -> Mission:
        return Mission(
            opportunity_id=row["opportunity_id"],
            business_id=row["business_id"],
            mission_type=MissionType(row["mission_type"]),
        )

    @staticmethod
    def _workflow_state_to_row(state: WorkflowState, session_id: Optional[str]) -> dict:
        row = {
            "opportunity_id": state.opportunity_id,
            "mission_id": state.mission_id,
            "business_id": state.business_id,
            "status": state.status.value,
        }
        if session_id is not None:
            row["session_id"] = session_id
        return row

    @staticmethod
    def _row_to_workflow_state(row: dict) -> WorkflowState:
        return WorkflowState(
            mission_id=row["mission_id"],
            opportunity_id=row["opportunity_id"],
            business_id=row["business_id"],
            status=WorkflowStatus(row["status"]),
        )

    @staticmethod
    def _feedback_to_row(record: FeedbackRecord) -> dict:
        return {
            "target_type": record.target_type.value,
            "target_id": record.target_id,
            "outcome": record.outcome.value,
            "notes": record.evidence.notes,
            "metadata": [list(pair) for pair in record.evidence.metadata],
        }

    @staticmethod
    def _row_to_feedback(row: dict) -> FeedbackRecord:
        metadata_raw = row.get("metadata") or []
        metadata = tuple((str(k), str(v)) for k, v in metadata_raw)
        return FeedbackRecord(
            target_type=FeedbackTargetType(row["target_type"]),
            target_id=row["target_id"],
            outcome=FeedbackOutcomeType(row["outcome"]),
            evidence=FeedbackEvidence(notes=row.get("notes"), metadata=metadata),
        )

    # -- internal HTTP ---------------------------------------------------------

    def _insert_rows(self, table: str, rows: Iterable[dict]) -> list[dict]:
        return self._write_rows(table, rows, prefer="return=representation")

    def _upsert_rows(
        self, table: str, rows: Iterable[dict], *, on_conflict: str
    ) -> list[dict]:
        endpoint = f"{self._base_url}/rest/v1/{table}?on_conflict={on_conflict}"
        return self._write_rows(
            table,
            rows,
            prefer="return=representation,resolution=merge-duplicates",
            endpoint=endpoint,
        )

    def _write_rows(
        self,
        table: str,
        rows: Iterable[dict],
        *,
        prefer: str,
        endpoint: Optional[str] = None,
    ) -> list[dict]:
        rows_list = list(rows)
        if not rows_list:
            return []
        endpoint = endpoint or f"{self._base_url}/rest/v1/{table}"
        body = json.dumps(rows_list).encode("utf-8")
        request = urllib.request.Request(
            endpoint,
            data=body,
            method="POST",
            headers={
                "apikey": self._key,
                "Authorization": f"Bearer {self._key}",
                "Content-Type": "application/json",
                "Prefer": prefer,
            },
        )
        with urllib.request.urlopen(
            request, timeout=self._timeout_seconds
        ) as response:
            return json.loads(response.read().decode("utf-8"))

    def _select(self, table: str, query: dict) -> list[dict]:
        query_string = urllib.parse.urlencode(query, safe=".(),*")
        endpoint = f"{self._base_url}/rest/v1/{table}?{query_string}"
        request = urllib.request.Request(
            endpoint,
            method="GET",
            headers={
                "apikey": self._key,
                "Authorization": f"Bearer {self._key}",
            },
        )
        with urllib.request.urlopen(
            request, timeout=self._timeout_seconds
        ) as response:
            return json.loads(response.read().decode("utf-8"))
