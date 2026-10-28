# Architecture

```
src/
├── index.js              host entry: registers routes, slots, deferred tools
├── git/
│   ├── exec.js           every git call: argv array, no shell, fixed locale, console log
│   ├── repo.js           status(v2) / log / branches / blame / remotes parsing
│   ├── diff.js           unified diff → hunk model with both line numbers
│   ├── patch.js          selection → trimmed patch → apply --cached
│   ├── turns.js          per-turn snapshot (ctx.workspaceChanges → FileDiff)
│   ├── workspaces.js     DSH workspace registry → the repositories we can open
│   ├── revision.js       repository revision token (HEAD + index/refs)
│   ├── checks.js         package.json script discovery and non-interactive runs
│   ├── conflict.js       conflict segmentation, block-by-block resolution
│   ├── rebase-editor.js  the todo rewriter behind GIT_SEQUENCE_EDITOR
│   ├── reword-editor.js  the message rewriter behind GIT_EDITOR
│   └── service.js        the only state-changing entry, serializing writes
├── llm/commit-message.js commit-message drafting (ctx.llm → local rules on failure)
├── http/routes.js        /dsh-git prefix routes: JSON API + SSE stream
├── tools.js              the 8 structured tools for the model
├── tools-boot.js         deferred tool dependencies (a missing dsh-tools leaves the UI working)
└── client/
    ├── browser.js        browser entry: materialise chunks in dependency order, register slots
    ├── client.i18n.js    strings and error localization
    ├── client.styles.js  design-token stylesheet (injected once, all of it under .gwb)
    ├── client.core.js    API · stores · hooks · shared git actions
    ├── client.ui.js      atoms + menus / popovers / confirmations
    ├── client.shell.js   session-header chip · branch menu · settings form
    ├── client.panes.js   CommitPane · LogPane
    └── client.diff.js    DiffView (lazy-loaded the first time it opens)
```

Both host and client are plain ESM that runs as-is, **with no build step**: `dsh plugin add link:<dir>` points at the directory, and a restart picks up the change — no tsdown, no built artifact to keep in sync with the source.

## What each layer owns

**host** owns the single source of truth: every git call, every write, every parse. It exposes only `/dsh-git/api` ([see api.md](api.md)) and the 8 model tools, and both go through the same `GitService` layer.

**client** only presents and handles gestures: it `fetch`es the API and keeps local view state (selections, scroll, filters, drafts, changelists). It never touches git and stores no repository facts.

That boundary buys two things:

1. **The Agent and the panel agree.** After the model calls `git_stage`, the panel's next refresh shows a result computed by the same rules.
2. **The UI is replaceable.** The interface can be redone (this project rebuilt it once, out of an iframe) without moving the API contract.

## Why the client is split into these chunks

The first version packed all three panes into one file and switched between them with `mode`/`view`/`pane` combinations. The result was one function serving both "the writable worktree diff" and "the read-only history diff", and breaking any branch of it broke three places.

The boundaries now are:

- **commit** is the only component that knows the words "stage" and "commit";
- **log** never touches the index: it reads commits and switches/creates branches, with no stage/commit calls at all;
- **diff** has its writability decided once, at load, by `source`: on the read-only path the selection, the hunk actions and the stage buttons simply do not exist in the render tree.

Adding a fourth pane (say, the conflict editor as a page of its own) = one more chunk + one more slot registration, with no existing component touched.

## Why native components instead of an iframe

The first version hosted an independent document in an iframe, and the cost showed up quickly: a duplicated toolbar per pane, a theme that had to be reimplemented, shortcuts trapped inside the document, state lost on every tab switch — all of them exactly the line between "feels like an IDE" and "doesn't".

All three panes are now components mounted straight into the host React tree:

- `require('react')` resolves to the host's instance;
- the stylesheet is injected once (scoped to `.gwb`), colors come from the host's design tokens (`--dsw-alias-*`), light and dark follow automatically, and there is no theme switch of our own;
- shortcuts are bound on the component root, not to a document boundary;
- clicking a file is one function call, `openDiff(ctx, …)`: write to a small store, then switch the session view to "Diff".

The HTTP layer is unchanged, and `/dsh-git/api` is still the only source of data.

## Three panes and the DSH slots

| Pane | Where it lands | Notes |
|---|---|---|
| Commit | Right sidebar tab, `sidebar.right.pane.tab` | Draggable to another panel, splittable, floatable, fullscreen |
| History | Same | Another tab, not subordinate to Commit |
| Diff | `conversation.view` ring (next to "Chat" and "Trajectory") | Singleton: a second file click only replaces the content |

