# Development and release

## Environment

- Node `^22.19.0 || >=24.0.0`
- `git` on `PATH` (the tests really create repositories and really stage in temporary directories)
- `pnpm` (only needed for `dsh plugin`; the tests need no dependencies at all, so `npm install` is not a required step)
- DSH `0.2.1-rc.2` or newer

## Development loop

```bash
# a symlink rather than a copy, so a restart picks up the change
dsh plugin --profile web add link:<absolute path of this repository>

dsh web
```

The bundle layer is read at startup only, so host changes need a `dsh web` restart; client chunks need the same restart (chunks are materialised in order at startup).

If the profile did not register the bundle automatically, add `"@yann9/dsh-git-workbench"` to `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json`.

For API-only work the plugin does not have to be installed at all:

```bash
node scripts/dev-server.js <repo path> 5178
# → http://127.0.0.1:5178/dsh-git/api/status
```

## Tests

```bash
npm test
```

137 cases, all against real git repositories, covering:

| File | Contents |
|---|---|
| `test/git-engine.test.js` | status v2 parsing, hunk / line staging and unstaging in reverse, renames, partial stash, rebase / reword plans, repository init |
| `test/http-api.test.js` | every endpoint, read-only 403, CSRF, `ignoreWhitespace`, committing by changelist, remote validation, console isolation |
| `test/client-pure.test.js` | pure functions (diff slicing, log filtering and grouping, label folding, i18n fallback) and stylesheet contracts (no leading `//`, balanced braces, `statusColor` uses ink tokens only) |
| `test/turn-and-message.test.js` | turn snapshots and the AI commit-message fallback chain |
| `test/release-notes.test.js` | release notes grouped by conventional prefix, breaking-change detection, comparison against the previous tag |
| `test/stage-release.test.js` | the staging script: skip an already published version, the staged tarball's file list, a prerelease going out under `next` |
| `test/docs-i18n.test.js` | the English and Chinese documents keep the same structure, and every relative link and anchor resolves |

Conventions:

- The tests touch only temporary directories or injected fixtures — **never the DSH data directory a developer uses day to day**.
- A case that needs to create destructive state backs it up and restores it itself, and checks `git status` and the stash list at the end instead of trusting the exit code.
- It has to run on Windows and Linux both: never assume a path separator, a line ending or drive-letter case.

## Screenshot conventions

The images in the docs come from a real DSH instance (an isolated data directory — never point it at the `~/.dsh` you use day to day):

