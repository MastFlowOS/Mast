"""
business_enrichment/models.py
==============================

Immutable domain models for Business Enrichment in the MAST Lead Engine.

Design Rules
------------
- Frozen, slotted dataclasses — runtime mutation is impossible.
- Collections are stored as immutable `tuple`.
- Self-contained deltas: `BusinessEnrichmentDelta` embeds its `source: EnrichmentSource`.
- Clean result model: `BusinessEnrichmentResult` directly owns the enriched `Business`,
  enrichment transaction ID, field provenances, conflict audit records, and timestamp.
- Strict isolation: Consumes standard library types, datetime, typing, and `business.models.Business`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from business.models import Business

_ID_PATTERN: re.Pattern[str] = re.compile(r"^[a-zA-Z0-9_-]+$")


def _validate_non_empty_str(value: str, label: str) -> None:
    """Raise ValueError if value is not a non-empty string."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string; got {value!r}")


class EnrichmentSourceType(str, Enum):
    """Origin category of an enrichment source."""

    PROVIDER = "provider"
    CRAWLER = "crawler"
    EMAIL_VERIFIER = "email_verifier"
    SOCIAL_DISCOVERY = "social_discovery"
    GEOCODER = "geocoder"
    COMPANY_DATABASE = "company_database"
    AI_EXTRACTOR = "ai_extractor"
    MANUAL_CORRECTION = "manual_correction"


class ConflictResolution(str, Enum):
    """Action taken when resolving an enrichment field conflict."""

    PRESERVED = "preserved"
    OVERWRITTEN = "overwritten"
    MERGED = "merged"


class EnrichmentPolicyStrategy(str, Enum):
    """Strategy for evaluating candidate enrichment field values."""

    PRESERVE_EXISTING = "preserve_existing"
    OVERWRITE_IF_HIGHER_CONFIDENCE = "overwrite_if_higher_confidence"
    UNION_COLLECTIONS = "union_collections"


@dataclass(frozen=True, slots=True)
class EnrichmentSource:
    """
    Immutable representation of an enrichment data source.

    Fields
    ------
    source_id
        Unique identifier for the enrichment source instance (e.g. 'src_apollo_01').
    source_type
        Categorical type of the source (EnrichmentSourceType).
    timestamp
        Timestamp when the source produced the enrichment data.
    provider_id
        Optional identifier of the external provider (e.g. 'apollo', 'google_maps').
    """

    source_id: str
    source_type: EnrichmentSourceType
    timestamp: datetime
    provider_id: str | None = None

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.source_id, "source_id")

        if not isinstance(self.source_type, EnrichmentSourceType):
            raise TypeError(f"source_type must be an EnrichmentSourceType enum; got {type(self.source_type)!r}")

        if not isinstance(self.timestamp, datetime):
            raise TypeError(f"timestamp must be a datetime instance; got {type(self.timestamp)!r}")

        if self.provider_id is not None:
            _validate_non_empty_str(self.provider_id, "provider_id")


@dataclass(frozen=True, slots=True)
class EnrichedField:
    """
    Immutable lineage record for a single field in an enriched Business entity.

    Fields
    ------
    field_name
        Name of the target field (e.g. 'phone', 'website', 'description').
    value
        Final value assigned to the field in the enriched entity.
    source_id
        Source identifier that contributed this value.
    provider_id
        Optional provider identifier associated with the source.
    confidence
        Confidence score of the field value (0.0 to 1.0).
    evaluated_at
        Timestamp when the field was evaluated/enriched.
    """

    field_name: str
    value: Any
    source_id: str
    confidence: float
    evaluated_at: datetime
    provider_id: str | None = None

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.field_name, "field_name")
        _validate_non_empty_str(self.source_id, "source_id")

        if not isinstance(self.evaluated_at, datetime):
            raise TypeError(f"evaluated_at must be a datetime instance; got {type(self.evaluated_at)!r}")

        if not isinstance(self.confidence, (int, float)) or isinstance(self.confidence, bool):
            raise TypeError(f"confidence must be a float between 0.0 and 1.0; got {type(self.confidence)!r}")

        if not (0.0 <= float(self.confidence) <= 1.0):
            raise ValueError(f"confidence must be between 0.0 and 1.0; got {self.confidence!r}")

        if self.provider_id is not None:
            _validate_non_empty_str(self.provider_id, "provider_id")


