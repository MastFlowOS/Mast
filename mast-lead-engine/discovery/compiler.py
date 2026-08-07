"""
discovery/compiler.py
=====================

Stateless DiscoveryCompiler for Discovery Intelligence.

Responsibility
--------------
Translates one ``DiscoveryIntent`` into a ``CompiledDiscovery`` containing
provider-native ``ProviderDiscoveryRequest`` objects.

Design Rules
------------
- Completely stateless and deterministic — identical inputs yield identical outputs.
- Performs translation ONLY.
- Does NOT rank providers, choose providers, execute providers, score businesses,
  or perform AI reasoning.
- Consumes:
  - ``DiscoveryIntent``
  - Optional ``NicheRegistry``
  - Optional ``DiscoveryTemplateRegistry``
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from discovery.models import CompiledDiscovery, DiscoveryIntent, ProviderDiscoveryRequest
from discovery.templates import DiscoveryTemplate, get_default_templates
from discovery.registry import DiscoveryTemplateRegistry

if TYPE_CHECKING:
    from niches.registry import NicheRegistry


_DEFAULT_PROVIDERS: tuple[str, ...] = (
    "google_maps",
    "yelp",
    "apple_maps",
    "overpass",
    "azure_maps",
    "foursquare",
    "crunchbase",
    "apollo",
)


class DiscoveryCompiler:
    """
    Stateless compiler that translates a generic ``DiscoveryIntent`` into a
    deterministic set of provider-native discovery requests.

    Methods
    -------
    compile(intent, niche_registry=None, template_registry=None)
        Return a ``CompiledDiscovery`` for the given *intent*.
    """

    def compile(
        self,
        intent: DiscoveryIntent,
        niche_registry: NicheRegistry | None = None,
        template_registry: DiscoveryTemplateRegistry | None = None,
    ) -> CompiledDiscovery:
        """
        Compile *intent* into a deterministic ``CompiledDiscovery``.

        Parameters
        ----------
        intent
            The user discovery intent to compile.
        niche_registry
            Optional ``NicheRegistry`` to inspect niche metadata/keywords.
        template_registry
            Optional ``DiscoveryTemplateRegistry`` to inspect static provider templates.

        Returns
        -------
        CompiledDiscovery
            The compiled per-provider requests.
        """
        if not isinstance(intent, DiscoveryIntent):
            raise TypeError(f"intent must be a DiscoveryIntent; got {type(intent)!r}")

        # Determine target provider IDs
        if intent.requested_providers is not None and len(intent.requested_providers) > 0:
            target_providers = intent.requested_providers
        else:
            target_providers = _DEFAULT_PROVIDERS

        compiled_requests: list[ProviderDiscoveryRequest] = []

        for provider_id in target_providers:
            # Lookup template if registry available, or search default templates
            template = self._find_template(provider_id, intent.niche_id, template_registry)

            # Build provider-native request deterministically
            request = self._compile_provider_request(intent, provider_id, template, niche_registry)
            compiled_requests.append(request)

        return CompiledDiscovery(
            intent=intent,
            requests=tuple(compiled_requests),
        )

    def _find_template(
        self,
        provider_id: str,
        niche_id: str,
        template_registry: DiscoveryTemplateRegistry | None,
    ) -> DiscoveryTemplate | None:
        if template_registry is not None:
            if template_registry.exists_for_provider_and_niche(provider_id, niche_id):
                return template_registry.get_for_provider_and_niche(provider_id, niche_id)

        # Fallback to default static templates
        for default_tmpl in get_default_templates():
            if default_tmpl.provider_id == provider_id and default_tmpl.niche_id == niche_id:
                return default_tmpl

        return None

    def _compile_provider_request(
        self,
        intent: DiscoveryIntent,
        provider_id: str,
        template: DiscoveryTemplate | None,
        niche_registry: NicheRegistry | None,
    ) -> ProviderDiscoveryRequest:
        # Resolve search phrases from template or intent keywords
        search_phrases = template.search_phrases if template else ()
        if not search_phrases and intent.keywords:
            search_phrases = intent.keywords

        categories = template.category_aliases if template else ()
        osm_tags = template.osm_tags if template else ()
        poi_categories = template.poi_categories if template else ()
        industry_filters = template.industry_filters if template else ()
        organization_filters = template.organization_filters if template else ()
        custom_params = template.custom_params if template else ()

        # Construct primary search query string deterministically
        query = self._build_query_string(intent, search_phrases)

        # Construct native payload dict/tuple
        payload_items: list[tuple[str, Any]] = [
            ("provider_id", provider_id),
            ("niche_id", intent.niche_id),
            ("query", query),
            ("city", intent.city),
            ("region", intent.region),
            ("country", intent.country),
            ("radius_km", intent.radius_km),
            ("max_results", intent.max_results),
        ]

        if search_phrases:
            payload_items.append(("search_phrases", search_phrases))
        if categories:
            payload_items.append(("categories", categories))
        if osm_tags:
            payload_items.append(("osm_tags", osm_tags))
        if poi_categories:
            payload_items.append(("poi_categories", poi_categories))
        if industry_filters:
            payload_items.append(("industry_filters", industry_filters))
        if organization_filters:
            payload_items.append(("organization_filters", organization_filters))
        if custom_params:
            payload_items.append(("custom_params", custom_params))

        return ProviderDiscoveryRequest(
            provider_id=provider_id,
            niche_id=intent.niche_id,
            query=query,
            city=intent.city,
            region=intent.region,
            country=intent.country,
            radius_km=intent.radius_km,
            max_results=intent.max_results,
            search_phrases=search_phrases,
            categories=categories,
            osm_tags=osm_tags,
            poi_categories=poi_categories,
            industry_filters=industry_filters,
            organization_filters=organization_filters,
            custom_params=custom_params,
            payload=tuple(payload_items),
        )

    def _build_query_string(
        self, intent: DiscoveryIntent, search_phrases: tuple[str, ...]
    ) -> str:
        base_term = search_phrases[0] if search_phrases else intent.niche_id.replace("_", " ")
        location_parts = [p for p in (intent.city, intent.region, intent.country) if p]
        location_str = ", ".join(location_parts)

        if location_str:
            return f"{base_term} in {location_str}"
        return base_term
