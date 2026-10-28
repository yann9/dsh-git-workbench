# Design trade-offs: notes on matching JetBrains

> This document records "why it looks like this", not "what it does". The feature list is [features.md](features.md),
> the code structure is [architecture.md](architecture.md). Every decision that looks like it could be simpler has a reason here.

## 1. Three panes, not three modes

JetBrains' Git is not "one window that switches modes" but three independent panes: the commit staging area (Commit), the commit history (Log), and the diff viewer. The first two are tool windows you can drag anywhere; the diff is not a tool window — it opens in the editor, and there is **only one**: click another file and the same tab changes content.

Three points matter, and dropping any one of them makes the experience wrong:

1. **Commit and history are not subordinate to each other.** Each has its own state (selections, scroll, filters, commit draft), and switching must not lose it; stuffing them into one tab's segmenter makes every switch a mutual reset.
2. **The diff does not belong to a tool window.** It is "content", so it gets content-area size and is a **singleton**.
3. **The host decides the position.** Dragging Commit into the bottom-left corner is routine in an IDE, so a plugin must not assume which tab it is.

DSH's right sidebar provides exactly the first two: `sidebarRightTabs.register(kind)` produces draggable tabs, and a tab component mounts into `sidebar.right.pane.tab`. The diff is not a tool window — it registers on `conversation.view`'s view ring, and there is one of it.

```
commit  → Commit   (list + conflicts + commit bar)
log     → History  (graph + commit details + file list)
diff    → Diff     (singleton; diffTargetStore decides which file shows)
```

**The source decides the content, and the writability**: entering from "Commit" gives you the worktree diff (stageable by hunk/line); entering from "History" gives you that commit's diff, read with `git diff <parent> <sha>`, **read-only**, with no staging entry point at all. Each source's `‹ n/m ›` counts its own file set, so the two never contaminate each other.

**Why not `multiple: true` for "one tab per file"**: ten files would then mean ten tabs — the opposite of JetBrains — and closing tabs becomes daily chores.

**Why the diff tab is not a `dsh-resource://` kind**: a resource kind derives its contentId from the address, which means one tab per file; what we want is precisely one shared contentId.

## 2. No iframe

The iframe approach (an independent document + postMessage) was removed wholesale. It did isolate CSS, but at the price of: a duplicated toolbar per pane, a theme that had to be reimplemented, shortcuts trapped inside the document, state lost on every tab switch — all of them exactly the line between "feels like an IDE" and "doesn't".

All three panes now mount into the host React tree: the stylesheet is injected once (scoped to `.gwb`), colors come from the host's design tokens, and shortcuts are bound on the component root. **Read-only is not "hiding buttons"**: once `readOnly` reaches the render layer, the selection, the hunk actions and the stage buttons do not exist on the read-only path at all. As in an IDE, "viewing history" is another state, not "the current state plus a lock".

A fourth pane = one more chunk + one more slot registration, with no existing component touched.

## 3. The main area as the editor: cost and compensation

Putting the diff in the middle is the IDE position, but DSH's global panel is **exclusive**: once `layout.selectPanel(id)` takes effect, the conversation and the right sidebar unmount together, so the full "editor + tool window side by side" layout is out of reach.

The compensation sits in the diff's own header instead of pretending the tool window is still there:

- `3 / 5` is a **button** that opens the full list of the current file set (with status badges); picking one swaps the diff;
- `‹ ›` and `Alt+↑/↓` switch files, `F7` / `Shift+F7` switch hunks, and stepping past the edge moves into the adjacent file;
- `Esc` / ✕ returns to the conversation and the tool window comes back (content is re-fetched; scroll position is not kept).

Scroll-wheel edge switching was dropped on purpose: in ordinary reading "scroll to the end" and "go to the next file" are a few pixels apart, and a misfire is more annoying than saving a keypress. The edge behaviour is deliberate too: pressing up at the first file or down at the last one says so instead of wrapping — wrapping leaves you unsure whether you went round.

If the host ever grows a main-area split, this should become a "right content column" rather than the main panel; the interface layer depends on `openDiff` in one place only, so the swap is cheap.

## 4. One constraint kept on purpose

The panel and the Agent **share the same service**. After the Agent calls `git_stage`, the panel's next refresh shows a result computed by the same rules; there is no such thing as "the Agent staged something different from what I see". This is also why the git logic lives host-side instead of calling the API straight from the browser.

## 5. How this differs from existing DSH Git plugins