- Viewport **1600 × 900**, `deviceScaleFactor: 2`; the right-hand workbench panel is pinned at **about 360 px** (drag the right sidebar's `col-resize` splitter; the script drags it explicitly every run), leaving the conversation column on the left. Diff and conflict need the whole main area (collapse the right sidebar), otherwise they fall back to the unified view.
- One **light** shot per surface, named `docs/assets/<surface>.png`:
  `commit-pane`, `diff`, `history`, `conflict`, `stash-dialog`. The plugin follows the host theme, so there is no separate dark set.
- A second set for the English UI, with `-en` in the file name: `docs/assets/<surface>-en.png`.
  Switch the host language in **Settings (Ctrl+Alt+,) → General → Language**; switch back to Chinese when done.
- Keep a real conversation in the main area (not the blank start page), and let a real account generate the commit message; the stash dialog, diff and conflict reuse the same conversation so no large empty area shows.
- Crop the browser chrome only, never the interface; no real path, branch name or commit message from the user's repository — use a demo repository.
- Key interaction states (a read-only badge, a conflict count, a network operation in progress) deserve their own shot, but do not build collages or annotations for them.

## Release: one tag ships everything

The version number has to agree in three places: `package.json`'s `version`, the `CHANGELOG.md` heading, and the git tag.

```bash
git add -A && git commit -m "feat: …"     # conventional messages; release notes group by them
git tag v0.1.0
git push origin main --tags               # the tag creates the GitHub Release and stages the tarball on npm
```

`.github/workflows/release.yml` takes over, in this order:

1. **Release gate**: the same four-matrix test run as CI (Ubuntu / Windows × Node 22 / 24); nothing continues until it is green.
2. **GitHub Release**: `scripts/release-notes.js` generates the notes and `gh release create` publishes them (a re-run on the same tag does `release edit`; a tag with a `-rc.N`-style suffix is marked prerelease automatically).
3. **npm staging**: `scripts/stage-release.js` runs `npm stage publish --provenance --access public` and pushes the tarball into npm's staging queue. **Staged is not published**: the package sits on npm, but nobody can install it until the maintainer approves it with 2FA. A prerelease gets `--tag next` automatically and does not take the stable `latest`; a version already on npm skips staging.
4. **Verify the staged tarball**: from the file list npm reports for the actual pack, the script checks that `cordis.patch.yml`, `src/index.js`, the seven client chunks, both locales and `assets/icon.png` are in the package, and that `docs/internal/` is not — anything DSH needs to resolve the bundle being missing is a release failure, and the script exits non-zero.
5. **Manual approval**: the workflow writes the stage id into the job summary, and the maintainer runs `npm stage approve <stage-id>` in their own terminal (the 2FA prompt stays in that terminal; never paste it into a chat or a ticket).

**No npm token lives in the repository**: publishing uses npm's Trusted Publishing (OIDC). The GitHub Actions run identity *is* the publishing credential, and npm recognises it by which repository and which workflow file. The binding is a one-off manual step that only the npm website can do (no script can):

1. Open the package's **Settings → Publishing access → Trusted Publisher** (`https://www.npmjs.com/settings/yann9/packages/dsh-git-workbench/access`).
2. Fill in GitHub Actions: Repository owner `yann9`, Repository name `dsh-git-workbench`, Workflow filename `release.yml` (**the file name only, not the `.github/workflows/` path**), Environment left blank (the workflow declares none).
3. **Tick the permission for `npm stage publish`**: Trusted Publisher has two unrelated permissions — staging (`createStagedPackage`) and direct publishing (`createPackage`), the two checkboxes on the npm site. This repository stages and never publishes directly, so **staging alone** is enough; conversely, direct-publish permission with no approval step means walking around 2FA. When the permissions do not match, staging fails with `403 … OIDC permission denied for this action`.
4. An unverified new binding expires after 48 hours, so either push a tag right after binding so it stages once, or bind again next time.

The CLI can configure it too (2FA required): `npm trust github @yann9/dsh-git-workbench --file release.yml --repo yann9/dsh-git-workbench --allow-stage-publish --registry=https://registry.npmjs.org/`; a package holds one binding at a time, so to change it, `npm trust list` for the id first and then `npm trust revoke --id=<id>`. Switching from "publish only" to "stage only" is exactly that: revoke the old one, then create a new one with the command above.

Two more things: the workflow's `id-token: write` permission is where the credential comes from — remove it and no publishing identity can be obtained; and the npm CLI doing the publishing must be **≥ 11.16** (the `npm stage` subcommand has existed since 11.15), which is why the release job pins Node 24 (Node 22's bundled npm is too old, and the script has an explicit check that errors out). The publishing event is `push: tags` only — never `pull_request_target`, which is a known attack surface.

A short-lived OIDC token in CI can run `npm stage publish` / `npm publish` and **cannot run `npm stage list` / `view` / `download`**. So verification looks only at the file list npm emits while packing, and the staged tarball itself is downloaded by hand in a local terminal:

```bash
npm stage download <stage-id> --registry=https://registry.npmjs.org/
```

To cut a package before the first binding exists, take the manual publish (OTP) route below and add the binding afterwards.

Two lines to check before shipping: the copyright line in `LICENSE` (currently `dsh-git-workbench contributors`), and that `package.json`'s `repository` / `homepage` / `bugs` / `author` are the real account details. `docs/internal/` is in `.gitignore`, so the design journal never gets pushed.

