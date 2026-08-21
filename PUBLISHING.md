# Publishing Ridgeline

This is the release flow for `joplin-plugin-ridgeline`. It **mirrors the pipeline of
[joplin-plugin-cockpit](https://github.com/pmslava/joplin-plugin-cockpit)** — same two-workflow shape,
same npm trusted-publishing (OIDC) setup, same "E2E is excluded from the publish gate" decision. If you
have released Cockpit, none of this will be new.

Ridgeline ships to the Joplin plugin catalogue the same way every Joplin plugin does: it is published
to **npm** as a package that carries the built `.jpl`, and the Joplin plugin repository harvests npm for
packages keyed with the `joplin-plugin` keyword. There is no separate submission step.

The whole release is driven by a GitHub Release: publishing the release fires `publish.yml`, which
publishes to npm via **trusted publishing (OIDC)**. **You never run `npm publish` by hand** — see
[The publish is automatic](#the-publish-is-automatic-never-npm-publish-by-hand) below.

## The short version

1. Bump the version in **all four places** (see [Version bump](#version-bump)) and commit.
2. Prove the gates in order: **local fast gate (harness) green → local E2E green → push `main` → the
   GitHub Tests workflow green on that exact pushed SHA**. Do not cut the release until that SHA is
   green.
3. `npm run dist` (after the final commit) and cut the release:
   `gh release create vX.Y.Z publish/io.github.pmslava.ridgeline.jpl --repo pmslava/joplin-plugin-ridgeline --target main --title vX.Y.Z --notes "…"`.
4. The release event triggers `publish.yml`, which publishes to npm via OIDC trusted publishing. Verify
   with `npm view joplin-plugin-ridgeline version`.
5. The Joplin catalogue refreshes on its own schedule (hours to about a day). A stale plugin page is
   not a failed release.
6. Afterward, append the release record to the project note and delete merged branches/worktrees in one
   pass.

## Version bump

The version lives in **four** places, and a harness check (in CI, below) fails the build unless all four
agree:

- `package.json` `"version"` — the npm package version.
- `src/manifest.json` `"version"` — the version baked into the built `.jpl`.
- `package-lock.json` top-level `.version`.
- `package-lock.json` `.packages[""].version` (the root-package entry).

Bump the first two with the generator-joplin helper:

```
npm run updateVersion
```

> **`npm run updateVersion` only touches `package.json` and `src/manifest.json`.** It does **not** update
> `package-lock.json`, so the lockfile's two version fields drift silently. **Every bump must be followed
> by refreshing the lockfile** so all four stay equal:
>
> ```
> npm install --package-lock-only     # rewrites package-lock.json's .version + .packages[""].version
> ```
>
> (Or edit the two `package-lock.json` version fields by hand.) The CI harness below will fail the build
> if you forget.

On an actual release, `publish.yml` also derives the version from the git tag and rewrites
`package.json` + `src/manifest.json` in CI, so the tag is the source of truth for those two — but keep
the committed files (all four) in step so a plain `main` build already reflects the intended version and
the harness check passes.

Note that `src/manifest.json` carries a `screenshots` array. `npm run dist` runs webpack's
`validateScreenshots`, which rejects any screenshot that is not a `png`/`jpg`/`jpeg`/`gif`/`webp` or is
larger than **1024 KB** — so if you regenerate the images (see the README), keep them under that cap or
the build (and therefore the publish) will fail loudly.

## The gates, in order

Prove these **in this order** before cutting a release. Do not skip ahead — the point is that the exact
commit you release has already passed every gate.

1. **Local fast gate (the harness) — green.** Ridgeline has no unit-harness layer, so the "harness" is
   the fast type-check-and-build plus the four-place version check:

   ```
   npx tsc --noEmit
   npm run dist          # must emit publish/io.github.pmslava.ridgeline.jpl
   ```

   The version-consistency check runs automatically in CI's fast gate (it fails the build unless
   `package.json` == `src/manifest.json` == `package-lock.json .version` == `package-lock.json
   .packages[""].version`). Run `npm ci` locally if you want to reproduce it before pushing.

2. **Local E2E — green.** Run the full real-app Playwright suite locally (see the README for the
   four-shard command). This is the real-app coverage that the publish gate deliberately does not run.

3. **Push `main`.**

   ```
   git push origin main
   ```

4. **The GitHub Tests workflow — green on that exact pushed SHA.** Watch `tests.yml` in the Actions tab
   and confirm it is green **on the commit you just pushed** — both the fast gate **and** the real-app
   E2E job. Only once that specific SHA is green do you cut the release.

## Releasing

Once the pushed SHA is green (all gates above), build the artifact **after the final commit** and cut the
release:

```
# Build the artifact from the exact commit you are releasing.
npm run dist

# Cut the release. This is what triggers publish.yml.
gh release create vX.Y.Z publish/io.github.pmslava.ridgeline.jpl \
  --repo pmslava/joplin-plugin-ridgeline \
  --target main \
  --title vX.Y.Z \
  --notes "…"
```

- Always pass **`--repo pmslava/joplin-plugin-ridgeline`** so you never accidentally cut the release
  against the wrong repository.
- **`--target main`** pins the tag to the tip of `main` (the SHA you just proved green).
- Attach the freshly built **`publish/io.github.pmslava.ridgeline.jpl`** so it is downloadable from the
  releases page immediately. (The publish workflow's `attach-jpl` job also uploads it automatically,
  with `--clobber`, as a safety net — so a bare `gh release create vX.Y.Z --repo … --target main` with no
  asset still ends up with the `.jpl` once CI finishes.)
- **Verify any number you cite in `--notes`** (version, counts, dates) against reality before publishing
  the release — the notes are the public changelog.

## The publish is automatic (never `npm publish` by hand)

Publishing the release fires `publish.yml`, whose **publish** job resolves the version from the tag,
writes it into `package.json` + `src/manifest.json`, runs the fast gate (`tsc --noEmit` + `npm run dist`
+ the `.jpl` check), and then publishes to npm via **OIDC trusted publishing**.

**Never run `npm publish` manually.** There are **no npm tokens anywhere** — not in the repo, not in
GitHub secrets, not on any laptop — and it must stay that way. The release event is the only thing that
publishes; a manual publish would bypass provenance and the whole trusted-publishing model. If you ever
feel the urge to "just publish it by hand", the answer is to fix whatever made the release workflow fail,
not to reach for a token.

Watch `publish.yml` in the Actions tab; the **"Show the OIDC claims npm will present"** step prints
(never the token) the claims npm sends to the registry — if the publish ever fails with `ENEEDAUTH`,
compare those claims against the trusted-publisher configuration below.

**Verify the publish succeeded:**

```
npm view joplin-plugin-ridgeline version
```

It should report the version you just released. (The Joplin catalogue lags — see below — but npm is
authoritative and immediate.)

## What the two workflows do, and why E2E is not in the publish gate

- **`.github/workflows/tests.yml`** runs on every push and pull request. It has two jobs:
  - **build** — the *fast gate*: `npm ci`, the **four-place version check**, `tsc --noEmit`,
    `npm run dist`, and a check that the `.jpl` was actually produced. Ridgeline has no unit-harness
    layer, so this type-check-and-build (plus the version check) **is** the fast gate.
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
and the release-gate order above requires that exact SHA to be green there before you cut the release, so
the code being released has been through it. The publish gate only needs to prove the artifact
type-checks and builds. This matches Cockpit, where the real-app E2E is likewise kept off the publish
path.

## One-time: configure npm trusted publishing

Trusted publishing means there is **no `NPM_TOKEN` secret**. npm is told to trust this repository and
this workflow, and the job exchanges a short-lived GitHub OIDC token for publish rights. This is a
one-time setup on npmjs.com; it was configured (and each row below independently verified) when the
package was first created.

On **npmjs.com → the `joplin-plugin-ridgeline` package → Settings → Trusted publisher**, the
configuration is:

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

With this configured, releases publish with no secrets, and npm generates provenance attestations
automatically (that is why `--provenance` is not passed).

## The Joplin plugin catalogue pickup

The Joplin plugin repository scans npm for packages carrying the **`joplin-plugin`** keyword (present in
`package.json` `keywords`) and installs the `.jpl` from the published tarball. After a successful npm
publish, the new version does **not** appear in Joplin's in-app plugin search instantly — **the catalogue
refreshes on its own schedule**, so expect **a few hours to about a day** before "Ridgeline" shows the new
version in **Settings → Plugins**. (This is the same delay observed publishing `joplin-plugin-copy-note-id`
and Cockpit.) **A stale plugin page is not a failed release** — if `npm view joplin-plugin-ridgeline
version` shows the new version, the release worked; just wait for the catalogue to catch up.

## After the release

1. **Append the release record to the project note.** In the Joplin project note **"Joplin Ridgeline
   Plugin"**, record the released version, its date, and any new gotchas learned this cycle (so the next
   release starts from the current truth).
2. **Clean up branches and worktrees in one exhaustive pass.** Delete every branch and git worktree that
   was merged for this release — locally and on the remote — in a single sweep, so no stale
   `claude/*` branches or worktrees linger.

## Checklist

- [ ] All **four** version places match the intended `vX.Y.Z`: `package.json`, `src/manifest.json`,
      `package-lock.json .version`, `package-lock.json .packages[""].version` (refresh the lockfile after
      `npm run updateVersion`).
- [ ] `keywords` in `package.json` still include `joplin-plugin`.
- [ ] Screenshots referenced by `src/manifest.json` exist under `docs/images/` and are each ≤ 1024 KB.
- [ ] Gates passed **in order**: local fast gate (harness) → local E2E → pushed `main` → `tests.yml`
      green on that exact SHA (fast gate **and** real-app E2E).
- [ ] `npm run dist` run after the final commit; release cut with
      `gh release create … --repo pmslava/joplin-plugin-ridgeline --target main` and the `.jpl` attached.
- [ ] `publish.yml` succeeded; **no** manual `npm publish`.
- [ ] `npm view joplin-plugin-ridgeline version` shows the new version.
- [ ] Catalogue shows the new version (allow up to ~a day; a stale page is not a failed release).
- [ ] Release record appended to the "Joplin Ridgeline Plugin" note; merged branches/worktrees deleted
      in one pass.
