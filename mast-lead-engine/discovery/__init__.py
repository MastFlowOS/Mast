"""
MAST Lead Engine — Discovery Intelligence Subsystem
===================================================

Phase 1: Architecture Foundation & Compilation Layer

This package translates a high-level DiscoveryIntent into provider-native
discovery requests (CompiledDiscovery).

Rules & Boundaries
------------------
- Independent from engine/, providers/ (except ProviderMetadata/ProviderCapabilities),
  storage/, database/, crm/, opportunities/, missions/, ai/, and intelligence/.
- Stateless translation only.
- Immutable domain models & thread-safe template registry.
- Zero execution, zero scheduling, zero provider ranking, zero AI logic.
"""

from discovery.models import (
    DiscoveryIntent,
    ProviderDiscoveryRequest,
    CompiledDiscovery,
)
from discovery.templates import (
    DiscoveryTemplate,
    register_default_templates,
)
from discovery.registry import DiscoveryTemplateRegistry
from discovery.compiler import DiscoveryCompiler

__all__ = [
    "DiscoveryIntent",
    "ProviderDiscoveryRequest",
    "CompiledDiscovery",
    "DiscoveryTemplate",
    "register_default_templates",
    "DiscoveryTemplateRegistry",
    "DiscoveryCompiler",
]
