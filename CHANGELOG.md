# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.7 — 2026-10-29

### Added

- The branch popover's remote rows carry their own actions: create a local
  branch from one — it starts out tracking the remote branch, whatever
  `branch.autoSetupMerge` says — and delete the branch on the remote.
  Deleting asks first and names the branch, and a default branch is refused
  host-side.
- Deleting a local branch can take its remote branch with it: when the branch
  tracks a remote branch that is still listed, the confirm offers an unchecked
  "also delete the remote branch" box. The local branch goes first, so a
  failed `git push --delete` is reported without pretending the whole action
  did nothing.
- Every document has an English edition beside its Chinese one: README,
  CONTRIBUTING, SECURITY and the five manuals. A page that exists in one
  language only sends the other reader to text they cannot read, so the
  English manuals are translated section for section rather than summarised,
  and `test/docs-i18n.test.js` keeps heading levels, fences, tables, every
  relative link and anchor, and the language of each screenshot in step.

### Changed

- The screenshots follow the documents: the bare file name is the English UI
  and `<surface>.zh.png` is the Chinese one, in one directory rather than an
  `en/` and `zh/` split. The marketplace catalog lists bare names, so it now
  shows the English set it was always meant to show.

### Fixed

- Two quick clicks on commits in the history no longer leave the slower
  commit's detail on screen: each fetch is stamped and a stale answer is
  dropped, the way the list already worked.
- Creating a branch at a commit carried the uncommitted changes through
  without a word — it ends in a checkout, so it now asks first, the same
  question a plain branch switch asks.
- A git command that runs past its timeout is killed together with the
  processes it spawned (ssh, git-remote-https), so a stalled remote no longer
  holds the pane open.
- The read routes validate the revision they are given, so a value like
  `--output=owned.txt` is refused instead of reaching git as an option.
- A `.gitignore` line starting with `!` or `#` is escaped when the pane adds
  it, so asking to ignore a file named `!keep.txt` now does.
- One workspace whose folder has been deleted no longer fails the whole
  workspace list.
- The change feed closes with its last listener instead of asking for the
  repository revision every three seconds for the rest of the page's life,
  and the commit detail no longer serves a cached payload that was fetched
  before the repository changed.

## 0.1.6 — 2026-10-27

### Added

- The history table's columns can be resized. Drag the hairline on a column
  edge to give that column the width you want, double click the hairline to
  hand the column back to its default, and the widths stay in the browser so
  the table comes back the way you left it. The graph column opens far wider
  than the pane itself, which is what the bottom dock needs to show every lane
  of a wide graph. When the pane cannot hold what all the columns ask for, the
  column you touched last keeps the room and the others give way in
  proportion; a column that no longer fits is clamped instead of pushing the
  table into a horizontal scroll.
- The history table sorts by any column, and the graph is drawn in the history
  order (date, newest first) only — the graph states a parent-child relation
  that another order does not have. The filter row now offers a button that
  goes back to the history order, so a graph lost to a stray click on a
  header is one click away from coming back.

### Fixed

- A delivery card's Git button opens the diff of the turn the card was built
  from, inside the conversation. The card hands over the sequence of its own
  `deliverables/presented` event while `workspaceChanges.summary()` only
  answers for `workspace/changes` events, so the lookup came back empty and
  the button was sent to the commit pane instead, which shows the working tree
  rather than what the agent did.
- The diff view registers itself again when the host re-declares its slot.
  `slots.inject` disposes its effect and runs the callback a second time
  whenever the slot declaration collapses and comes back; the callback
  returned the disposer stored on the first run, and that disposer was already
  dead, so no tab was registered while the module believed the view was up.
  Every click that should open the diff was a silent no-op.
- The commit draft goes through the model DSH has selected. An official-account
  login registers several providers and the first one in the registry exposes
  no catalog, so taking the first provider ended in "provider
  deepseek-official has no model" while the chat pane worked fine. The plugin
  config still overrides the route field by field, and a missing sign-in is
  named instead of surfacing the raw provider error.
- The commit prompt names the output language. The rules implied the language
  only through their own wording, so the model answered in English under a
  Chinese UI whenever the diff itself was English.
- A pane has one name in both bars. The right sidebar's guide cards used
  Git-prefixed labels while the tab strip and the bottom workbench used the
  short ones, so the same pane had two names.
- The right-sidebar fallback for the diff view logs the branch it takes with
  the target's source, so a report of "it opened on the right and was empty"
  can be traced to that one line instead of guessing between the two surfaces.

### Changed

- The documentation screenshots no longer carry a `-light` suffix. They only
  ever show the light theme, so the suffix promised a second set that was
  never taken. They are shot on a signed-in session with a real exchange and a
  narrow right panel, and the capture conventions follow.

## 0.1.5 — 2026-10-27

### Fixed

- The work-tree watcher is attached before the git-dir probe instead of after
  it. For the tens of milliseconds `resolveGitDir` spent shelling out to git,
  the caller already held its disposer while no watch existed, so an edit made
  in another tool in that window never reached connected clients. The recursive
  work-tree watch needs no probe result, so it now goes on synchronously; the
  `.git` targets still wait for the resolved directory, and a dispose that
  lands mid-probe no longer leaves watchers behind.

## 0.1.4 — 2026-10-27

### Changed

- The plugin icon is drawn as a glyph instead of a filled square. The host's
  plugin list frames every entry in its own 50px rounded tile and shrinks the
  artwork to 36px, so the previous full-bleed plate arrived as a square inside
  a square while the official entries read as flat glyphs. `assets/icon.png` is
  regenerated transparent from the svg, with a stroke heavy enough to survive
  36px.

### Fixed

- The English README carries its own shortcut table instead of sending readers
  to the Chinese one, and both tables are now row-for-row identical. Checking
  each binding against the handlers turned up one wrong in both languages: only
  `ctrlKey` is read for the hunk revert, so `Cmd + Alt + R` never fired on a
  Mac — the docs say `Ctrl + Alt + R`, which is what the code does.

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
