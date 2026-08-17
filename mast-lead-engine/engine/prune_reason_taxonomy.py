"""
engine/prune_reason_taxonomy.py
================================

Lead-Yield Waste Fix — observability step (item 6 of the follow-up fix,
see the MAST bottleneck audit §2 "Lead-Yield Funnel").

What this is
------------
A small, pure, stateless classifier that groups the free-text `reason`
strings already passed to `FanInRuntime.prune_business()` into a fixed
set of canonical categories, so a future log/metrics summary can answer
"how many missing_email vs missing_phone vs unreachable_website vs
contact_failure" prunes happened, without grepping free-text log lines.

This module defines NO new reason strings and changes NO call site's
pruning decision. It only classifies reasons that already exist at the
two call sites that already route through `FanInRuntime.prune_business()`
(see `engine/execution_driver.py`'s `_website_downstream` /
`_contact_downstream` closures):

    "unreachable_website"          -> UNREACHABLE_WEBSITE
    "unreachable_website_no_email" -> UNREACHABLE_WEBSITE
    "missing_required_channel:email" -> MISSING_EMAIL
    "missing_required_channel:phone" -> MISSING_PHONE

Explicit scope limit — please read before extending
-----------------------------------------------------------------------
There is a THIRD prune point, in `execution_driver.py`'s `_on_candidate`
closure (the discovery-time "safe channel pruning" gate, before a
candidate is ever registered with `FanInRuntime` at all — see that
function's `website` / `email` / `phone` / `instagram` branches). That
prune point does not call `FanInRuntime.prune_business()` and therefore
its reason is NOT counted by this module. Closing that gap would require
adding a line to `engine/execution_driver.py` itself, which the
Lead-Yield Waste Fix instructions explicitly excluded ("Do NOT: ...
change ExecutionDriver"). This module intentionally covers only the two
prune points that were already reachable without touching that file —
website-stage and contact-stage. Anyone extending this later to cover
the discovery-stage gate needs to revisit that constraint first.
"""

from __future__ import annotations

# Canonical categories a raw prune reason is grouped into. Deliberately a
# small, fixed set — matching the categories named in the Lead-Yield
# Waste Fix instructions (missing_email, missing_phone,
# unreachable_website, contact_failure) plus OTHER as a safe fallback for
# any reason string not yet recognized.
MISSING_EMAIL = "missing_email"
MISSING_PHONE = "missing_phone"
UNREACHABLE_WEBSITE = "unreachable_website"
CONTACT_FAILURE = "contact_failure"
OTHER = "other"

#: Every category this classifier can ever return — useful for a caller
#: that wants to pre-seed a zeroed counter dict rather than relying on
#: keys appearing lazily as reasons are first seen.
ALL_CATEGORIES = (
    MISSING_EMAIL,
    MISSING_PHONE,
    UNREACHABLE_WEBSITE,
    CONTACT_FAILURE,
    OTHER,
)


def classify_prune_reason(reason: str) -> str:
    """
    Map a raw `FanInRuntime.prune_business()` reason string to one of the
    canonical categories above.

    Pure, stateless, and total: an unrecognized reason string (a future
    reason this table hasn't been extended for, or a caller passing the
    method's own default `"early_pruned"`) falls back to OTHER rather
    than raising — a new reason string can never break this classifier,
    it just reports as OTHER until this table is deliberately extended.

    Order matters: "unreachable_website_no_email" is checked as a
    website-reachability failure FIRST, even though its string also
    contains "email" — the website being unreachable is the root cause;
    the missing email is a downstream consequence of that, not an
    independent email-specific failure the way
    "missing_required_channel:email" is.
    """
    r = (reason or "").strip().lower()
    if "unreachable_website" in r:
        return UNREACHABLE_WEBSITE
    if "contact" in r:
        return CONTACT_FAILURE
    if "email" in r:
        return MISSING_EMAIL
    if "phone" in r:
        return MISSING_PHONE
    return OTHER
