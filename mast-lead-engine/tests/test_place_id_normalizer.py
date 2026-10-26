"""
tests/test_place_id_normalizer.py
=================================

Tests for canonical Place ID normalization and bi-directional hex/ChIJ conversion.
Verifies the five verified production pairs:
- Café Calidá
- Two Mile
- Mate & Company
- LVL UP
- Pedestrian Coffee
"""

import pytest
from utils.place_id import canonical_place_id, chij_to_hex, expand_place_id_forms, hex_to_chij

VERIFIED_PAIRS = [
    ("Café Calidá", "0x880fcd7f8fee01b5:0x89b38e817d796008", "ChIJtQHuj3_ND4gRCGB5fYGOs4k"),
    ("Two Mile", "0x880e25d2309d7c1d:0xb7d6f52d9e2cd16", "ChIJHXydMNIlDogRFs3i2VJvfQs"),
    ("Mate & Company", "0x880fcd00123c18d3:0xb0dee2bb5ebf8429", "ChIJ0xg8EgDND4gRKYS_Xrvi3rA"),
    ("LVL UP", "0x880e2d8be7e51999:0x67a9389ccd491477", "ChIJmRnl54stDogRdxRJzZw4qWc"),
    ("Pedestrian Coffee", "0x880fd37e809c62a5:0xa3c8126d20326228", "ChIJpWKcgH7TD4gRKGIyIG0SyKM"),
]


@pytest.mark.parametrize("name, hex_pair, chij", VERIFIED_PAIRS)
def test_verified_pairs_hex_to_chij(name, hex_pair, chij):
    computed_chij = hex_to_chij(hex_pair)
    assert computed_chij == chij, f"Failed hex_to_chij for {name}"


@pytest.mark.parametrize("name, hex_pair, chij", VERIFIED_PAIRS)
def test_verified_pairs_chij_to_hex(name, hex_pair, chij):
    computed_hex = chij_to_hex(chij)
    assert computed_hex == hex_pair, f"Failed chij_to_hex for {name}"


@pytest.mark.parametrize("name, hex_pair, chij", VERIFIED_PAIRS)
def test_canonical_place_id_normalizes_both_to_hex(name, hex_pair, chij):
    assert canonical_place_id(chij) == hex_pair
    assert canonical_place_id(hex_pair) == hex_pair
    assert canonical_place_id(hex_pair.upper()) == hex_pair


@pytest.mark.parametrize("name, hex_pair, chij", VERIFIED_PAIRS)
def test_expand_place_id_forms_contains_both(name, hex_pair, chij):
    forms_from_chij = expand_place_id_forms(chij)
    assert hex_pair in forms_from_chij
    assert chij in forms_from_chij

    forms_from_hex = expand_place_id_forms(hex_pair)
    assert hex_pair in forms_from_hex
    assert chij in forms_from_hex


def test_invalid_place_ids():
    assert chij_to_hex("") is None
    assert chij_to_hex("invalid") is None
    assert chij_to_hex("ChIJshort") is None
    assert hex_to_chij("") is None
    assert hex_to_chij("not_hex") is None
    assert canonical_place_id("custom_id_123") == "custom_id_123"
