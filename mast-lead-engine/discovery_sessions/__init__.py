"""
discovery_sessions/__init__.py
==============================

MAST Lead Engine — Discovery Sessions Subsystem.

This package owns and manages the runtime lifecycle state of a discovery session.

Subsystem Boundaries
--------------------
- Pure runtime state and lifecycle management.
- Does NOT execute providers, schedule tasks, query DBs, call AI, score opportunities,
  enrich businesses, or communicate with the CRM.
- Independent from engine/, providers/ (runtime), storage/, database/, crm/, missions/,
  opportunities/, ai/.
- Consumes immutable models from Discovery Intelligence (discovery.models).
- Thread-safe registry and stateless lifecycle management.
"""

from discovery_sessions.models import DiscoverySession
from discovery_sessions.state import DiscoverySessionState
from discovery_sessions.lifecycle import DiscoverySessionLifecycle
from discovery_sessions.registry import DiscoverySessionRegistry

__all__ = [
    "DiscoverySession",
    "DiscoverySessionState",
    "DiscoverySessionLifecycle",
    "DiscoverySessionRegistry",
]
