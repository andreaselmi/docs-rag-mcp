#!/usr/bin/env bash
# Builds dist-skill/docs-rag-skill.zip: the skills/docs-rag folder plus AUTHORING.md
# as references/authoring.md. AUTHORING.md stays the single source in the repo;
# it is copied only into the zip, so the two never drift.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cp -R "$root/skills/docs-rag" "$stage/docs-rag"
cp "$root/AUTHORING.md" "$stage/docs-rag/references/authoring.md"

mkdir -p "$root/dist-skill"
rm -f "$root/dist-skill/docs-rag-skill.zip"
(cd "$stage" && zip -qr "$root/dist-skill/docs-rag-skill.zip" docs-rag)
echo "Wrote dist-skill/docs-rag-skill.zip"
