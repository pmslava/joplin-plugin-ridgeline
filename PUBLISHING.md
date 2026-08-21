# Publishing Ridgeline

This is the release flow for `joplin-plugin-ridgeline`. It **mirrors the pipeline of
[joplin-plugin-cockpit](https://github.com/pmslava/joplin-plugin-cockpit)** — same two-workflow shape,
same npm trusted-publishing (OIDC) setup, same "E2E is excluded from the publish gate" decision. If you
have released Cockpit, none of this will be new.

Ridgeline ships to the Joplin plugin catalogue the same way every Joplin plugin does: it is published
to **npm** as a package that carries the built `.jpl`, and the Joplin plugin repository harvests npm for
packages keyed with the `joplin-plugin` keyword. There is no separate submission step.

## The short version

1. Bump the version (`npm run updateVersion`, or edit `package.json` + `src/manifest.json` by hand — keep
   them equal).
2. Commit, and push to `main`.
3. Create a **GitHub Release** with a tag `vX.Y.Z` (matching the version).
4. The `publish.yml` workflow runs on the release, gates on the fast type-check-and-build job, and
   publishes to npm via trusted publishing.
5. Within a few hours to about a day, the Joplin plugin catalogue picks the new version up.

The first ever publish needs a one-time trusted-publisher configuration on npmjs.com (below), or you can
do that first release by hand with `npm publish` and your YubiKey.

## What the two workflows do, and why E2E is not in the publish gate

- **`.github/workflows/tests.yml`** runs on every push and pull request. It has two jobs:
  - **build** — the *fast gate*: `npm ci`, `tsc --noEmit`, `npm run dist`, and a check that the `.jpl`
    was actually produced. Ridgeline has no unit-harness layer, so this type-check-and-build **is** the
    fast gate.
  - **e2e** — the *real-app suite*: launches the actual Joplin desktop (Electron) under Xvfb with the
    plugin loaded and drives it with Playwright. It caches the Joplin AppImage keyed on
    `JOPLIN_E2E_VERSION` and uploads its report/traces on failure.

- **`.github/workflows/publish.yml`** runs on a published GitHub Release (or manually via
  `workflow_dispatch`). Its **publish** job resolves the version from the tag, writes it into both
  `package.json` and `src/manifest.json`, runs the **fast gate only** (`tsc --noEmit` + `npm run dist`
  + the `.jpl` check), and then publishes to npm. On a real Release it also runs a second **attach-jpl**
  job that rebuilds the plugin and uploads `publish/io.github.pmslava.ridgeline.jpl` to the release as a
  downloadable asset (so the README's "download it from the releases page" path works even if you cut the
  release with a bare `gh release create` and no asset). That job carries its own minimal
  `contents: write` scope, keeping the npm-publish job at `contents: read`.

**Why E2E is deliberately excluded from the publish gate:** the E2E job downloads a ~150 MB Joplin build
and launches it many times — minutes of work that would make every release slow and flaky for no added
safety at publish time. The real-app suite already runs on every push and pull request via `tests.yml`,
so the code being released has been through it. The publish gate only needs to prove the artifact
type-checks and builds. This matches Cockpit, where the real-app E2E is likewise kept off the publish
path.

## Version bump

The version lives in two files that must stay equal:

- `package.json` `"version"` — the npm package version.
- `src/manifest.json` `"version"` — the version baked into the built `.jpl`.

Bump them with the generator-joplin helper:

```
npm run updateVersion
```

or edit both by hand. On an actual release, `publish.yml` also derives the version from the git tag and
rewrites both files in CI, so the tag is the source of truth — but keep the committed files in step so a
plain `main` build already reflects the intended version.

Note that `src/manifest.json` now carries a `screenshots` array. `npm run dist` runs webpack's
`validateScreenshots`, which rejects any screenshot that is not a `png`/`jpg`/`jpeg`/`gif`/`webp` or is
larger than **1024 KB** — so if you regenerate the images (see the README), keep them under that cap or
the build (and therefore the publish) will fail loudly.

## Releasing

```
# 1. bump + commit
npm run updateVersion
git add package.json src/manifest.json
git commit -m "Bump to vX.Y.Z"
git push origin main

# 2. cut the release (this is what triggers publish.yml)
#    Attach the freshly built .jpl so it is downloadable from the releases page immediately.
#    (The publish workflow's attach-jpl job also uploads it automatically, with --clobber, as a
#    safety net — so a bare `gh release create vX.Y.Z --title "vX.Y.Z" --notes "…"` still ends up
#    with the asset once CI finishes.)
npm run dist
gh release create vX.Y.Z publish/io.github.pmslava.ridgeline.jpl --title "vX.Y.Z" --notes "…"
```

Publishing a release fires `publish.yml`. Watch it in the Actions tab; the **"Show the OIDC claims npm
will present"** step prints (never the token) the claims npm sends to the registry — if the publish ever
fails with `ENEEDAUTH`, compare those claims against the trusted-publisher configuration.

Do **not** create the release before the trusted publisher is configured (below), or the first publish
will fail authentication.

## One-time: configure npm trusted publishing

Trusted publishing means there is **no `NPM_TOKEN` secret**. npm is told to trust this repository and
this workflow, and the job exchanges a short-lived GitHub OIDC token for publish rights. Before the very
first automated publish, the package must exist on npm and have a trusted publisher configured. Because a
trusted publisher can only be attached to a package that already exists, the first release is a
chicken-and-egg: do the **manual first publish** below once, then configure the trusted publisher for all
later releases.

On **npmjs.com → the `joplin-plugin-ridgeline` package → Settings → Trusted publisher**, add:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Owner | `pmslava` |
| Repository | `joplin-plugin-ridgeline` |
| Workflow | `publish.yml` |
| Environment | `npm` |
| Allowed actions | `npm publish` |

The **Environment** name must match on both sides. GitHub only adds an `environment` claim to the OIDC
token when the job declares `environment:` — `publish.yml` declares `environment: npm`, so npm must be
told to expect `npm`. If they disagree, npm falls back to token auth and the publish fails with
`ENEEDAUTH`.

Once configured, later releases publish with no secrets, and npm generates provenance attestations
automatically (that is why `--provenance` is not passed).

## The manual first publish (YubiKey)

For the very first release — or any time you would rather publish by hand — build and publish locally.
This is how the package gets created so a trusted publisher can then be attached to it.

```
npm ci
npm run dist          # produces publish/io.github.pmslava.ridgeline.jpl and validates screenshots
npm publish           # access is already "public" via publishConfig
```

`npm publish` will prompt for your npm one-time password; approve it with your **YubiKey** (this is how
pmslava's npm publishes are authenticated). After this first publish succeeds, configure the trusted
publisher above so subsequent releases go through CI without a manual step.

## The Joplin plugin catalogue pickup

The Joplin plugin repository scans npm for packages carrying the **`joplin-plugin`** keyword (present in
`package.json` `keywords`) and installs the `.jpl` from the published tarball. After a successful npm
publish, the new version does **not** appear in Joplin's in-app plugin search instantly — the catalogue
refreshes on its own schedule, so expect **a few hours to about a day** before "Ridgeline" shows the new
version in **Settings → Plugins**. (This is the same delay observed publishing `joplin-plugin-copy-note-id`
and Cockpit.) Nothing extra is needed; just wait for the catalogue to catch up.

## Checklist

- [ ] `package.json` and `src/manifest.json` versions match the intended `vX.Y.Z`.
- [ ] `keywords` in `package.json` still include `joplin-plugin`.
- [ ] Screenshots referenced by `src/manifest.json` exist under `docs/images/` and are each ≤ 1024 KB.
- [ ] `tests.yml` is green on `main` (fast gate **and** the real-app E2E).
- [ ] Trusted publisher is configured on npmjs.com (first automated release only).
- [ ] Release tag created → `publish.yml` succeeded.
- [ ] Catalogue shows the new version (allow up to ~a day).
