"""
business_identity
=================

Business Identity Resolution Subsystem (Phase 1 Architecture Foundation).

Identifies identity relationships (equivalence) across canonical Business models.
Strictly declarative, immutable, and stateless.

Exposes:
- BusinessIdentity
- BusinessIdentityMatcher
- BusinessIdentityRegistry
"""

from __future__ import annotations

from .models import BusinessIdentity
from .matcher import BusinessIdentityMatcher
from .registry import BusinessIdentityRegistry

__all__ = [
    "BusinessIdentity",
    "BusinessIdentityMatcher",
    "BusinessIdentityRegistry",
]