@dataclass(frozen=True, slots=True)
class EnrichmentConflict:
    """
    Immutable audit record documenting a field-level disagreement during enrichment.

    Fields
    ------
    field_name
        Target field name.
    existing_value
        Current value on the Business entity prior to enrichment.
    proposed_value
        Discrepant value proposed by the enrichment source delta.
    source_id
        Identifier of the enrichment source proposing the candidate value.
    resolution
        Action taken to resolve the conflict (PRESERVED, OVERWRITTEN, MERGED).
    reason
        Human-readable explanation of why the conflict was resolved this way.
    """

    field_name: str
    existing_value: Any
    proposed_value: Any
    source_id: str
    resolution: ConflictResolution
    reason: str

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.field_name, "field_name")
        _validate_non_empty_str(self.source_id, "source_id")
        _validate_non_empty_str(self.reason, "reason")

        if not isinstance(self.resolution, ConflictResolution):
            raise TypeError(f"resolution must be a ConflictResolution enum; got {type(self.resolution)!r}")


@dataclass(frozen=True, slots=True)
class BusinessEnrichmentDelta:
    """
    Strongly typed, self-contained enrichment candidate container.

    Fields mirror optional canonical Business fields and carry an embedded `source`.
    Validation occurs at construction time (`__post_init__`).
    """

    source: EnrichmentSource
    name: str | None = None
    category: str | None = None
    address: str | None = None
    city: str | None = None
    region: str | None = None
    country: str | None = None
    postal_code: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    description: str | None = None
    instagram_url: str | None = None
    facebook_url: str | None = None
    linkedin_url: str | None = None
    phones: tuple[str, ...] = ()
    emails: tuple[str, ...] = ()
    websites: tuple[str, ...] = ()
    confidence: float = 1.0

    def __post_init__(self) -> None:
        if not isinstance(self.source, EnrichmentSource):
            raise TypeError(f"source must be an EnrichmentSource instance; got {type(self.source)!r}")

        if not isinstance(self.confidence, (int, float)) or isinstance(self.confidence, bool):
            raise TypeError(f"confidence must be a float; got {type(self.confidence)!r}")

        if not (0.0 <= float(self.confidence) <= 1.0):
            raise ValueError(f"confidence must be between 0.0 and 1.0; got {self.confidence!r}")

        # Validate string fields if present
        opt_str_fields = [
            ("name", self.name),
            ("category", self.category),
            ("address", self.address),
            ("city", self.city),
            ("region", self.region),
            ("country", self.country),
            ("postal_code", self.postal_code),
            ("description", self.description),
            ("instagram_url", self.instagram_url),
            ("facebook_url", self.facebook_url),
            ("linkedin_url", self.linkedin_url),
        ]
        for label, val in opt_str_fields:
            if val is not None and not isinstance(val, str):
                raise TypeError(f"{label} must be a string or None; got {type(val)!r}")

        # Validate geographic coordinates
        if self.latitude is not None:
            if not isinstance(self.latitude, (int, float)) or isinstance(self.latitude, bool):
                raise TypeError(f"latitude must be a float or None; got {type(self.latitude)!r}")
            if not (-90.0 <= float(self.latitude) <= 90.0):
                raise ValueError(f"latitude must be between -90.0 and 90.0; got {self.latitude!r}")

        if self.longitude is not None:
            if not isinstance(self.longitude, (int, float)) or isinstance(self.longitude, bool):
                raise TypeError(f"longitude must be a float or None; got {type(self.longitude)!r}")
            if not (-180.0 <= float(self.longitude) <= 180.0):
                raise ValueError(f"longitude must be between -180.0 and 180.0; got {self.longitude!r}")

        # Coerce and validate collection fields
        for col_name, col_val in [
            ("phones", self.phones),
            ("emails", self.emails),
            ("websites", self.websites),
        ]:
            if not isinstance(col_val, tuple):
                col_tuple = tuple(col_val)
            else:
                col_tuple = col_val

            for item in col_tuple:
                _validate_non_empty_str(item, f"item in {col_name}")

            object.__setattr__(self, col_name, col_tuple)


