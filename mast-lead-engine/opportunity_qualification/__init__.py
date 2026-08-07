"""
opportunity_qualification
=========================

Package for Opportunity Qualification in the MAST Lead Engine.

This package provides a 100% stateless evaluation layer that determines whether a canonical
Opportunity objectively satisfies qualification rules to continue through the engine pipeline.
"""

from .models import OpportunityQualification, QualificationStatus
from .service import OpportunityQualificationService

__all__ = [
    "OpportunityQualification",
    "QualificationStatus",
    "OpportunityQualificationService",
]
