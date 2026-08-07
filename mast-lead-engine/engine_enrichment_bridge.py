"""
Engine 2.0 Enrichment Bridge — Runtime Compatibility Layer
=============================================================

Why this file exists
---------------------
Production's per-business enrichment (Node: businessProcessingJob.ts,
functions enrichBusiness()/scoreBusiness(), triggered by pg-boss jobs
"business.enrich" / "business.score") currently runs through
verify_business() in service.py, which explicitly reuses the V1
SiteCrawler / IGIntelligence Playwright-based extractors ("exactly as
EnrichmentPipeline does internally" — see that function's own
docstring). Engine 2.0's WebsiteWorker / InstagramWorker / ContactWorker
/ MergeWorker are the canonical replacements for that extraction logic
(per the Milestone 2 integration decision: preserve the existing
pg-boss job architecture, replace only the business logic those jobs
execute).

This module is that replacement's composition point: it wires the
Engine 2.0 workers together for ONE already-known business (no
discovery, no queue, no session — those don't apply here, matching
verify_business()'s own scope) and hands back a flat dict shaped to
match the columns businessProcessingJob.ts already writes into the
`businesses` table, per the Milestone 2 storage decision ("adapt
Engine 2.0 persistence to current production database rather than
introducing parallel storage model" — there is no new table here,
just a translation of already-existing Engine 2.0 contract objects
into the field names the current `businesses` UPDATE already uses).

Explicitly NOT in scope for this bridge
-----------------------------------------
QualificationWorker and ScoringWorker are not wired in here.
engine/contracts.py's QualificationResult/OpportunityScore are a
single profession-agnostic result per business; production's actual
scoring model (business_opportunity_scores, one row per
business x profession, see migrations/003_pool_lookup.sql and
src/scoring/storeOpportunityScores.ts's own docstring on the Global
Lead Pool design) has no equivalent in either engine/contracts.py or
the standalone opportunity_scoring/ package. Wiring qualification/
scoring in before that mismatch is resolved would either invent a
profession dimension Engine 2.0 doesn't have, or silently change the
per-profession scoring formula the product already charges against.
That decision is tracked separately, not made implicitly by this file.

Known, flagged capability gaps versus the V1 SiteCrawler this replaces
--------------------------------------------------------------------------
WebsiteWorker/ContactWorker are deliberately lightweight urllib
inspectors (single HTTP fetch, no rendering — see their own module
docstrings for why that is the intended architecture), not the
Playwright-driven crawler V1 used. The following `businesses` columns
have NO Engine 2.0 source yet. This bridge leaves them out of its
result entirely (not zeroed, not guessed at) so the caller's existing
"only update a column when a new value exists" pattern
(`field: value || undefined`) leaves whatever was last stored
untouched, exactly as it already does for any field verify_business()
itself didn't return:
  - seo (has_title / has_meta_description structured probe)
  - blog (has_blog / last_post_days)
  - signals.tech_stack (WebsiteIntel.detected_platform is a single
    signature match, narrower than V1's tech-stack fingerprinting)
  - a business's own instagram/facebook link discovered ON its
    website — no contract field exists for this; ContactIntel only
    carries a linkedin_url among social links, and InstagramIntel
    describes a profile you already know the URL of, not one
    discovered from a page
  - Instagram Reels/engagement-style figures V1 may have approximated
    (InstagramIntel deliberately excludes any derived/estimated
    metric — see InstagramIntel's own Phase 5.5 docstring)
This mirrors this repository's own established convention for
declaring such gaps (see storage_backends/supabase_backend.py, "A
flagged gap this backend does not work around") rather than silently
degrading or fabricating data.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional

from engine.contracts import BusinessCandidate
from workers.contact_worker import ContactWorker
from workers.instagram_worker import InstagramWorker
from workers.merge_worker import MergeInput, MergeWorker
from workers.scoring_worker import ScoringWorker
from workers.website_worker import WebsiteWorker


def _candidate_from_payload(payload: dict) -> BusinessCandidate:
    coords = None
    if payload.get("latitude") is not None and payload.get("longitude") is not None:
        try:
            coords = (float(payload["latitude"]), float(payload["longitude"]))
        except (ValueError, TypeError):
            coords = None

    return BusinessCandidate(
        pipeline_id=str(payload.get("pipeline_id") or uuid.uuid4()),
        session_id=str(payload.get("session_id") or uuid.uuid4()),
        provider="business_processing_bridge",
        name=payload.get("name") or "",
        category=payload.get("category"),
        address=payload.get("address"),
        city=payload.get("city"),
        country=payload.get("country"),
        phone=payload.get("phone"),
        website=payload.get("website"),
        rating=payload.get("rating"),
        review_count=payload.get("review_count") or payload.get("reviews"),
        coordinates=coords,
        maps_url=payload.get("maps_url") or payload.get("maps_link"),
        instagram_url=payload.get("instagram") or payload.get("instagram_url"),
    )



def enrich_business_with_engine_v2(payload: dict) -> dict[str, Any]:
    """
    Runs WebsiteWorker, ContactWorker, InstagramWorker, MergeWorker,
    and ScoringWorker sequentially for one business payload and returns
    a flat dict shaped for `businesses` table UPDATE and
    `business_opportunity_scores` upserts.
    """
    candidate = _candidate_from_payload(payload)


    website_intel = None
    contact_intel = None
    if candidate.website:
        website_intel = WebsiteWorker().process(candidate)
        contact_intel = ContactWorker().process(website_intel)

    instagram_intel = None
    if candidate.instagram_url:
        instagram_intel = InstagramWorker().process(candidate)

    enriched = MergeWorker().process(
        MergeInput(
            business=candidate,
            website_intel=website_intel,
            instagram_intel=instagram_intel,
            contact_intel=contact_intel,
        )
    )

    score_obj = ScoringWorker().process(enriched)

    return _enriched_to_dict(enriched, score_obj)


enrich_business = enrich_business_with_engine_v2


def _enriched_to_dict(enriched, score_obj=None) -> dict[str, Any]:
    w = enriched.website_intel
    c = enriched.contact_intel
    i = enriched.instagram_intel

    result: dict[str, Any] = {
        "website_reachable": w.website_reachable if w else None,
        "ssl_valid": (w.https if w else None),
        "load_time_ms": (
            round(w.response_time * 1000)
            if w and w.response_time is not None
            else None
        ),
        "final_url": (w.final_url if w else None),
        "http_status": (w.http_status if w else None),
        "title": (w.title if w else None),
        "meta_description": (w.description if w else None),
        "detected_platform": (w.detected_platform if w else None),
        "contact_page": (w.contact_page if w else None),
        "email": (c.emails[0] if c and c.emails else None),
        "emails": (list(c.emails) if c and c.emails else []),
        "phone": (c.phones[0] if c and c.phones else None),
        "phones": (list(c.phones) if c and c.phones else []),
        "contact_form_url": (c.contact_form_url if c else None),
        "whatsapp_link": (c.whatsapp_link if c else None),
        "messenger_link": (c.messenger_link if c else None),
        "telegram_link": (c.telegram_link if c else None),
        "linkedin": (c.linkedin_url if c else None),
        "instagram_reachable": (i.profile_reachable if i else None),
        "instagram_username": (i.username if i else None),
        "instagram_followers": (i.followers if i else None),
        "instagram_following": (i.following if i else None),
        "instagram_posts": (i.posts if i else None),
        "instagram_verified": (i.verified if i else None),
        "instagram_account_type": (i.account_type if i else None),
        "instagram_bio": (i.bio if i else None),
        "instagram_external_website": (i.external_website if i else None),
        "instagram_last_post_date": (i.last_post_date if i else None),
    }

    if score_obj is not None:
        result["opportunity_score"] = score_obj.opportunity_score
        result["score_tier"] = score_obj.tier
        result["score_breakdown"] = score_obj.score_breakdown
        result["profession_scores"] = [
            {
                "profession_slug": s.profession_slug,
                "opportunity_score": s.score,
                "score_breakdown": s.breakdown.to_dict(),
                "summary": s.summary,
                "reasons": list(s.reasons),
            }
            for s in score_obj.profession_scores
        ]

    return result
