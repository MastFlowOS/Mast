"""
MAST Engine V2 — Models Package (placeholder)
================================================

Source: Engine BluePrint, Phase 1.5 ("V2 Folder Structure").

Future responsibility
----------------------
Per the blueprint's target V2 layout, this package will eventually hold
the concrete data model implementations:

    models/business.py      — business-shaped models
    models/enrichment.py     — enrichment-shaped models
    models/opportunity.py    — opportunity-shaped models
    models/session.py        — session-shaped models

Today the *shape* of these concepts is defined structurally as
placeholders in engine/contracts.py and engine/session.py. This
package is created now, empty, so that a later milestone can introduce
concrete model implementations without inventing a new top-level
package at that time.

Status
------
FOUNDATION ONLY (Milestone 1). Empty package — no modules, no classes,
no logic. Not imported by the currently running engine.

TODO(future milestones): populated starting around Phase 6+ as
enrichment/qualification/storage packages are introduced, per the
blueprint's migration roadmap (Phase 1.5).
"""

from __future__ import annotations
