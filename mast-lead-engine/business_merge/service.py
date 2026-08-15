"""
business_merge/service.py
=========================

Stateless consolidation service for the business_merge/ package.

Design Rules
------------
- Pure stateless execution engine — zero instance state.
- Given a BusinessIdentity and referenced canonical Business objects, produces a single immutable BusinessMergeResult.
- Does not determine identity, score confidence, call AI, enrich, or persist.
- Keeps Business.originating_provider_id clean (single scalar string, never concatenated).
- Pure coordinate selection: picks existing WGS84 coordinates without centroid math.
- Structured provenance: returns tuple[FieldOrigin, ...].
- Audits scalar conflicts into tuple[MergeConflict, ...].
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Mapping, Sequence

from business import Business
from business_identity import BusinessIdentity
from utils.parsing import is_valid_email

from .models import (
    DEFAULT_MERGE_POLICY,
    BusinessMergeResult,
    BusinessProvenance,
    FieldMergeStrategy,
    FieldOrigin,
    MergeConflict,
    MergePolicy,
)


class BusinessMergeService:
    """
    Stateless consolidation engine that merges canonical Business objects linked by a BusinessIdentity.
    """

    def merge(
        self,
        identity: BusinessIdentity,
        businesses: Sequence[Business] | Mapping[str, Business],
        policy: MergePolicy = DEFAULT_MERGE_POLICY,
        custom_merged_id: str | None = None,
    ) -> BusinessMergeResult:
        """
        Consolidate source Business instances linked by identity into a single BusinessMergeResult.

        Parameters
        ----------
        identity
            The BusinessIdentity group defining equivalence.
        businesses
            Sequence or Mapping of canonical Business objects containing all referenced business_ids.
        policy
            MergePolicy configuring field consolidation strategies.
        custom_merged_id
            Optional custom business_id for the merged entity. Defaults to 'merged_{identity_id}'.

        Returns
        -------
        BusinessMergeResult
            Immutable container wrapping merged Business, BusinessProvenance, and MergeConflicts.
        """
        if not isinstance(identity, BusinessIdentity):
            raise TypeError(f"identity must be a BusinessIdentity instance; got {type(identity)!r}")

        if not isinstance(policy, MergePolicy):
            raise TypeError(f"policy must be a MergePolicy instance; got {type(policy)!r}")

        # Index source businesses by business_id
        if isinstance(businesses, Mapping):
            biz_map = dict(businesses)
        elif isinstance(businesses, Sequence) and not isinstance(businesses, (str, bytes)):
            biz_map = {}
            for b in businesses:
                if not isinstance(b, Business):
                    raise TypeError(f"Item in businesses sequence must be a Business instance; got {type(b)!r}")
                biz_map[b.business_id] = b
        else:
            raise TypeError(f"businesses must be a Sequence or Mapping of Business objects; got {type(businesses)!r}")

        # Verify all business_ids referenced in identity are provided
        missing_ids = [b_id for b_id in identity.business_ids if b_id not in biz_map]
        if missing_ids:
            raise ValueError(f"Missing referenced Business instances for IDs: {missing_ids!r}")

        # Ordered source business list matching identity.business_ids
        sources: list[Business] = [biz_map[b_id] for b_id in identity.business_ids]

        # Determine merged business_id
        merged_id = custom_merged_id or f"merged_{identity.identity_id}"

        # Collect overall provenance sets (preserving order of appearance)
        source_b_ids = tuple(b.business_id for b in sources)

        exec_ids_list: list[str] = []
        prov_ids_list: list[str] = []
        sess_ids_list: list[str] = []

        for b in sources:
            if b.execution_id not in exec_ids_list:
                exec_ids_list.append(b.execution_id)
            if b.originating_provider_id not in prov_ids_list:
                prov_ids_list.append(b.originating_provider_id)
            if b.session_id not in sess_ids_list:
                sess_ids_list.append(b.session_id)

        # Primary source selection (for primary provider scalar attributes)
        primary_source: Business = sources[0]
        if policy.primary_provider_id:
            for b in sources:
                if b.originating_provider_id == policy.primary_provider_id:
                    primary_source = b
                    break

        # Discovered_at timestamp: earliest timestamp across all sources
        earliest_discovered_at = min(b.discovered_at for b in sources)

        # Container for field origins and scalar conflicts
        field_origins: list[FieldOrigin] = []
        conflicts: list[MergeConflict] = []

        # -----------------------------------------------------------------------
        # Helper for Scalar Text Field Consolidation
        # -----------------------------------------------------------------------
        def _resolve_scalar(field_name: str) -> tuple[str | None, tuple[str, ...]]:
            values_with_sources: list[tuple[Business, str]] = []
            for b in sources:
                v = getattr(b, field_name)
                if v is not None and isinstance(v, str) and v.strip():
                    values_with_sources.append((b, v.strip()))

            if not values_with_sources:
                field_origins.append(
                    FieldOrigin(
                        field_name=field_name,
                        source_business_ids=(),
                        winning_value=None,
                        merge_reason="No non-empty value present across source records.",
                    )
                )
                return None, ()

            # Determine winning value based on policy
            winning_biz: Business
            winning_val: str
            reason: str

            if policy.scalar_strategy == FieldMergeStrategy.PRIMARY_SOURCE:
                primary_val = getattr(primary_source, field_name)
                if primary_val is not None and isinstance(primary_val, str) and primary_val.strip():
                    winning_biz = primary_source
                    winning_val = primary_val.strip()
                    reason = f"Selected from preferred primary provider '{primary_source.originating_provider_id}'."
                else:
                    # Fallback to longest non-empty
                    winning_biz, winning_val = max(values_with_sources, key=lambda x: len(x[1]))
                    reason = "Primary source value missing; fell back to longest non-empty string."
            elif policy.scalar_strategy == FieldMergeStrategy.FIRST_NON_NULL:
                winning_biz, winning_val = values_with_sources[0]
                reason = "Selected first non-null string in source order."
            else:  # Default: LONGEST_NON_EMPTY
                winning_biz, winning_val = max(values_with_sources, key=lambda x: len(x[1]))
                reason = "Selected longest non-empty string."

            # Collect contributing source IDs for this winning value
            contributing_sources = tuple(b.business_id for b, v in values_with_sources if v == winning_val)
            field_origins.append(
                FieldOrigin(
                    field_name=field_name,
                    source_business_ids=contributing_sources,
                    winning_value=winning_val,
                    merge_reason=reason,
                )
            )

            # Check for conflicting scalar values
            unique_values: dict[str, str] = {}  # val -> first_source_id
            for b, v in values_with_sources:
                if v not in unique_values:
                    unique_values[v] = b.business_id

            if len(unique_values) > 1:
                competing_pairs = tuple(
                    (b_id, val) for val, b_id in unique_values.items() if val != winning_val
                )
                conflicts.append(
                    MergeConflict(
                        field_name=field_name,
                        winning_value=winning_val,
                        winning_source_id=winning_biz.business_id,
                        competing_values=competing_pairs,
                    )
                )

            return winning_val, contributing_sources

        # Resolve scalar text fields
        name_val, _ = _resolve_scalar("name")
        # Ensure name is never None (fallback to primary source name if empty)
        final_name = name_val or primary_source.name

        category_val, _ = _resolve_scalar("category")
        address_val, _ = _resolve_scalar("address")
        city_val, _ = _resolve_scalar("city")
        region_val, _ = _resolve_scalar("region")
        country_val, _ = _resolve_scalar("country")
        postal_code_val, _ = _resolve_scalar("postal_code")
        description_val, _ = _resolve_scalar("description")
        insta_val, _ = _resolve_scalar("instagram_url")
        fb_val, _ = _resolve_scalar("facebook_url")
        li_val, _ = _resolve_scalar("linkedin_url")
        prov_biz_id_val, _ = _resolve_scalar("originating_provider_business_id")

        # -----------------------------------------------------------------------
        # Geographic Coordinates (Pure Selection — NO Centroid Math)
        # -----------------------------------------------------------------------
        final_lat: float | None = None
        final_lng: float | None = None
        coord_source_id: str | None = None

        coord_candidates: list[tuple[Business, float, float]] = []
        for b in sources:
            if b.latitude is not None and b.longitude is not None:
                coord_candidates.append((b, float(b.latitude), float(b.longitude)))

        if coord_candidates:
            selected_coord_biz: Business
            selected_coord_biz, final_lat, final_lng = coord_candidates[0]
            if policy.coordinate_strategy == FieldMergeStrategy.PRIMARY_SOURCE:
                for b, lat, lng in coord_candidates:
                    if b.originating_provider_id == policy.primary_provider_id:
                        selected_coord_biz = b
                        final_lat = lat
                        final_lng = lng
                        break
            coord_source_id = selected_coord_biz.business_id

        field_origins.append(
            FieldOrigin(
                field_name="latitude",
                source_business_ids=(coord_source_id,) if coord_source_id else (),
                winning_value=final_lat,
                merge_reason="Pure coordinate selection from existing source record." if coord_source_id else "No coordinates present.",
            )
        )
        field_origins.append(
            FieldOrigin(
                field_name="longitude",
                source_business_ids=(coord_source_id,) if coord_source_id else (),
                winning_value=final_lng,
                merge_reason="Pure coordinate selection from existing source record." if coord_source_id else "No coordinates present.",
            )
        )

        # -----------------------------------------------------------------------
        # Collection Fields (Phones, Emails, Websites) - Set Union Ordered
        # -----------------------------------------------------------------------
        def _resolve_collection(field_name: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
            combined: list[str] = []
            contributing_sources: list[str] = []

            for b in sources:
                col_val: tuple[str, ...] = getattr(b, field_name)
                has_contributed = False
                for item in col_val:
                    if item and isinstance(item, str) and item.strip():
                        norm_item = item.strip()
                        if field_name == "emails" and not is_valid_email(norm_item):
                            continue
                        if norm_item not in combined:
                            combined.append(norm_item)
                            has_contributed = True
                if has_contributed and b.business_id not in contributing_sources:
                    contributing_sources.append(b.business_id)

            res_tuple = tuple(combined)
            sources_tuple = tuple(contributing_sources)

            field_origins.append(
                FieldOrigin(
                    field_name=field_name,
                    source_business_ids=sources_tuple,
                    winning_value=res_tuple,
                    merge_reason="Union of unique values across all source records in order of appearance.",
                )
            )
            return res_tuple, sources_tuple

        phones_tuple, _ = _resolve_collection("phones")
        emails_tuple, _ = _resolve_collection("emails")
        websites_tuple, _ = _resolve_collection("websites")

        # -----------------------------------------------------------------------
        # Pure Originating Provider ID Preservation on Merged Business
        # -----------------------------------------------------------------------
        # Business.originating_provider_id remains a single clean scalar string!
        merged_provider_id = primary_source.originating_provider_id

        # Construct single merged Business instance
        merged_business = Business(
            business_id=merged_id,
            execution_id=primary_source.execution_id,
            session_id=primary_source.session_id,
            originating_provider_id=merged_provider_id,
            name=final_name,
            discovered_at=earliest_discovered_at,
            originating_provider_business_id=prov_biz_id_val,
            category=category_val,
            address=address_val,
            city=city_val,
            region=region_val,
            country=country_val,
            postal_code=postal_code_val,
            latitude=final_lat,
            longitude=final_lng,
            description=description_val,
            instagram_url=insta_val,
            facebook_url=fb_val,
            linkedin_url=li_val,
            phones=phones_tuple,
            emails=emails_tuple,
            websites=websites_tuple,
        )

        # Construct BusinessProvenance
        provenance = BusinessProvenance(
            identity_id=identity.identity_id,
            merged_business_id=merged_id,
            source_business_ids=source_b_ids,
            source_execution_ids=tuple(exec_ids_list),
            source_provider_ids=tuple(prov_ids_list),
            source_session_ids=tuple(sess_ids_list),
            field_origins=tuple(field_origins),
        )

        # Construct final result
        return BusinessMergeResult(
            business=merged_business,
            provenance=provenance,
            conflicts=tuple(conflicts),
            merged_at=datetime.now(timezone.utc),
        )