@dataclass(frozen=True, slots=True)
class EnrichmentPolicy:
    """
    Immutable policy configuration governing field evaluation strategies.
    """

    scalar_strategy: EnrichmentPolicyStrategy = EnrichmentPolicyStrategy.OVERWRITE_IF_HIGHER_CONFIDENCE
    collection_strategy: EnrichmentPolicyStrategy = EnrichmentPolicyStrategy.UNION_COLLECTIONS
    coordinate_strategy: EnrichmentPolicyStrategy = EnrichmentPolicyStrategy.OVERWRITE_IF_HIGHER_CONFIDENCE
    min_confidence_threshold: float = 0.0

    def __post_init__(self) -> None:
        if not isinstance(self.scalar_strategy, EnrichmentPolicyStrategy):
            raise TypeError(f"scalar_strategy must be an EnrichmentPolicyStrategy; got {type(self.scalar_strategy)!r}")

        if not isinstance(self.collection_strategy, EnrichmentPolicyStrategy):
            raise TypeError(f"collection_strategy must be an EnrichmentPolicyStrategy; got {type(self.collection_strategy)!r}")

        if not isinstance(self.coordinate_strategy, EnrichmentPolicyStrategy):
            raise TypeError(f"coordinate_strategy must be an EnrichmentPolicyStrategy; got {type(self.coordinate_strategy)!r}")

        if not isinstance(self.min_confidence_threshold, (int, float)) or isinstance(self.min_confidence_threshold, bool):
            raise TypeError(f"min_confidence_threshold must be a float; got {type(self.min_confidence_threshold)!r}")

        if not (0.0 <= float(self.min_confidence_threshold) <= 1.0):
            raise ValueError(f"min_confidence_threshold must be between 0.0 and 1.0; got {self.min_confidence_threshold!r}")


DEFAULT_ENRICHMENT_POLICY = EnrichmentPolicy()


@dataclass(frozen=True, slots=True)
class BusinessEnrichmentResult:
    """
    Immutable result container returned by BusinessEnrichmentService.

    Fields
    ------
    enriched_business
        Brand-new immutable Business instance containing enriched values.
    enrichment_id
        Unique identifier for this enrichment operation.
    field_provenances
        Immutable tuple of EnrichedField objects recording provenance and confidence per field.
    conflicts
        Immutable tuple of EnrichmentConflict audit records documenting field discrepancies.
    enriched_at
        Timestamp when enrichment was performed.
    """

    enriched_business: Business
    enrichment_id: str
    field_provenances: tuple[EnrichedField, ...]
    conflicts: tuple[EnrichmentConflict, ...]
    enriched_at: datetime

    def __post_init__(self) -> None:
        _validate_non_empty_str(self.enrichment_id, "enrichment_id")

        if not isinstance(self.enriched_at, datetime):
            raise TypeError(f"enriched_at must be a datetime instance; got {type(self.enriched_at)!r}")

        # Coerce collections to immutable tuples
        if not isinstance(self.field_provenances, tuple):
            fp_tuple = tuple(self.field_provenances)
        else:
            fp_tuple = self.field_provenances

        for fp in fp_tuple:
            if not isinstance(fp, EnrichedField):
                raise TypeError(f"item in field_provenances must be an EnrichedField; got {type(fp)!r}")

        object.__setattr__(self, "field_provenances", fp_tuple)

        if not isinstance(self.conflicts, tuple):
            conf_tuple = tuple(self.conflicts)
        else:
            conf_tuple = self.conflicts

        for conf in conf_tuple:
            if not isinstance(conf, EnrichmentConflict):
                raise TypeError(f"item in conflicts must be an EnrichmentConflict; got {type(conf)!r}")

        object.__setattr__(self, "conflicts", conf_tuple)
