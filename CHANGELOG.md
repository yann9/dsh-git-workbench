# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.3 — 2026-10-27

### Added

- The panes now appear in **dsh-better-sidebar's own tab bar** as well. That
  plugin enumerates only its own `registerTab` registry, so 提交 / 历史 / 控制台
  were invisible in its bottom workbench; they are offered to it through a soft
  service lookup (the plugin stays entirely optional) with `bottomOnly`, which
  keeps it from minting a competing native right-sidebar type.
- A marketplace icon (`assets/icon.png`, 512px, with the SVG source beside it),
  the `screenshots.json` list the curated catalog resolves from this repository,
  and `market/yann9__dsh-git-workbench.yml` — the entry to submit upstream.

### Fixed

- Every operation that writes a commit — merge, rebase, reword, cherry-pick,
  revert and their continue/resume paths — now preflights the author identity
  and offers to set it, instead of letting git fail in English.
- The remaining un-mapped git refusals (a branch with no upstream, a stale
  `index.lock`, a remote wanting credentials, a detached HEAD, a branch held by
  another worktree, squashing the first kept commit) answer in the UI language.
- A delivery card whose turn snapshot the host has dropped now says what went,
  why, and which click still shows the change, rather than failing the diff page.

### Removed

- The dark-theme screenshot set. The workbench follows the host theme and has no
  switch of its own, so those ten files documented nothing new.

## 0.1.2 — 2026-10-26

Documentation only; the plugin itself is unchanged.

### Added

- An English set of the screenshots (`docs/assets/*-en-*.png`): the commit pane,
  the diff view, the history tab, the conflict view and the stash dialog, in
  light and dark. The English README embeds them, the Chinese one keeps the
  Chinese set.

## 0.1.1 — 2026-10-26

Release infrastructure only; the plugin itself is unchanged.

### Fixed

- The Windows CI jobs are green again. The runners hand out `$TMP` in its 8.3
  form (`C:\Users\RUNNER~1\…`) while git reports the long name for the same
  folder, and Node cannot expand the short name — so the two assertions that
  mixed a fixture path with a host-resolved root now compare file identity.
- The release notes read the conventional commits correctly: a commit that
  only mentions "BREAKING CHANGE" in its prose is no longer listed as a
  breaking change, and the `chore(release):` commit no longer shows up in the
  notes at all.

### Changed

- The default README is the English one — npm's package page and the repository
  front page show it. The Chinese version moved to `README.zh.md` and stays one
  click away from the language line at the top.
- The release pipeline is safe to re-run: a tag whose version already landed on
  npm skips the publish instead of failing, and a prerelease tag is published
  under the `next` dist-tag instead of taking over `latest`.
- `docs/development.md` records that a manual publish cannot carry
  `--provenance` — only a CI run can mint it.

## 0.1.0 — 2026-10-26

First public release. The plugin has been used against real repositories throughout
development; everything below is implemented and covered by the test suite.

### Added

**Staging and committing**

- Local Changes tree with Staged / Unstaged / Unversioned / Conflicts groups; checkbox
  staging and batch stage/unstage.
- Hunk-level staging via cropped patches (`git apply --cached`), and line-level staging
  selected from the diff gutter.
- Changelists: named groups in the panel, "commit this changelist" through a temporary
  index so other changelists' staged content stays in the index.
- Commit window with AI draft, recent-message recall (`↑`/`↓`), amend, and
  before-commit checks discovered from the repository's `package.json` scripts.
- Undo commit (soft reset to the first parent, changes return to the index) and reword
  for HEAD or earlier commits.

**Diff and annotation**

- Side-by-side and unified diff with dual line numbers, word-level highlights,
  context folding, and a persisted view preference.
- Ignore-whitespace mode (`git diff -w`), deliberately read-only because `-w` hunk
  indices cannot be used to write back.
- Inline annotate (blame) grouped by commit, with sticky author and line-number columns
  and a clear "not committed" marker.
- Turn snapshots: diff what a single agent turn changed, read-only, reachable from turn
  cards and the review sidebar.

**History**

- DAG commit graph with swimlanes, refs, and HEAD labels.
- Sortable columns (message / author / date / hash) with per-column visibility toggles.
- Group commits by branch, author, or date; each group gets its own graph.
- Structured filters: `author:` `message:` `hash:` `tag:` `branch:` `date:` with quoted
  values, ranges, and removable filter chips.
- Multi-select with batch cherry-pick, revert, copy hash and copy message.
- Keyboard navigation, inline file history, and branch comparison.

**Branches, remotes and network**

- Branch switcher with create / rename / delete, ahead-behind badges, set and unset
  upstream, compare with the current branch, and rebase onto a chosen branch.
- Fetch, pull (merge or rebase), push including `--force-with-lease`; first push asks
  which remote to use and sets `-u <remote> HEAD`.
- Manage remotes: add, change URL, remove, with host-side validation.
- Interactive rebase (pick / squash / fixup / drop, reorder), with conflict pause,
  continue and abort.

**Conflicts, stash and tooling**

- Three-way conflict view with per-block ours/theirs/both, a hand-written merged
  result per block (Ctrl+Enter applies, Esc cancels), common-ancestor column, and
  folding of unchanged regions.
- Sequencer status bar for paused merge, cherry-pick and rebase, with continue/abort.
- Stash dialog with a message and file selection (partial stash via a temporary index),
  read-only preview, apply/pop/drop.
- One-click `git init` for directories that are not repositories.
- Git console listing every executed argv with exit code, duration and output, isolated
  per repository.
- Built-in English/Chinese UI that follows DSH's language preference and switches
  live; git's refusals are localized.
- 8 structured tools for the model, sharing the same service as the panel.
- `readOnly` mode that disables every write path in both the UI and the HTTP API.
