"""
engine/adapters.py
===================

Adapter layer between the seven-stage runtime's production contracts
(engine.contracts.*) and the Engine 2.0 domain-layer contracts consumed by
the previously-dormant batch intelligence chain (opportunities,
opportunity_qualification, opportunity_scoring, opportunity_prioritization,
opportunity_ranking, mission_generation, workflow).

Why this exists
----------------
QualifiedOpportunity (produced by build_seven_stage_pipeline() in
execution_driver.py) and the domain Opportunity / OpportunityQualification /
OpportunityScore models are structurally different types that happen to
share overlapping concepts (a "niche" is a niche either way; a qualified
opportunity is qualified either way). Nothing here invents new business
facts:
  - Every field below is either a direct rename/reshape of a value the
    production pipeline already computed, or
  - (opportunity_type_id specifically) explicitly left unresolved — this
    function returns None rather than fabricate a value the production
    runtime does not own. See to_domain_opportunity()'s own docstring.

Design Rules
------------
- Pure translation only. No scoring, qualification, ranking, or mission
  decisions are made here — those remain the exclusive responsibility of
  the Engine 2.0 domain services (opportunity_prioritization,
  opportunity_ranking, mission_generation, workflow).
- Never invents a value for a field production does not own. Where no
  canonical source exists, the adapter returns None (skipping downstream
  intelligence-chain evaluation for that item) rather than fabricate one.
- Stateless, side-effect-free functions only — mirrors the domain
  services' own "pure derived evaluation output" design rule.
"""

from __future__ import annotations

import datetime as _dt
import logging
from typing import Optional

from engine.contracts import QualifiedOpportunity
from opportunities.models import Opportunity
from opportunity_qualification.models import OpportunityQualification, QualificationStatus
from opportunity_scoring.models import OpportunityScore as DomainOpportunityScore

log = logging.getLogger("engine.adapters")


def _parse_discovered_at(raw: Optional[str]) -> _dt.datetime:
    """
    BusinessCandidate.discovered_at is an Optional[str] (ISO-ish); the
    domain Opportunity.discovered_at requires an actual datetime. Falls
    back to "now" only when the production value is missing/unparseable —
    the same fallback qualify_business_v2 / prioritize_opportunity_v2
    already use in service.py for the identical field.
    """
    if isinstance(raw, str) and raw:
        try:
            return _dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            pass
    return _dt.datetime.now(_dt.timezone.utc)


def to_domain_opportunity(qualified: QualifiedOpportunity) -> Optional[Opportunity]:
    """
    Translate a production QualifiedOpportunity into a domain Opportunity.

    Field mapping (every value traces to an existing canonical source):
      - opportunity_id / business_id <- pipeline_id. Per AD-021, cited in
        StoredOpportunity's own docstring in engine/contracts.py: "the
        Pipeline ID is the identity of the Business throughout the
        engine" — there is no second, storage-generated business id
        anywhere upstream to use instead.
      - niche_id <- qualification.niche (already the same concept, just
        production-layer naming); falls back to the literal "unknown"
        only when QualificationWorker was configured with no niche
        restriction (niche=None is an explicitly documented, legitimate
        state per QualificationWorker's own docstring) — identical
        fallback already used for this exact field in
        service.py's _opportunity_from_payload().
      - discovered_at <- business.business.discovered_at
        (BusinessCandidate), parsed to a datetime.
      - supporting_signal_ids <- qualification.needed_services +
        qualification.reasons, de-duplicated. Both are already-real
        signals QualificationWorker computed about why this opportunity
        qualified / what it needs — nothing here is inferred or guessed.

    opportunity_type_id has NO canonical source at the production layer:
    no field anywhere in engine.contracts corresponds to the opportunity-
    type taxonomy Opportunity's own docstring describes (e.g.
    'missing_website', 'poor_seo'). Rather than fabricate one, this
    function echoes the first available needed_service/reason string into
    that field, purely so the dataclass's required, non-empty field can
    be constructed at all. mission_generation._derive_mission_type has
    been reordered (see that function's own docstring) to treat
    supporting_signal_ids as canonical and opportunity_type_id as a
    best-effort fallback only — so real derived behavior comes from the
    genuine signals, not from this echoed placeholder. If there is
    truly no needed_service or reason to echo, this function returns
    None rather than invent a value, and the caller must skip
    prioritization/ranking/mission-generation for that opportunity.
    """
    if qualified.qualification is None or qualified.business is None:
        log.warning(
            "adapters.to_domain_opportunity: pipeline_id=%s missing qualification "
            "or business; cannot build a domain Opportunity",
            qualified.pipeline_id,
        )
        return None

    qual = qualified.qualification
    combined_signals = tuple(qual.needed_services) + tuple(qual.reasons)
    seen: set[str] = set()
    deduped_signals = tuple(s for s in combined_signals if not (s in seen or seen.add(s)))

    if not deduped_signals:
        log.info(
            "adapters.to_domain_opportunity: pipeline_id=%s has no needed_services "
            "or reasons to source opportunity_type_id from; skipping rather than "
            "substituting a fabricated value",
            qualified.pipeline_id,
        )
        return None

    business_candidate = qualified.business.business
    discovered_at = _parse_discovered_at(
        business_candidate.discovered_at if business_candidate is not None else None
    )

    try:
        return Opportunity(
            opportunity_id=qualified.pipeline_id,
            business_id=qualified.pipeline_id,
            niche_id=qual.niche or "unknown",
            opportunity_type_id=deduped_signals[0],
            discovered_at=discovered_at,
            supporting_signal_ids=deduped_signals,
        )
    except (ValueError, TypeError) as exc:
        log.warning(
            "adapters.to_domain_opportunity: pipeline_id=%s could not be adapted: %s",
            qualified.pipeline_id, exc,
        )
        return None


