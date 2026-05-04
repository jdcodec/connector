#!/usr/bin/env bash
# Rule 0 grep-gate — enforces the Hollow Connector invariant.
#
# The connector source must be self-contained AND free of both
# codec-internal terminology and internal/process vocabulary that
# leaks business context. Three checks:
#
#   1. No imports escape the package via 2+ levels of `../`.
#      (Catches direct imports of codec source from outside the connector.)
#
#   2. No codec-internal function names or DOM-codec terminology appears
#      in the connector source, tests, or shipped resources — even as
#      string literals or comments. Catches the failure mode where a
#      refactor accidentally drags codec vocabulary into the connector
#      without an actual import.
#
#   3. No internal/process vocabulary (ticket IDs, internal product
#      methodology terms, sibling-package paths) appears in the
#      connector source or tests. Catches the failure mode where a
#      port from a private package brings comments referencing internal
#      docs, work-tracking IDs, or cross-package coordination context.
#
# External codec or business logic stays out of the connector and out of
# any artefact published to npm or the public source repo.
#
# Exit non-zero on any violation. Fast, no deps — works in any CI.

set -euo pipefail

cd "$(dirname "$0")/.."

# ---------------------------------------------------------------------------
# Check 1: Import paths must not escape the package.
# Match `from "..."` or `import("...")` where the path starts with two or
# more levels of `../` — i.e., escapes the package's src/ tree.
# ---------------------------------------------------------------------------

IMPORT_PATTERN='(from|import).*["'"'"'](\.\./){2,}'

BAD_IMPORT=$(grep -rEn "$IMPORT_PATTERN" src \
               --include='*.ts' \
               --include='*.tsx' \
             || true)

if [ -n "$BAD_IMPORT" ]; then
  echo "ERROR: grep-gate failed — connector source contains imports that escape the package." >&2
  echo "Imports with 2+ levels of '../' may pull in code from outside this connector." >&2
  echo "" >&2
  echo "$BAD_IMPORT" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Check 2: Codec-internal terminology must not appear anywhere in connector
# source, tests, or shipped resources. Banned terms cover the codec's
# function names (Python snake_case + TS camelCase variants), the codec's
# session-state class, the snapshot/ref-map helper, and the DOM-codec
# I-Frame / P-Frame vocabulary.
# ---------------------------------------------------------------------------

CODEC_TERMS='parse_snapshot|parseSnapshot|diff_snapshots|diffSnapshots|compact_full|compactFull|compact_iframe|compactIframe|compact_pframe|compactPframe|CodecSessionState|snapshot_to_ref_map|I-Frame|P-Frame|i-frame|p-frame'

BAD_TERMS=$(grep -rEn "($CODEC_TERMS)" src test scripts package.json \
              --include='*.ts' \
              --include='*.tsx' \
              --include='*.js' \
              --include='*.json' \
              --include='*.md' \
              --include='*.sh' \
              --exclude='grep-gate.sh' \
              --exclude='grep-gate.test.ts' \
            2>/dev/null || true)

if [ -n "$BAD_TERMS" ]; then
  echo "ERROR: grep-gate failed — connector source references codec-internal terminology." >&2
  echo "These names belong to the codec, which lives server-side. The connector must" >&2
  echo "not reference them, even in comments or string literals." >&2
  echo "" >&2
  echo "$BAD_TERMS" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Check 3: Internal / process vocabulary must not leak into the connector.
# Banned items:
#   - Internal product/methodology terms ("painted door", "pip wrapper").
#   - Work-tracking IDs (PROD-001, FOPS-029, GROW-010, BUG-006, INFRA-X).
#   - Sibling-package paths inside this monorepo
#     (`packages/jdcodec-py`, `packages/jdcodec-py-internal`, `packages/jdcodec-cli`,
#      `server-ts`, `spikes/`, `backlog/`, `internal_notes`).
# Scoped to src/ + test/ since those are the artefacts that end up in
# the public source tree (script paths or package.json keywords are
# excluded — those are infrastructure, not narrative).
# ---------------------------------------------------------------------------

INTERNAL_TERMS='painted.?door|pip.wrapper|(PROD|FOPS|GROW|INFRA|BUG)-[0-9]+|packages/jdcodec-py|packages/jdcodec-cli|packages/jdcodec-py-internal|server-ts/|spikes/|backlog/|internal_notes'

BAD_INTERNAL=$(grep -rEni "($INTERNAL_TERMS)" src test \
                 --include='*.ts' \
                 --include='*.tsx' \
                 --include='*.js' \
                 --include='*.json' \
                 --include='*.md' \
                 --exclude='grep-gate.test.ts' \
               2>/dev/null || true)

if [ -n "$BAD_INTERNAL" ]; then
  echo "ERROR: grep-gate failed — connector source references internal/process vocabulary." >&2
  echo "Internal product terms, ticket IDs, and sibling-package paths must not appear in" >&2
  echo "src/ or test/. They leak business context into a publicly-distributed package." >&2
  echo "Move the comment to a private doc, or rewrite without the internal reference." >&2
  echo "" >&2
  echo "$BAD_INTERNAL" >&2
  exit 1
fi

echo "OK: grep-gate passed — connector source is self-contained, codec-clean, and free of internal vocabulary."
