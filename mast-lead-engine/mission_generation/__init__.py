"""
mission_generation
==================

Subsystem 14 — Mission Generation for the MAST Lead Engine 2.0.

Pure derived transformation mapping canonical ranked opportunities into
immutable commercial intent contracts (Missions).
"""

from mission_generation.models import Mission, MissionType
from mission_generation.service import MissionGenerationService

__all__ = (
    "MissionType",
    "Mission",
    "MissionGenerationService",
)