`scripts/` is not in `files`, so the release scripts never enter the package.

### How release notes are grouped

- Take `git log --no-merges <previous tag>..<this tag>` and group by conventional prefix into Features / Bug fixes / Performance / Refactoring / Documentation / Style / Tests / Build / CI / Reverts / Chores; anything without a prefix goes to Other changes.
- A prefix with `!` or a body containing `BREAKING CHANGE:` is additionally listed under Breaking changes.
- Release housekeeping commits such as `chore(release): …` filter themselves out and do not appear in the notes.
- The matching section of `CHANGELOG.md` becomes the opening prose (the human summary first, the commit list as the audit trail); when there is no section, only the commits are listed.
- Preview locally:

```bash
node scripts/release-notes.js --tag v0.1.0 --output /tmp/notes.md
node scripts/release-notes.js --tag v0.1.0 --no-changelog   # the commit list only
```

## Publishing to npm by hand

The package name is `@yann9/dsh-git-workbench`. The unscoped `dsh-git-workbench` is taken on npm by another project (`0.3.4`, a different maintainer), so the scope was there from the start.

The package name appears in three places and they must change together, otherwise the bundle cannot be found at startup:

- `package.json`'s `name`;
- `name:` in `cordis.patch.yml` (DSH resolves the module by it);
- the client chunks' `id` and `require('<package name>/client.*.js')`, plus the bundle key asserted in `test/client-pure.test.js`.

Installed profiles need syncing too: the `node_modules/@<scope>/<package>` directory, the dependency key in `package.json`, and the `dsh.profile.bundles` entry.

The checklist for publishing without CI (staging by default, matching the pipeline):

```bash
npm test
npm pack --dry-run        # inspect the payload: src / locale / cordis.patch.yml / docs (with assets) / README
npm stage publish --access public
npm stage list            # find the stage id just created
npm stage approve <stage-id>
```

`npm stage publish` itself needs no 2FA; `npm stage approve` / `npm stage reject` do — the prompt is in your local terminal, so never paste the OTP into a chat. Only when a direct one-step publish really is wanted, use `npm publish --access public` (no staging record, and therefore no approval step).

A manual publish must **not** pass `--provenance`: provenance can only be generated by CI, and locally it fails with `EUSAGE Automatic provenance generation not supported for provider: null`. For provenance, use the tag pipeline above.

`publishConfig.registry` pins the official `registry.npmjs.org`: a local default may have been switched to a mirror (npmmirror and friends are read-only), and without that line `npm publish` would hit the mirror and fail. Logging in has to point at the official registry too — a mirror's token does not work there:

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

The `npm stage` subcommands likewise have to point at the official registry — a mirror does not implement the `/-/stage` endpoints, so `approve` needs `--registry=https://registry.npmjs.org/` to hit anything.

`package.json`'s `files` is limited to `src`, `locale/*.json`, `cordis.patch.yml`, `README.md`, `README.zh.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `CONTRIBUTING.zh.md`, `SECURITY.md`, `SECURITY.zh.md`, `docs/*.md` and `docs/assets`; `package.json` and `LICENSE` are included by npm automatically. `docs/internal/` is both in `.gitignore` and outside `files`, so it never ships (`scripts/stage-release.js` checks again). `npm login` first (the project has no `.npmrc` or token), and verify from a clean profile afterwards:

```bash
dsh plugin --profile web add @yann9/dsh-git-workbench
dsh web
```

## Before a PR

- `npm test` is green.
- For host changes: `node --check` every touched file; confirm no shell call was introduced (every git call goes through `exec.js`).
- For UI changes: add the Chinese and English strings together; look at both light and dark; a narrow column (panel ~440 px) must not produce a horizontal scrollbar.
- For docs: the README keeps only the skeleton, detail goes into `docs/`; never write absolute paths from your machine.
