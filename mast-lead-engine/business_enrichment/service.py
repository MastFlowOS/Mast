"""
business_enrichment/service.py
===============================

Stateless Business Enrichment Service for the MAST Lead Engine.

Design Rules
------------
- Pure and Stateless — no internal state, storage, persistence, networking, or AI calls.
- Immutability — the input `Business` instance is never mutated. A brand-new `Business` is created.
- Self-contained deltas — accepts `BusinessEnrichmentDelta` candidates carrying their embedded `EnrichmentSource`.
- Field-level provenance — tracks winning source and confidence for every enriched field.
- Conflict auditing — records all discrepancies in immutable `EnrichmentConflict` objects.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timezone
from typing import Any, Sequence

from business.models import Business
from business_enrichment.models import (
    DEFAULT_ENRICHMENT_POLICY,
    BusinessEnrichmentDelta,
    BusinessEnrichmentResult,
    ConflictResolution,
    EnrichedField,
    EnrichmentConflict,
    EnrichmentPolicy,
    EnrichmentPolicyStrategy,
)


class BusinessEnrichmentService:
    """
    Stateless domain service that enriches a canonical Business using self-contained
    BusinessEnrichmentDelta candidate payloads according to an EnrichmentPolicy.
    """

    @staticmethod
    def enrich(
        business: Business,
        deltas: Sequence[BusinessEnrichmentDelta],
        policy: EnrichmentPolicy = DEFAULT_ENRICHMENT_POLICY,
        enrichment_id: str | None = None,
    ) -> BusinessEnrichmentResult:
        """
        Enrich a canonical Business using candidate deltas.

        Parameters
        ----------
        business
            The canonical Business instance to enrich.
        deltas
            Sequence of self-contained BusinessEnrichmentDelta objects.
        policy
            EnrichmentPolicy configuration governing scalar, collection, and coordinate strategies.
        enrichment_id
            Optional explicit transaction ID. Auto-generated if omitted.

        Returns
        -------
        BusinessEnrichmentResult
            Immutable container holding the enriched Business, provenance records, and conflict audit logs.
        """
        if not isinstance(business, Business):
            raise TypeError(f"business must be a Business instance; got {type(business)!r}")

        if not isinstance(policy, EnrichmentPolicy):
            raise TypeError(f"policy must be an EnrichmentPolicy instance; got {type(policy)!r}")

        delta_tuple: tuple[BusinessEnrichmentDelta, ...] = (
            tuple(deltas) if not isinstance(deltas, tuple) else deltas
        )

        for delta in delta_tuple:
            if not isinstance(delta, BusinessEnrichmentDelta):
                raise TypeError(f"item in deltas must be a BusinessEnrichmentDelta; got {type(delta)!r}")

        now = datetime.now(timezone.utc)

        if enrichment_id is None:
            ts_str = now.strftime("%Y%m%d%H%M%S%f")
            enrichment_id = f"enrich_{business.business_id}_{ts_str}"
        elif not isinstance(enrichment_id, str) or not enrichment_id.strip():
            raise ValueError("enrichment_id must be a non-empty string if provided")

        field_provenances: list[EnrichedField] = []
        conflicts: list[EnrichmentConflict] = []

        # Filter candidate deltas by min_confidence_threshold
        valid_deltas = [
            d for d in delta_tuple if d.confidence >= policy.min_confidence_threshold
        ]

        # -----------------------------------------------------------------------
        # 1. Scalar Fields Evaluation
        # -----------------------------------------------------------------------
        scalar_fields = [
            "name",
            "category",
            "address",
            "city",
            "region",
            "country",
            "postal_code",
            "description",
            "instagram_url",
            "facebook_url",
            "linkedin_url",
        ]

        updates: dict[str, Any] = {}

        for field in scalar_fields:
            current_val: str | None = getattr(business, field)
            winning_val: str | None = current_val
            winning_source_id: str = business.originating_provider_id
            winning_provider_id: str | None = business.originating_provider_id
            winning_confidence: float = 1.0

            for delta in valid_deltas:
                cand_val = getattr(delta, field)
                if cand_val is None:
                    continue

                if winning_val is None:
                    # Enrich empty field
                    winning_val = cand_val
                    winning_source_id = delta.source.source_id
                    winning_provider_id = delta.source.provider_id
                    winning_confidence = delta.confidence
                elif cand_val != winning_val:
                    # Conflict detected
                    if policy.scalar_strategy == EnrichmentPolicyStrategy.PRESERVE_EXISTING:
                        conflicts.append(
                            EnrichmentConflict(
                                field_name=field,
                                existing_value=winning_val,
                                proposed_value=cand_val,
                                source_id=delta.source.source_id,
                                resolution=ConflictResolution.PRESERVED,
                                reason="Preserved existing non-null value per PRESERVE_EXISTING strategy",
                            )
                        )
                    elif policy.scalar_strategy == EnrichmentPolicyStrategy.OVERWRITE_IF_HIGHER_CONFIDENCE:
                        if delta.confidence > winning_confidence:
                            conflicts.append(
                                EnrichmentConflict(
                                    field_name=field,
                                    existing_value=winning_val,
                                    proposed_value=cand_val,
                                    source_id=delta.source.source_id,
                                    resolution=ConflictResolution.OVERWRITTEN,
                                    reason=f"Overwrote value due to higher confidence ({delta.confidence} > {winning_confidence})",
                                )
                            )
                            winning_val = cand_val
                            winning_source_id = delta.source.source_id
                            winning_provider_id = delta.source.provider_id
                            winning_confidence = delta.confidence
                        else:
                            conflicts.append(
                                EnrichmentConflict(
                                    field_name=field,
                                    existing_value=winning_val,
                                    proposed_value=cand_val,
                                    source_id=delta.source.source_id,
                                    resolution=ConflictResolution.PRESERVED,
                                    reason=f"Preserved existing value due to lower/equal candidate confidence ({delta.confidence} <= {winning_confidence})",
                                )
                            )

            if winning_val is not None:
                updates[field] = winning_val
                field_provenances.append(
                    EnrichedField(
                        field_name=field,
                        value=winning_val,
                        source_id=winning_source_id,
                        provider_id=winning_provider_id,
                        confidence=winning_confidence,
                        evaluated_at=now,
                    )
                )

        # -----------------------------------------------------------------------
        # 2. Coordinate Fields Evaluation (latitude, longitude)
        # -----------------------------------------------------------------------
        coord_fields = ["latitude", "longitude"]
        for field in coord_fields:
            current_coord: float | None = getattr(business, field)
            winning_coord: float | None = current_coord
            winning_source_id = business.originating_provider_id
            winning_provider_id = business.originating_provider_id
            winning_confidence = 1.0

            for delta in valid_deltas:
                cand_coord = getattr(delta, field)
                if cand_coord is None:
                    continue

                if winning_coord is None:
                    winning_coord = cand_coord
                    winning_source_id = delta.source.source_id
                    winning_provider_id = delta.source.provider_id
                    winning_confidence = delta.confidence
                elif cand_coord != winning_coord:
                    if policy.coordinate_strategy == EnrichmentPolicyStrategy.PRESERVE_EXISTING:
                        conflicts.append(
                            EnrichmentConflict(
                                field_name=field,
                                existing_value=winning_coord,
                                proposed_value=cand_coord,
                                source_id=delta.source.source_id,
                                resolution=ConflictResolution.PRESERVED,
                                reason="Preserved existing coordinate per PRESERVE_EXISTING strategy",
                            )
                        )
                    elif policy.coordinate_strategy == EnrichmentPolicyStrategy.OVERWRITE_IF_HIGHER_CONFIDENCE:
                        if delta.confidence > winning_confidence:
                            conflicts.append(
                                EnrichmentConflict(
                                    field_name=field,
                                    existing_value=winning_coord,
                                    proposed_value=cand_coord,
                                    source_id=delta.source.source_id,
                                    resolution=ConflictResolution.OVERWRITTEN,
                                    reason=f"Overwrote coordinate due to higher confidence ({delta.confidence} > {winning_confidence})",
                                )
                            )
                            winning_coord = cand_coord
                            winning_source_id = delta.source.source_id
                            winning_provider_id = delta.source.provider_id
                            winning_confidence = delta.confidence
                        else:
                            conflicts.append(
                                EnrichmentConflict(
                                    field_name=field,
                                    existing_value=winning_coord,
                                    proposed_value=cand_coord,
                                    source_id=delta.source.source_id,
                                    resolution=ConflictResolution.PRESERVED,
                                    reason=f"Preserved existing coordinate due to lower/equal candidate confidence ({delta.confidence} <= {winning_confidence})",
                                )
                            )

            if winning_coord is not None:
                updates[field] = winning_coord
                field_provenances.append(
                    EnrichedField(
                        field_name=field,
                        value=winning_coord,
                        source_id=winning_source_id,
                        provider_id=winning_provider_id,
                        confidence=winning_confidence,
                        evaluated_at=now,
                    )
                )

        # -----------------------------------------------------------------------
        # 3. Collection Fields Evaluation (phones, emails, websites)
        # -----------------------------------------------------------------------
        collection_fields = ["phones", "emails", "websites"]
        for field in collection_fields:
            current_col: tuple[str, ...] = getattr(business, field)
            winning_list: list[str] = list(current_col)

            # Record initial provenance for existing items
            if current_col:
                field_provenances.append(
                    EnrichedField(
                        field_name=field,
                        value=current_col,
                        source_id=business.originating_provider_id,
                        provider_id=business.originating_provider_id,
                        confidence=1.0,
                        evaluated_at=now,
                    )
                )

            for delta in valid_deltas:
                cand_col: tuple[str, ...] = getattr(delta, field)
                if not cand_col:
                    continue

                if policy.collection_strategy == EnrichmentPolicyStrategy.UNION_COLLECTIONS:
                    added_items: list[str] = []
                    for item in cand_col:
                        if item not in winning_list:
                            winning_list.append(item)
                            added_items.append(item)

                    if added_items:
                        conflicts.append(
                            EnrichmentConflict(
                                field_name=field,
                                existing_value=tuple(current_col),
                                proposed_value=cand_col,
                                source_id=delta.source.source_id,
                                resolution=ConflictResolution.MERGED,
                                reason=f"Merged new candidate items {added_items!r} into collection",
                            )
                        )
                        field_provenances.append(
                            EnrichedField(
                                field_name=field,
                                value=tuple(added_items),
                                source_id=delta.source.source_id,
                                provider_id=delta.source.provider_id,
                                confidence=delta.confidence,
                                evaluated_at=now,
                            )
                        )

            updates[field] = tuple(winning_list)

        # -----------------------------------------------------------------------
        # 4. Construct New Immutable Business Entity
        # -----------------------------------------------------------------------
        enriched_business = dataclasses.replace(business, **updates)

        return BusinessEnrichmentResult(
            enriched_business=enriched_business,
            enrichment_id=enrichment_id,
            field_provenances=tuple(field_provenances),
            conflicts=tuple(conflicts),
            enriched_at=now,
        )
