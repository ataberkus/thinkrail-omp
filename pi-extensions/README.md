# Publishing omp packages

How-to for the packages under `pi-extensions/*`, published to npm as `@thinkrail/pi-<name>` and usable
in vanilla `omp` (oh-my-pi) without ThinkRail. Decisions and rationale live in [SPEC.md](SPEC.md); this file is the
checklist.

## Add a new package

1. Create `pi-extensions/<name>/` **beside** its predecessor (if one exists under `packages/`); never
   modify or delete the old package in the same PR — the wiring PR does that later.
2. `package.json`: copy `visualize/package.json` and adjust. Non-negotiables:
   - `name: "@thinkrail/pi-<name>"`, `version: "0.0.0"` (the first changeset produces the first
     real version), `private` absent, `license: "Apache-2.0"`, `repository.directory`,
     `publishConfig: { access: "public", provenance: true }`.
   - `keywords` include `"pi-package"` and `"oh-my-pi"`, and an `omp` manifest (`extensions`) **only** for
     an installable extension; skills ship in a `skills/` directory, which omp discovers without a
     manifest key. A portable library (no factory) gets neither.
   - `files`: everything the entrypoints and `exports` transitively import, tests excluded. The parity
     gate installs from the tarball, so an omission fails there.
   - omp SDK packages (`@oh-my-pi/pi-ai`, `pi-coding-agent`, `pi-tui`, `pi-agent-core`) are
     `peerDependencies: "*"` and `devDependencies: "catalog:"`. Tool schemas use omp's `z` builder, not
     TypeBox. Other runtime deps: exact pins.
3. Copy `LICENSE` from the repo root. Write a `README.md` whose first lines are
   `omp plugin install @thinkrail/pi-<name>` and what the package adds.
4. Create `SPEC.md` (`parent: module-pi-extensions`) and add the package to the members table in
   [SPEC.md](SPEC.md).
5. Register the package in `scripts/check-module-boundaries.ts` (`{ root: "pi-extensions/<name>", allowed: [] }`
   or the sibling it depends on) and in the fixture of `scripts/checkModuleBoundaries.test.ts`.
6. Add its expectations to `EXPECTATIONS` in `scripts/check-pi-packages.ts`: tool names, skill names, and
   a few executable cases (valid call, rejected call, one TUI render). Tools that register inside
   `session_start` need the session-bound mode — add it with the first such package.
7. Run `bun install`, then the bar below.

## The vanilla-parity bar (before the first publish)

- `bun run check:pi-packages` is green. It packs the package, installs it with the real
  `omp plugin install` into an isolated fixture **outside the repo** (tarballs served from a loopback
  registry), and loads it through omp's own discovery. Missing `files` and a wrong `omp.extensions`
  entry fail here.
- Shipped code imports the engine only through `@oh-my-pi/*` public entries: no `@earendil-works/*`,
  `@mariozechner/*`, `typebox`, or `extensibility/legacy-pi-*`. omp would silently shim those, so only
  the gate's tarball scan catches them. Bun APIs are fine, because omp only runs on Bun.
- Every tool sets `loadMode: "essential"`; omp otherwise hides extension tools behind tool search.
- Every tool whose plain text result reads poorly has `renderCall`/`renderResult`; every UI call is behind
  `ctx.hasUI`.
- Manual check in a real terminal, including inside `tmux`:
  ```bash
  node_modules/.bin/omp -e pi-extensions/<name>/index.ts
  ```
- No `~/.thinkrail` paths, no host wire, no `@thinkrail/*` imports except sibling `pi-extensions/*`.

## Release a version

1. **In the PR that changes a published package**, add a changeset:
   ```bash
   bun changeset            # pick the package(s), bump type, one-paragraph summary
   ```
   Commit the generated `.changeset/<name>.md` with the change. Dependents (`subagents` → `delegation`)
   are bumped automatically when their dependency releases.
2. **To cut the release**, a maintainer on a fresh branch runs
   ```bash
   GITHUB_TOKEN="$(gh auth token)" bun run release:version  # changeset version + bun install (lockfile)
   ```
   (the GitHub changelog generator needs a token to look up PR/author links; it does not read `gh`'s
   credentials by itself)
   and opens an ordinary PR `chore(release): version pi packages`. It carries the version bumps and
   `CHANGELOG.md` entries and consumes the changeset files. Normal CI runs on it.
3. **On merge to `main`**, `.github/workflows/release-pi-packages.yml` re-runs the parity gate, publishes
   every package whose version is not on npm yet (dependencies first), and pushes `name@version` tags
   once every current version is on npm — including versions that were published manually (bootstrap)
   and tags missed by an earlier failed push. The job runs in the `npm-release` GitHub environment with
   OIDC — there are no npm tokens anywhere. While any changeset is still pending the job exits early
   with "nothing to publish" and tags nothing.

`bun run release:publish -- --dry-run` shows locally what the workflow would publish.

## First publish of a new package (one-time bootstrap)

npm Trusted Publishing can only be configured on a package that already exists, so the very first
version is published by a human who owns the `thinkrail` npm org:

```bash
bun run release:pack <dir>                      # e.g. visualize → dist/pi-packages/<name>-<version>.tgz
npm login                                       # org owner, 2FA
npm publish dist/pi-packages/<tarball> --access public --provenance=false
```

`--provenance=false` is required for this one manual publish: the manifest's `publishConfig` asks for
provenance, which only a CI provider can generate. The automated release keeps provenance.

Then, on npmjs.com → the package → **Settings → Trusted Publisher → GitHub Actions**:

| field | value |
| --- | --- |
| Organization / user | `JetBrains` |
| Repository | `thinkrail` |
| Workflow filename | `release-pi-packages.yml` |
| Environment | `npm-release` |

After the first successful OIDC publish, set the package's publishing access to *Require two-factor
authentication and disallow tokens*.

## Troubleshooting

- **`check:pi-packages` fails with a module not found inside the fixture** — a runtime import is not in
  `dependencies`, or a file is missing from `files`.
- **"imports a legacy pi engine module"**: switch the import to the `@oh-my-pi/*` equivalent (schemas
  use omp's `z`, not TypeBox).
- **`omp plugin install … extension validation failed`**: an `omp.extensions` entry is missing from the
  tarball or does not default-export a factory.
- **"bound to a plugin-local omp copy"**: an engine import bypassed omp's host remapping and resolved to
  the `*` peer bun installed beside the plugin. Import a public `@oh-my-pi/*` entry instead.
- **Publish job skipped everything** — the versions on `main` are already on npm (nothing to do) or
  changesets are still pending (cut the version PR first).
- **Publish fails with `ENEEDAUTH`/403** — Trusted Publisher is not configured for that package yet (see
  bootstrap) or the workflow/environment names do not match the npm configuration exactly.
