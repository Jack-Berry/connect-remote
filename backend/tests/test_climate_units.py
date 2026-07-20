"""Climate target unit conversion.

Regression for a silent, car-visible bug: the proxy's API is Celsius, but
hyundai_kia_connect_api picks a per-region implementation that decides the unit
itself and converts nothing. US impls hardcode "unit": 1 (Fahrenheit), so a
raw Celsius passthrough sent 21 -> 21°F, and Kia US coerces anything under 62
to the string "LOW" — meaning every temperature the proxy could send became
"LOW". See app/climate_units.py for the per-region table.
"""

import pytest

from app.climate_units import c_to_f, snap, wire_temp, wire_unit

# The real ranges from hyundai_kia_connect_api 4.15.0.
EU_RANGE = [x * 0.5 for x in range(28, 60)]  # 14.0–29.5
AU_RANGE = [x * 0.5 for x in range(34, 54)]  # 17.0–26.5
HYUNDAI_US_RANGE = range(62, 82)  # 62–81 °F
KIA_US_RANGE = range(62, 83)  # 62–82 °F


def test_wire_unit_is_fahrenheit_only_for_the_us():
    assert wire_unit(3) == "F"
    for region in (1, 2, 5):
        assert wire_unit(region) == "C"


def test_celsius_regions_pass_the_value_through():
    assert wire_temp(21.0, 1, EU_RANGE) == 21.0
    assert wire_temp(22.5, 1, EU_RANGE) == 22.5
    assert wire_temp(21.0, 2, None) == 21.0


def test_us_converts_to_fahrenheit():
    # The headline fix: 21°C must reach the car as ~70°F, not as 21.
    assert wire_temp(21.0, 3, HYUNDAI_US_RANGE) == 70
    assert wire_temp(21.0, 3, KIA_US_RANGE) == 70
    assert wire_temp(25.0, 3, KIA_US_RANGE) == 77


@pytest.mark.parametrize("celsius", [14.0, 17.0, 21.0, 25.0, 30.0])
def test_us_never_lands_below_kias_low_threshold(celsius):
    # KiaUvoApiUSA rewrites set_temp < 62 to the string "LOW". Every value the
    # proxy accepts (14–30°C) must clear that after conversion and snapping.
    assert wire_temp(celsius, 3, KIA_US_RANGE) >= 62


def test_snapping_keeps_values_inside_the_accepted_range():
    # Several impls call temperature_range.index(set_temp) and raise
    # ValueError on a non-member, so the result must always be a real member.
    for celsius in (14.0, 21.0, 30.0):
        assert wire_temp(celsius, 1, EU_RANGE) in EU_RANGE
        assert wire_temp(celsius, 5, AU_RANGE) in AU_RANGE
        assert wire_temp(celsius, 3, KIA_US_RANGE) in KIA_US_RANGE


def test_snapping_clamps_beyond_the_range_ends():
    # 30°C exceeds both the EU max (29.5) and the AU max (26.5); the proxy
    # allows it, so it must land on the range end rather than raise upstream.
    assert wire_temp(30.0, 1, EU_RANGE) == 29.5
    assert wire_temp(30.0, 5, AU_RANGE) == 26.5
    assert wire_temp(14.0, 5, AU_RANGE) == 17.0
    # 30°C is 86°F, past the Hyundai US max of 81.
    assert wire_temp(30.0, 3, HYUNDAI_US_RANGE) == 81


def test_snap_without_a_range_falls_back_to_the_half_degree_grid():
    # Canada publishes no flat temperature_range; both of its year-dependent
    # ranges are 0.5°C grids.
    assert snap(21.3, None) == 21.5
    assert snap(21.1, None) == 21.0
    assert wire_temp(21.2, 2, None) == 21.0


def test_c_to_f_reference_points():
    assert c_to_f(0) == 32
    assert c_to_f(100) == 212
    assert c_to_f(21) == pytest.approx(69.8)
