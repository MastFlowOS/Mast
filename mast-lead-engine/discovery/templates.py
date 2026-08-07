"""
discovery/templates.py
======================

Static provider-specific discovery templates for Discovery Intelligence.

Design Rules
------------
- Immutable, slotted dataclass ``DiscoveryTemplate``.
- Each template describes how a niche maps onto a specific provider.
- Static knowledge only — NO runtime network, AI, scoring, or execution logic.
- Supported providers:
  - Google Maps (search phrases)
  - Yelp (category aliases)
  - Overpass (OSM tags)
  - Apple Maps (POI categories)
  - Azure Maps (search parameters)
  - Foursquare (category IDs / aliases)
  - Crunchbase (organization filters)
  - Apollo (industry filters)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from discovery.registry import DiscoveryTemplateRegistry


@dataclass(frozen=True, slots=True)
class DiscoveryTemplate:
    """
    Immutable template holding static provider-niche mapping knowledge.

    Fields
    ------
    template_id
        Unique template identifier (default: ``"{provider_id}:{niche_id}"``).
    provider_id
        Target provider identifier (e.g. 'google_maps', 'yelp').
    niche_id
        Target niche identifier (e.g. 'web_design').
    search_phrases
        Search phrases for providers that support free-text query expansion.
    category_aliases
        Category IDs or aliases (for Yelp, Foursquare, etc.).
    osm_tags
        OpenStreetMap key-value tags as tuple of (key, value) pairs.
    poi_categories
        Points of Interest categories (for Apple Maps, Azure Maps, etc.).
    industry_filters
        Industry filter strings (for Apollo, Crunchbase, etc.).
    organization_filters
        Organization category/type filters (for Crunchbase, etc.).
    custom_params
        Arbitrary static key-value parameters for provider customization.
    """

    provider_id: str
    niche_id: str
    template_id: str = ""
    search_phrases: tuple[str, ...] = ()
    category_aliases: tuple[str, ...] = ()
    osm_tags: tuple[tuple[str, str], ...] = ()
    poi_categories: tuple[str, ...] = ()
    industry_filters: tuple[str, ...] = ()
    organization_filters: tuple[str, ...] = ()
    custom_params: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        if not self.template_id:
            object.__setattr__(
                self, "template_id", f"{self.provider_id}:{self.niche_id}"
            )

        if not isinstance(self.search_phrases, tuple):
            object.__setattr__(self, "search_phrases", tuple(self.search_phrases))

        if not isinstance(self.category_aliases, tuple):
            object.__setattr__(self, "category_aliases", tuple(self.category_aliases))

        if not isinstance(self.osm_tags, tuple):
            object.__setattr__(
                self,
                "osm_tags",
                tuple(
                    pair if isinstance(pair, tuple) else tuple(pair)
                    for pair in self.osm_tags
                ),
            )

        if not isinstance(self.poi_categories, tuple):
            object.__setattr__(self, "poi_categories", tuple(self.poi_categories))

        if not isinstance(self.industry_filters, tuple):
            object.__setattr__(self, "industry_filters", tuple(self.industry_filters))

        if not isinstance(self.organization_filters, tuple):
            object.__setattr__(
                self, "organization_filters", tuple(self.organization_filters)
            )

        if not isinstance(self.custom_params, tuple):
            object.__setattr__(
                self,
                "custom_params",
                tuple(
                    pair if isinstance(pair, tuple) else tuple(pair)
                    for pair in self.custom_params
                ),
            )


# ---------------------------------------------------------------------------
# Default Provider Templates Knowledge Base
# ---------------------------------------------------------------------------

def get_default_templates() -> tuple[DiscoveryTemplate, ...]:
    """
    Return a tuple of default static discovery templates for core niches across all
    supported providers.
    """
    templates: list[DiscoveryTemplate] = [
        # --- Web Design ---
        DiscoveryTemplate(
            provider_id="google_maps",
            niche_id="web_design",
            search_phrases=(
                "web design agency",
                "website designer",
                "web development company",
                "digital agency",
            ),
        ),
        DiscoveryTemplate(
            provider_id="yelp",
            niche_id="web_design",
            category_aliases=("web_design", "graphicdesign", "marketing"),
        ),
        DiscoveryTemplate(
            provider_id="apple_maps",
            niche_id="web_design",
            poi_categories=("WebDesigner", "SoftwareCompany", "AdvertisingAgency"),
            search_phrases=("web design", "website designer"),
        ),
        DiscoveryTemplate(
            provider_id="overpass",
            niche_id="web_design",
            osm_tags=(
                ("office", "it"),
                ("office", "graphic_design"),
                ("office", "advertising_agency"),
            ),
        ),
        DiscoveryTemplate(
            provider_id="azure_maps",
            niche_id="web_design",
            search_phrases=("web design", "website development"),
            poi_categories=("WEB_DESIGN", "SOFTWARE_DEVELOPMENT"),
        ),
        DiscoveryTemplate(
            provider_id="foursquare",
            niche_id="web_design",
            category_aliases=("11035", "11026", "11031"),
            search_phrases=("web design", "web development"),
        ),
        DiscoveryTemplate(
            provider_id="crunchbase",
            niche_id="web_design",
            organization_filters=("web-design", "web-development", "digital-agency"),
            industry_filters=("software", "web_development", "design"),
        ),
        DiscoveryTemplate(
            provider_id="apollo",
            niche_id="web_design",
            industry_filters=(
                "information_technology_services",
                "marketing_and_advertising",
                "design",
            ),
            search_phrases=("web design", "digital agency"),
        ),
        # --- SEO ---
        DiscoveryTemplate(
            provider_id="google_maps",
            niche_id="seo",
            search_phrases=("seo agency", "seo consultant", "digital marketing agency"),
        ),
        DiscoveryTemplate(
            provider_id="yelp",
            niche_id="seo",
            category_aliases=("seo", "marketing"),
        ),
        DiscoveryTemplate(
            provider_id="apple_maps",
            niche_id="seo",
            poi_categories=("MarketingAgency", "Consultant"),
            search_phrases=("seo agency", "seo consultant"),
        ),
        DiscoveryTemplate(
            provider_id="overpass",
            niche_id="seo",
            osm_tags=(("office", "advertising_agency"), ("office", "marketing")),
        ),
        DiscoveryTemplate(
            provider_id="azure_maps",
            niche_id="seo",
            search_phrases=("seo consultant", "digital marketing"),
        ),
        DiscoveryTemplate(
            provider_id="foursquare",
            niche_id="seo",
            category_aliases=("11031", "11026"),
            search_phrases=("seo agency", "digital marketing"),
        ),
        DiscoveryTemplate(
            provider_id="crunchbase",
            niche_id="seo",
            organization_filters=("seo", "digital-marketing"),
            industry_filters=("search_engine", "marketing"),
        ),
        DiscoveryTemplate(
            provider_id="apollo",
            niche_id="seo",
            industry_filters=("marketing_and_advertising", "search_engine_optimization"),
            search_phrases=("seo agency", "search engine optimization"),
        ),
    ]
    return tuple(templates)


def register_default_templates(registry: DiscoveryTemplateRegistry) -> None:
    """
    Register default static templates into the provided *registry*.
    """
    for template in get_default_templates():
        if not registry.exists(template.template_id):
            registry.register(template)