The community already has git plugins centred on: read/write tools plus a simple panel, natural-language command suggestions, structured read-only tools, and multi-platform PR / issue work. This project's positioning is one sentence: **do the IDE's diff / staging interaction completely**.

| Capability | The usual approach | Here |
|---|---|---|
| Staging granularity | Whole file | Whole file / hunk / line |
| Diff | A single unified text column | Side by side + unified, both line numbers, selectable lines |
| Commit graph | `git log --graph` text | A DAG in SVG lanes, clickable |
| Commit scope | The index or everything | Strictly the index |
| Agent / UI consistency | Implemented separately | One service |

## 6. Where the implementation is genuinely hard

Ordered by how much pain it caused, as a signpost for anyone building on this:

1. **Line-level staging.** The algorithm is easy; the edges are not — new files, CRLF, a missing final newline, multi-selection across hunks. `--recount` catches wrong counts, but a wrong marker semantic is beyond saving.
2. **Commit-graph layout.** A single greedy pass matches IDEA's look in most repositories; what is genuinely hard is "as few lanes as possible, and stable", which needs a two-pass layout plus conflict resolution.
3. **Conflict resolution.** The three-way view reads index stages 1/2/3 directly, splits by markers, and decides block by block: each write rewrites one block and leaves the other markers alone, the last block is `git add`ed in passing, and the view exits. Besides taking a side, the merged result can be typed straight under a block (the `custom` strategy), still scoped to that block. Another trap: after taking ours everywhere the worktree shows zero changes while `MERGE_HEAD` still exists, so status must report `merging` separately — otherwise the commit button is blocked by "nothing staged" and the merge can never end.
4. **Partial-file stash.** `git stash push -- <paths>` **drags the whole index into the stash's second parent**, so popping brings back content that was never ticked. `git stash` has to be given a temporary index: based on HEAD, copy in only the ticked paths' entries from the real index, and afterwards `git reset` just those paths. A rename has to be handled as both the old and the new path; stashing only the new one tears the rename apart.
5. **Committing a changelist by list.** Also a temporary index; for a rename outside the scope, dropping only the new path still lets the old path's deletion follow the commit — `origPath` has to be expanded on both sides.
6. **Inline word diff.** Split del/add lines into words for a token LCS, strip the common prefix and suffix first, then align; the unified view, the side-by-side view and both columns of the conflict view share the same range computation.
7. **Interactive rebase.** The host writes the todo to a temporary file, `GIT_SEQUENCE_EDITOR` / `GIT_EDITOR` point at local editor scripts, and user input enters only as hashes + allow-listed actions. The easiest thing to miss: when the sequencer pauses the commit bar comes back to life, and clicking "Commit" then builds a commit on top of the sequencer — commits and Amend must be disabled while paused, and `Ctrl+Enter` must not get around it either.

## 7. Deliberately out of scope

- **No credential prompting for `git push`**: password / token inputs in a web panel are a security anti-pattern. Network operations disable terminal credentials and set a timeout; on failure git's words are handed back.
- **No git in the browser**: a WASM git cannot reach the real worktree, nor reuse the user's git configuration.
- **No "natural language to git command"**: that is another product direction; the model tools here are structured, with schema-constrained parameters.
- **No DOM injection to take over the inline diff cards in chat**: `tool.call.toolview` replaces a whole card by key, and rewriting the official card to add one button costs more than it buys.

## 8. Trade-offs in later additions

### 8.1 Entry points on the turn card

DSH's "changes this turn" card already renders file names and added/removed line counts; what it lacks is the ability to **see the full diff**. Two roads:

| Option | Cost | Verdict |
|---|---|---|
| Replace the card | Reimplement all of the card's layout and interaction, and it falls apart on the next host redesign | Not chosen |
| Add a button to the card's action slot | Depends on the official slot contract; the worst a host redesign does is make the button disappear | Chosen |

It uses the `deliverables.file.actions` and `deliverables.review.file.actions` list-type, session-scoped action slots. The `actionUrl` query string carries `sessionId` / `seq` / `index`, so nothing has to cross a document boundary — but the two slots' `seq` is not the same thing: the review page hands over the `workspace/changes` event's sequence number, which is exactly what `ctx.workspaceChanges` understands; the deliverables card hands over the `deliverables/presented` event's sequence number. The server reads the session log and bridges the two by `turn`, so the same `Git` button opens the "Diff" tab in the middle conversation area from either card.