Tab kinds register a `guide` entry as well, so the right sidebar's `+` guide page lists "Commit" and "History"; the guide entry and the tab title share the same string (`tab.commit` / `tab.log` / `tab.console`), so one pane never goes by two names in the bottom dock and the right sidebar.

**Coexisting with dsh-better-sidebar**: that plugin has its own bottom workbench, and its tabs come only from its own `ctx.betterSidebar.registerTab` registry — it does not enumerate the host's right-sidebar kinds, so "Commit / History / Console" have to be handed to it a second time. Registration uses a soft `ctx.get('betterSidebar')` lookup — the service name stays out of `dsh.client.inject`, we register only when it is installed, and do nothing when it is not — and passes `bottomOnly: true`: without that flag it mints a native right-sidebar kind for every registration and displaces the three above. Its tab component receives only a `{ sessionId, cwd }` scope instead of the host's store hooks, and `ctx.sessions` is a service that throws when read without being declared, so the repository directory comes from the scope itself.

**Why the diff is not a resource (`dsh-resource://`) kind**: a resource kind derives its contentId from the address, which means one tab per file; what we want is precisely one shared contentId. A page kind with params is the right shape.

**The cost of putting the diff in the main area**: DSH's global panel is exclusive — once `selectPanel` takes effect, the conversation and the right sidebar unmount together, so the full "editor + tool window side by side" layout is out of reach. The compensation lives in the diff's own header: `3 / 5` opens the full list of the current file set, `‹ ›` / `Alt+↑/↓` switch files, `F7` switches hunks, `Esc` / ✕ returns to the conversation. The interface layer depends on `openDiff` in one place only, so if the host grows a split view one day, replacing it is cheap.

## Every place in DSH that shows a diff

DSH Web renders code changes in four places. They are distinct surfaces, not one component:

| # | Place | Data source | How we plug in |
|---|---|---|---|
| 1 | The `edit` / `write` tool cards in chat (an inline diff per change) | Tool call arguments | **Not replaced**, see below |
| 2 | The deliverables card at the end of a turn | The `present` tool + files | `deliverables.file.actions` → the `Git` button, which opens the "Diff" tab in the middle conversation area (see below) |
| 3 | The right sidebar's "Changes" review page (file-by-file) | `workspace/changes` | `deliverables.review.file.actions` → the same `Git` button |
| 4 | The right sidebar's "Files" page | The workspace directory | `sidebar.right.tab.files.actions` → opens the "Commit" tab |

**The `seq` in places 2 and 3 is not the same numbering.** The host numbers session events uniformly in append order, and `ctx.workspaceChanges.summary(sessionId, seq)` understands only the `workspace/changes` event; the `seq` handed to the action slots by the deliverables card belongs to the `deliverables/presented` event. The plugin bridges the two server-side by reading the session log: take the `sessions` service, find the delivery event with that sequence number, read its `turn`, then find the newest `workspace/changes` event in the same turn and ask for the snapshot with that event's sequence number. `index` needs translating too — the card's index counts its own file list, the snapshot counts the turn's file list — so the delivery event's `path` maps back to the file with the same path in the snapshot. When the two cannot be bridged (a snapshot lives only for as long as **the session is open in the current process**, and is gone once the session is released or the host restarts), `/turn` raises an explained error, and the diff view turns it into plain language with an exit to "view the worktree changes in the Commit tab", instead of one English error line.

The "Edited N files" change card in chat **has no third-party action slot** — the host gives it only its own "View this turn's changes in the sidebar" button, which is what leads to the review page in row 3, where the `Git` button lives.

The session-header branch chip (`conversation.session.header.actions`) and the new-session empty-state branch picker (`conversation.hero.options`) are Git entry points, not diff surfaces.

**Why place 1 is not replaced**: `tool.call.toolview` is a slot that **replaces by key** — registering `key: "edit"` displaces the official inline diff card wholesale, including its folding, line counts and click-to-open behaviour. Rewriting that card to add one button costs more than it buys, and neither card declares any child action slot, so "adding one alongside" is not possible either.

The alternative path: every `edit` / `write` belongs to a turn, and the entry points in places 2 and 3 already cover "what did this turn actually change". Adding a button to the tool cards would take DOM injection (`webserver/index-inject` + MutationObserver), and it would break on the next host redesign.

## State synchronization

- **Polling**: `/status` every 5 seconds, fingerprinted with `JSON.stringify(files)+branch+ahead+behind`; an unchanged fingerprint re-renders nothing (a diff being read does not flicker).
- **Selection freezes polling**: once the user starts ticking lines, polling pauses, otherwise one refresh would clear the selection.
- **Full refresh after a write**: no guessing after stage / commit — re-fetch status and the current file's diff. git's index has no cheap incremental interface, and one wrong guess costs far more than one extra request.
- **Writes are serialized**: `GitService.withWriteLock` queues writes on a single promise chain.
- **SSE**: `/events` pushes the new `rev` when the repository changes, and the client decides from it whether to re-fetch, so nothing spins.

