# Open-source snapshot · 2026-10-02

This snapshot contains the current Android sources, browser UI, Gateway and DSH adapter, deployment templates, Windows setup/management scripts, existing tests, design sources and architecture documents.

Excluded: local credentials and PKI, signing keystores, installed configuration, chat/session stores, logs, machine evidence, historical builds, APK outputs, node_modules, SDK/JDK/FRP binaries, editor authentication metadata and unrelated sibling projects. See `PUBLICATION-INVENTORY.json` for the selection inventory. Exclusions do not delete files from the original working installation.

Publication-only edits: current README and installer instructions, MIT license and third-party notices, package metadata, root launcher relocation, UTF-8 BOM normalization, generic user-path placeholders, removal of the design editor fileToken, and narrowly reviewed synthetic-fixture secret-scan annotations. Original running project files and services are preserved.

Pre-publication checks: Gitleaks 8.30.1 with full redaction, manual review of synthetic findings (see `SECRET-SCAN-REVIEW.json`), private/binary credential filename exclusions, file-size inspection, JavaScript syntax checks and Windows launcher syntax checks. No new full unit-test run, clean-machine installation or new production traffic is claimed by publication.

The project is an independently developed DSH companion. The current production hostname is still fixed in its policies; general service pairing and release signing remain future work. Historical R1–R9 documents are design context, not promises of current public deployment availability. Machine-specific evidence and root phase execution reports are intentionally not distributed.
