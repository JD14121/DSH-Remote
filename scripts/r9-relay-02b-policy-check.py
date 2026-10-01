#!/usr/bin/env python3
"""Verify the production policy TOML parses and carries the expected values."""
import json
import tomllib

with open("/work/policy.toml", "rb") as fh:
    p = tomllib.load(fh)

print(json.dumps({
    "top_level_keys": sorted(p.keys()),
    "approved_proxies": p.get("approved_proxies"),
    "allowed_fields_count": len(p.get("allowed_fields") or []),
    "allowed_fields": p.get("allowed_fields"),
    "must_be_empty": p.get("must_be_empty"),
    "max_body_bytes": p.get("max_body_bytes"),
    "denied_proxy_types": p.get("denied_proxy_types"),
}, indent=2))