## Commits follow the index

A checkbox is only a shortcut for "stage / unstage"; a commit always commits the index and never sweeps the unstaged part along. Hunk and line staging take the same road: pull the selection out of the structured diff → trim it into a valid patch (correct hunk headers and counts, with `--recount` as a safety net) → `git apply --cached`. The reverse (unstage) is `git apply --cached --reverse`, and line-level unstaging is just as exact.

A changelist's "commit this list" uses a temporary index: based on HEAD, keep only that list's entries, commit, then refresh the real index — the other lists' staged content stays in the index untouched. Partial stash uses the same trick, avoiding `git stash push -- <paths>` dragging the whole index into the stash's second parent.

## Localization

The interface language follows DSH's language preference (Settings → General), falling back to the browser language when unset; the commit-message language follows the same decision (and can be pinned with `commitLanguage`).

- The strings live in the `STRINGS` table in `src/client/client.i18n.js` (semantic keys, the two sides must carry the same set, a missing entry falls back to Chinese and then to the key), so nothing ever renders blank.
- The client apply registers the dictionaries into DSH's locale registry (namespace `gitWorkbench`) and subscribes to `ctx.locale`'s active language: switching the language in the host re-renders the panel live, with no restart or reinstall. The one exception is the right sidebar's tab titles — the host keeps the title text from when the tab was created (DSH's own "Start" tab behaves the same way), so an open tab keeps the old language until it is closed and reopened or the host restarts. `locale/<lang>.json` still holds only the plugin metadata (`meta.title` / `meta.description`), which is the plugin-manager convention; DSH does not read runtime copy from there.
- It covers every button, tab, empty state, hint, error, context/popover menu, turn snapshot, commit panel, conflict resolution and settings.
- It does not cover git's own output (paths, branch names, commit messages) or the tool descriptions handed to the model (those stay English).
- git's refusals are mapped in `localizeError` (`a branch named … already exists`, `nothing to commit`, non-fast-forward pushes, `CONFLICT (` …), stripping the `fatal:` / `error:` prefixes and the `hint:` boilerplate — a Chinese interface never shows a wall of raw English errors.

## Styling and design tokens

The stylesheet is a single injected `<style>`, every selector scoped under `.gwb`; colors come only from the host's `--dsw-alias-*` tokens, so light/dark and the host's brand colors all follow automatically.

A few self-imposed rules (follow them when adding UI):

- **A hue may be a surface, never small text.** Text uses `--gwb-*-ink` (an ink color mixed toward the body text color); text on a colored surface uses `--gwb-on-hue`, never a hard-coded `#fff`.
- **Menu icons are monochrome and the same size**; a destructive row is marked by red text only, not by a colored icon.
- **A button has to look like a button**: secondary controls in a toolbar carry a border, in-row actions are blue text links, read-only numbers stay neutral gray.
- **A destructive button names its verb and is red, with focus parked on "Cancel".**
- The type scale is 10.5 / 11 / 12 / 13 — no odd fractional values.

## Security model

This is the precondition for using it on real repositories:

- **No shell**: every call is `spawn('git', argv)`, so `"`, `$(...)`, `%PATH%` and newlines in a path are just ordinary characters.
- **Fixed output formats**: `--no-pager`, `core.quotepath=false`, `color.ui=false`, `LC_ALL=C` — the user's pager, aliases and color configuration cannot change what we parse.
- **Reads and writes separated**: every write goes through `withWriteLock`, so only one index change happens at a time.
- **Path and revision validation**: `..` escapes are rejected, arguments starting with `-` are rejected as injection, commit/ref only accepts a valid revision; remote names, branch names, upstream names and script names each have their own allow list.
- **CSRF rejection**: a request whose `Origin` does not match `Host` gets a 403.
- **Only the API under the prefix**: `/dsh-git/` maps no static directory; request bodies cap at 2 MB, and read requests are memoized by revision.
- **Read-only switch**: under `readOnly: true` every POST except `/config` returns 403, and the panel does not render write entry points either.
- **No credentials collected**: network operations disable terminal credential prompts (`GIT_TERMINAL_PROMPT=0`) and set a 120 s timeout; on failure git's output is handed back, and it never hangs waiting for input.
- **No user input executed**: neither the model tools nor the HTTP endpoints accept a command string; the pre-commit checks only accept script names that already exist in `package.json`.
