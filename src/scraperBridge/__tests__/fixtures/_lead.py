"""Shared minimal lead payload for the fake `service.py` fixtures used by
pythonBridge's lifecycle regression tests. Not a real engine — just enough
fields for runEngineQuery()'s JSON parsing to accept the line as a lead.
"""


def make_lead(i: int = 0):
    return {
        "name": f"Test Biz {i}",
        "address": "1 Main St",
        "city": "Testville",
        "country": "US",
        "query": "test",
        "niche": "test",
        "region": "test",
        "phone": "",
        "email": "",
        "website": "",
        "instagram": "",
        "facebook": "",
        "linkedin": "",
        "contact_form": "",
        "maps_link": "",
        "rating": None,
        "reviews": 0,
        "category": "",
        "price_range": "",
        "has_photos": False,
        "has_popular_times": False,
        "owner_responds_to_reviews": False,
        "is_google_verified": False,
        "multi_location": False,
        "closed": False,
        "ig_followers": None,
        "ig_bio": "",
        "ig_activity": "",
        "ig_last_post_days": None,
        "ig_legitimacy": 0,
        "tech_stack": {},
        "score": 0,
        "quality": "",
        "tier": "",
        "action": "",
        "fingerprints": [],
        "is_disqualified": False,
    }
