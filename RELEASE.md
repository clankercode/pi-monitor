# Release process

Releases are automated by CI. Pushing a `vX.Y.Z` tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which:

1. re-runs the full gate (`pnpm run typecheck` + `pnpm test`);
2. verifies the tag matches `package.json`'s `version`;
3. publishes to npm via **OIDC trusted publishing** (no `NPM_TOKEN` secret;
   build provenance is attached automatically);
4. creates a GitHub Release with auto-generated notes.

Every push to `master` and every PR also runs the gate via
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Cutting a release

From a clean `master`:

```bash
just release 0.2.0      # explicit version
# or: just release patch | minor | major
```

`just release` runs the gate, bumps `package.json`, commits
`chore: release X.Y.Z`, tags `vX.Y.Z`, and pushes commit + tag. CI does the
rest — watch **Actions**.

Equivalent by hand:

```bash
pnpm run check
pnpm version 0.2.0 -m "chore: release %s"
git push origin master
git push origin v0.2.0
```

## First publish (manual)

The package does not exist on npm yet. Create it once from a clean tree
that already passes the gate (package name
`@clanker-code/pi-monitor`, version `0.1.0`):

```bash
pnpm run check
npm publish --access public
git tag v0.1.0
git push origin master
git push origin v0.1.0
```

Then create a GitHub Release for `v0.1.0` (or let a later tag-driven run
create one). After this, configure trusted publishing (below) so future
tags publish from CI.

## One-time setup: npm trusted publisher

Trusted publishing must be configured once on npm so the registry trusts this
repo's release workflow (no token needed):

1. Open <https://www.npmjs.com/package/@clanker-code/pi-monitor/access>
   (Settings → Trusted Publishing).
2. Add a **GitHub Actions** publisher:
   - Organization/user: `clankercode`
   - Repository: `pi-monitor`
   - Workflow filename: `release.yml`
   - Environment: *(leave blank)*

After that, the next `vX.Y.Z` tag publishes automatically.

## Notes

- The tag name must equal the `package.json` version (`v0.1.0` ↔ `0.1.0`); CI
  fails the release if they disagree.
- This is a source-only package (`files: ["extensions", "src", ...]`) — there
  is no build step; `npm publish` ships the TypeScript sources that pi runs
  via `tsx`.
- Scoped package: `publishConfig.access` is `public` so the package is
  publicly installable.
- If a publish fails because the version already exists on npm, bump to a new
  version and tag again.
