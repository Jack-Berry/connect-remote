# Test fixtures

Real anonymised API response samples, copied verbatim from the
[hyundai_kia_connect_api](https://github.com/Hyundai-Kia-Connect/hyundai_kia_connect_api)
test suite at tag v4.15.0 (MIT License, © 2021 Fuat Akgun). They exercise the
proxy's powertrain detection through the lib's real region parsers instead of
hand-built vehicle objects.

**All available fixtures are pure EVs** — the lib ships no HEV/PHEV/ICE
samples (verified against the full v4.15.0 test suite). HEV/PHEV/ICE
detection is covered by synthetic vehicle objects in `test_powertrain.py`,
built from the parser source's documented behavior, until real testers'
`/debug/fields` dumps provide genuine payloads. See
docs-internal/POWERTRAIN-FIELDS.md for the field evidence and gaps.

| File | Parser | Powertrain |
|---|---|---|
| `us_kia_niro_ev_2020_cached.json` | `KiaUvoApiUSA` (our Kia-US path) | EV |
| `us_kia_niro_ev_2020_force_refresh.json` | `KiaUvoApiUSA` | EV |
| `eu_kia_ev6_2023_with_soc.json` | `KiaUvoApiEU` (our Genesis-UK path) | EV |
| `eu_kia_ev9_2024_ccs2.json` | `ApiImplType1` CCS2 (newer EU cars) | EV |
