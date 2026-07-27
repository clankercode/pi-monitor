set shell := ["bash", "-cu"]

install:
    pnpm install

test:
    pnpm test

typecheck:
    pnpm run typecheck

check:
    pnpm run check

ci: check

# Cut a release: gate, bump package.json, commit, tag, and push.
# Pushing the vX.Y.Z tag triggers .github/workflows/release.yml.
# VERSION is an explicit semver (e.g. 0.2.0) or patch|minor|major.
release VERSION:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "working tree is not clean — commit or stash first" >&2
        exit 1
    fi
    branch="$(git rev-parse --abbrev-ref HEAD)"
    if [ "$branch" != "master" ]; then
        echo "releases are cut from master, not '$branch'" >&2
        exit 1
    fi
    just ci
    tag="$(pnpm version "{{VERSION}}" -m "chore: release %s")"
    git push origin master
    git push origin "$tag"
    echo "Pushed $tag — CI will publish to npm and create the GitHub Release."