def to_domain_qualification(qualified: QualifiedOpportunity) -> Optional[OpportunityQualification]:
    """
    Translate production QualificationResult (folded into
    QualifiedOpportunity) into a domain OpportunityQualification.

    status <- qualification.qualified. Same binary concept; a plain bool
    at the production layer, an enum in the domain layer.

    passed_rule_ids is left empty (`()`, which the dataclass explicitly
    permits): production's QualificationWorker evaluates a different rule
    set (EnrichedBusiness fact checks: missing website, unreachable site,
    etc.) than the domain opportunity_qualification module's own RULE_*
    identifiers (produced by OpportunityQualificationService.evaluate()
    — see e.g. RULE_SUPPORTING_SIGNALS_PRESENT). These are two legitimate,
    non-interchangeable rule vocabularies; inventing RULE_* ids production
    never computed would be fabricating data this adapter is not
    authorized to invent. This has no behavioral effect —
    OpportunityPrioritizationService.evaluate_priority only inspects
    `qualification.status`, never passed_rule_ids/failed_rule_ids (see
    opportunity_prioritization/service.py). failed_rule_ids carries
    production's own real `reasons` tuple when not qualified, purely for
    auditability.
    """
    if qualified.qualification is None:
        return None
    qual = qualified.qualification
    status = QualificationStatus.QUALIFIED if qual.qualified else QualificationStatus.NOT_QUALIFIED
    try:
        return OpportunityQualification(
            opportunity_id=qualified.pipeline_id,
            status=status,
            passed_rule_ids=(),
            failed_rule_ids=tuple(qual.reasons) if not qual.qualified else (),
        )
    except (ValueError, TypeError) as exc:
        log.warning(
            "adapters.to_domain_qualification: pipeline_id=%s could not be adapted: %s",
            qualified.pipeline_id, exc,
        )
        return None


def to_domain_score(qualified: QualifiedOpportunity) -> Optional[DomainOpportunityScore]:
    """
    Translate production OpportunityScore (folded into QualifiedOpportunity)
    into the domain opportunity_scoring OpportunityScore.

    overall_score <- score.opportunity_score. Same concept renamed:
    ScoringWorker's own docstring explicitly distinguishes opportunity_score
    from business_health_score ("a terrible website may LOWER business
    health but INCREASE opportunity") — overall_score is the domain
    layer's name for the former, never the latter.

    contributions is left empty (`()`, the dataclass default): production's
    OpportunityScore.score_breakdown is a dict[str, float], not the domain
    ScoreContribution shape (contribution_id + delta + reason); reshaping
    it would require inventing `reason` text production never generated,
    so it is omitted rather than fabricated. This has no behavioral
    effect — OpportunityPrioritizationService only reads
    `score.overall_score`.
    """
    if qualified.score is None or qualified.score.opportunity_score is None:
        return None
    try:
        return DomainOpportunityScore(
            opportunity_id=qualified.pipeline_id,
            overall_score=float(qualified.score.opportunity_score),
        )
    except (ValueError, TypeError) as exc:
        log.warning(
            "adapters.to_domain_score: pipeline_id=%s could not be adapted: %s",
            qualified.pipeline_id, exc,
        )
        return None
