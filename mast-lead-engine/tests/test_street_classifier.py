"""
Tests for street inventory classification, variant collapsing, and address verification.
"""

import pytest
from street_inventory.classifier import (
    is_low_value_street,
    collapse_street_name,
    extract_street_portion_from_address,
    is_address_on_street,
)


def test_collapse_35_variants():
    """Real example: 35 EB/35 WB/35th St Pedestrian Bridge/35th Street Access Path collapse to the same road."""
    variants = [
        "35 EB",
        "35 WB",
        "35th St Pedestrian Bridge",
        "35th Street Access Path",
    ]
    collapsed = {collapse_street_name(v) for v in variants}
    assert len(collapsed) == 1, f"Expected all variants to collapse to 1 street name, got: {collapsed}"
    assert "35th street" in collapsed


def test_suite_number_not_accepted():
    """Real example: '110th Street' must not accept '311 S Wacker Dr #110'."""
    assert not is_address_on_street("311 S Wacker Dr #110, Chicago, IL 60606", "110th Street")
    assert not is_address_on_street("311 S Wacker Dr Suite 110", "110th Street")


def test_building_number_not_accepted():
    """Real example: '108th Street' must not accept '108 N State St'."""
    assert not is_address_on_street("108 N State St, Chicago, IL 60602", "108th Street")


def test_name_collision_not_accepted():
    """Real example: Pedestrian Coffee (939 W Belmont Ave) must not pass for '41st Street Pedestrian Bridge'."""
    assert not is_address_on_street("939 W Belmont Ave, Chicago, IL 60657", "41st Street Pedestrian Bridge")


def test_valid_address_matches():
    """Legitimate business on targeted street passes."""
    assert is_address_on_street("3500 S State St, Chicago, IL 60616", "State Street")
    assert is_address_on_street("123 W 35th St, Chicago, IL 60616", "35th Street")
    assert is_address_on_street("123 W 35th St, Chicago, IL 60616", "35 EB")


def test_low_value_filtering():
    """Low-value streets, route refs, and ramps are correctly flagged."""
    low, reason = is_low_value_street("35 EB")
    assert low and reason == "route_ref"

    low, reason = is_low_value_street("315, 379")
    assert low and reason == "number_only"

    low, reason = is_low_value_street("41st Street Pedestrian Bridge")
    assert low and reason == "feature_pedestrian_bridge"

    low, reason = is_low_value_street("35th Street Access Path")
    assert low and reason == "feature_access_path"

    low, reason = is_low_value_street("North State Street")
    assert not low and reason is None