**Why the snapshot deserves a view of its own**: `workspace/changes` records "this turn's start → end", independent of the worktree's current state. Once the user commits, the worktree diff is empty, but "what the Agent changed this turn" still means something. That is also why it must be read-only — snapshot content cannot be staged or committed.

### 8.2 Cross-file navigation

- **Single-file views** (changes, a historical commit): `Alt+↑/↓` or the header's `‹ n/m ›` switch to the adjacent file; `F7` / `Shift+F7` jump between hunks, and stepping past the edge enters the adjacent file's first / last hunk.
- **Stacked view** (a turn): it is one scroll flow already, and the card entry point uses `scrollIntoView` to land on the right turn.

### 8.3 AI commit messages

The call chain is `ctx.agentDefaultModel.currentSelection()` → pick a route → `listModels()` → `ctx.llm.stream()` → assemble the `text-delta`. Four traps:

1. **A provider is keyed by `id`, not `name`.** The routing key is `provider.id`; passing `name` gets you `no adapter registered for provider`.
2. **After the stream, read `finish.reason`, not `finish.error`.** A failure shows up as `reason.kind === 'error'`, and missing that leads to the misleading conclusion "the model returned an empty message".
3. **The route must be the one the user has selected in DSH, not the first provider in the list.** An official login registers more than one provider, and the first one may expose no models at all (its catalog lives in the App's model picker, not in any registry a plugin can enumerate), so `listModels()` comes back empty, there is no `defaultModel`, and the result is "the provider has no usable model" — while the chat dialog works fine. The conversation itself uses `ctx.agentDefaultModel.currentSelection()`, so the plugin copies that; `llmProvider` / `llmModel` in the plugin settings override it field by field.
4. **`listModels()` may be empty.** It is an optional capability. The candidate chain is: the current selection / the configured `llmModel` → the `listModels()` catalog → the provider's own `defaultModel`. No model id is hard-coded.

Degrading is not failing: no model, no key, a timeout — all of them fall back to a local rule that produces a `type(scope): what changed` message and shows the real reason. Committing must not be held up by the AI.

## 9. UI principles

These are not aesthetic preferences; they are rules caught by real screenshots over several full-interface reviews. Follow them when adding UI:

1. **One control expresses one thing.** `∧ 2/3 ∨` (hunks within a file) and `‹ 2 / 8 ›` (between files) are separate groups with separate counters; the counter follows the reading position, and when the whole diff is short enough not to scroll the last click takes over — otherwise the button looks broken.
2. **Empty states do not lie.** A directory that is not a repository renders no branch chip, no status row and no commit box, only "what this is / what to do next".
3. **Read-only must be visible, and actually read-only.** A read-only source carries a lock mark, no selection and no write buttons; ignore-whitespace mode is the same, with a one-click way back when the diff is empty.
4. **Destructive actions**: the button names its verb (Discard changes / Hard reset / Drop stash / Force push …) and is red, focus defaults to "Cancel", and Enter cannot press an irreversible button for the user.
5. **Errors must outlive the reading time**: an error toast does not vanish on its own while a message toast leaves by itself; a failure popover is left-aligned, with the `hint:` boilerplate stripped and anything past 6 lines truncated.
6. **The same operation asks the same question everywhere**: anything that rewrites the worktree goes through the same dirty-worktree confirmation; a context menu opens exactly the same action table as the persistent `⋯`.
7. **A button has to look like a button**: secondary toolbar controls carry a border; in-row actions are blue text links; a pure reading (like the conflict view's `1 / 3`) stays neutral gray and does not pretend to be an action.
8. **No decoration in menus**: monochrome icons at one size, destructive rows marked by red text only; a variant arrow sits centred under its own label instead of hanging in a corner; a short menu sizes to its longest label and would rather wrap a whole sentence than truncate it with an ellipsis.
9. **A label is either written out or folded into `+N`.** A fragment like `or…` explains nothing; refs that do not fit on one row fold into a badge whose tooltip carries the full names.
10. **A Chinese interface never shows raw English errors.** git's refusals and the `fatal:` / `error:` prefixes all pass through `localizeError`; the wording of actions is unified too (checkout, discard) — one action, one verb.
11. **A hue may be a surface, never small text.** Text uses an ink token mixed toward the body text color, and text on a colored surface uses `--gwb-on-hue`; light and dark are both derived from tokens, with no second dark override.
12. **Numbers have to add up**: with a filter on, the header says "matched 4 of 11"; header and data columns are strictly the same width; when a column is narrow it yields by the width of its own section, header and data rows together.
