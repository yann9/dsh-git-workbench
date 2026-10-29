# HTTP API

Every endpoint lives under `/dsh-git/api`. The `dir` parameter names the repository directory (absolute path): it defaults to the configured `repoPath`, and the panel always passes the current session's cwd. The API has nothing to do with the UI — any client can reuse it directly; the plugin's own browser components are just one consumer.

```
GET  /dsh-git/api/status?dir=<abs-path>
```

## Read endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/rev` | Repository revision token (HEAD + index/refs metadata); the ETag source for every GET |
| GET | `/events` | SSE: pushes the new `rev` when the repository changes, so the client never polls |
| GET | `/info` | Repository root, gitDir, whether it is unborn, remotes |
| GET | `/status` | Branch / upstream / ahead-behind + file list (including conflicted files and any operation in progress) |
| GET | `/console` | The last 200 git invocations in this repository: argv, exit code, duration and truncated output |
| GET | `/workspaces` | The DSH workspace registry, marked with which entries are Git repositories |
| GET | `/overview` | The whole workspace's changes: each file's staged and unstaged sides in one response |
| GET | `/turn?session=&seq=` | Read-only snapshot of one session turn (from `ctx.workspaceChanges`) |
| GET | `/commit-file?sha=&file=&ignoreWhitespace=` | One file's diff inside a commit (`git diff <parent> <sha>`, a read-only source) |
| GET | `/diff?file=&staged=&rev=&ignoreWhitespace=` | Structured diff (one side) |
| GET | `/file?file=&ignoreWhitespace=` | The staged and unstaged sides of the same file |
| GET | `/log?limit=&all=&ref=` | The commit DAG, optionally narrowed to a branch / tag |
| GET | `/commit?sha=&ignoreWhitespace=` | One commit's metadata plus its full diff |
| GET | `/message?rev=` | A single commit message (to prefill Amend / Reword) |
| GET | `/branches` | Local / remote branches + tags (with upstreams) |
| GET | `/remotes` | Remote list (name + fetch URL) |
| GET | `/blame?file=&rev=` | Line-by-line annotate |
| GET | `/stash` | Stash list |
| GET | `/stash-show?ref=&ignoreWhitespace=` | Read-only preview of one stash (file list, including untracked files) |
| GET | `/stash-file?ref=&file=&ignoreWhitespace=` | The diff of one file inside a stash |
| GET | `/untracked` | Untracked file contents as a synthetic diff |
| GET | `/config` | The current configuration (defaults filled in) |
| GET | `/checks` | The repository's `package.json` scripts that can run, plus the package manager; `reason` explains why there are none / the file is invalid |
| GET | `/compare?left=&right=&limit=` | Two refs' `ahead/behind` and the commits unique to each side |
| GET | `/rebase-plan?base=` | Preview the commits in `base..HEAD` (old to new, merge markers included); refuses with a reason when the worktree is dirty, base is not an ancestor of HEAD, a merge is involved, or there are more than 100 commits |

## Write endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/config` | Merge and save the configuration; allowed even under `readOnly` |
| POST | `/console/clear` | Clear this repository's console history (other repositories are untouched) |
| POST | `/pull` `/push` `/fetch` | Network operations: `pull --no-rebase`, `push`, `fetch --prune`, 120 s timeout; `push` accepts `force` (`--force-with-lease`) and `remote` (`-u <remote> HEAD` when there is no upstream; defaults to `origin`, or the first remote when `origin` is missing) |
| POST | `/remote-add` `/remote-url` `/remote-remove` | `{name, url}` / `{name, url}` / `{name}`: manage remotes (`git remote add/set-url/remove`); names and URLs are validated host-side |
| POST | `/merge` | `{branch}`, `git merge --no-edit <branch>` |
| POST | `/rebase-onto` | `{branch}`, `git rebase <branch>`: requires a clean worktree and no sequencer running, and the target must be neither the current branch nor an unknown ref; a conflict returns `{ok:false, paused:true, conflicts, output}` and leaves the rebase paused |
| POST | `/stage` | `{file, direction, mode:file\|hunk\|lines, hunk, lines, selection}`, or `{files:[...]}` in bulk |
| POST | `/revert` | Discard a hunk / line in the worktree (touches only the unstaged side) |
| POST | `/resolve` | `{file, strategy: mark\|ours\|theirs\|both}`, resolve a whole file and `git add` it |
| POST | `/conflict-view` | `{file}` → `{count, complete, base, segments[]}`; segments come in order as `plain` / `conflict`, and conflict segments carry `ours\|theirs\|base\|line\|raw` |
| POST | `/resolve-region` | `{file, region, strategy: ours\|theirs\|both\|custom, result?}`, answer one conflict block; `custom` replaces the block with `result` (multi-line text, no conflict markers); the last block is `git add`ed automatically; returns `{remaining}` |
| POST | `/rebase` | `{base, entries:[{hash, action: pick\|squash\|fixup\|drop}]}`; a clean finish returns `{ok, kept, folded, dropped}`, a conflict or an empty replay returns `{ok:false, paused:true, conflicts, empty, output}` and leaves the sequencer paused |
| POST | `/reword` | `{sha, message}`: HEAD goes through `commit --amend`, an earlier commit replays a same-order todo with reword; returns `{ok, amended, sha}`, and an unexpectedly paused sequencer returns `{ok:false, paused:true, conflicts, empty}`; requires a clean worktree |
| POST | `/abort` | Abort the operation in progress: picks `--abort` for `merge` / `rebase` / `cherry-pick` / `revert` from the `.git` markers, and errors out when nothing is running |
| POST | `/ignore` | `{files:[...]}`, append the paths to the repository-root `.gitignore`; rules that already exist are not written twice |
| POST | `/rollback` | `{files:[...]}`, discard changes (restore / unstage / delete untracked) |
| POST | `/tag` `/delete-tag` `/push-tag` | `{name, ref?, force?}` / `{name}` / `{name}` |
| POST | `/cherry-pick` `/revert-commit` | `{hashes\|sha}`; on a conflict the sequencer state is kept so the panel can carry on |
| POST | `/reset` | `{mode: soft\|mixed\|hard, ref, confirm}`; hard requires an explicit `confirm` |
| POST | `/rename-branch` | `{branch, name}`: validate the name and check for a clash first, then `git branch -m` |
| POST | `/set-upstream` `/unset-upstream` | `{branch, upstream}` / `{branch}`: point a local branch at an existing remote branch, or drop the tracking relationship; both refs must exist, and the upstream name is validated in its two `remote/branch` parts |
| POST | `/switch` | `{ref}`, `git switch --detach <ref>` to check out any revision |
| POST | `/commit` | `{message, amend}` |
| POST | `/commit-paths` | `{files:[...], message}`: commit only what these files have staged (temporary index), leaving the rest of the index as it was; renames are handled as both the old and the new path, so they are not swept into the commit |
| POST | `/check` | `{script}`: run a package script non-interactively (120 s timeout, 120 k output cap, process tree killed on timeout); 403 under read-only, script names strictly allow-listed |
| POST | `/commit-message` | `{language?, provider?, model?}`, draft a commit message from the index via `ctx.llm` |
| POST | `/checkout` | `{branch, create, from}`; a remote branch gets a tracking branch automatically |
| POST | `/checkout-commit` | `{sha}`, detached HEAD |
| POST | `/delete-branch` | `{branch, force}` |
| POST | `/delete-remote-branch` | `{remote, branch}`: `git push <remote> --delete <branch>`; the remote name and the branch name are validated separately, and a default branch (main / master / HEAD) is refused. A successful push also drops the local `refs/remotes/…` ref, so the list settles without another fetch |
| POST | `/stash` | `{action: push\|pop\|apply\|drop, ref}` |

## Conventions

**Ignore whitespace**: `/diff`, `/file`, `/commit-file`, `/commit`, `/stash-show` and `/stash-file` all accept `ignoreWhitespace=1`, which maps to `git diff -w`. This mode is for reading only: `-w` computes different hunk indices than a plain diff, and `/stage` / `/revert` re-read the unfiltered diff, so the client disables every write while the filter is on.

**Caching**: GET responses carry an `x-git-rev` header. Endpoints whose contents are fully determined by the revision support `?rev=` negotiation and answer `304`, and are memoized server-side by revision. Volatile endpoints — worktree, diff, stash, blame, branches (upstreams live in `.git/config`, outside the revision) — are never cached.

**CSRF**: any request whose `Origin` does not match `Host` gets a `403` — opening some random web page must not be able to commit for you.

**Request bodies**: 2 MB limit. Every write endpoint returns `403` under `readOnly: true` (except `/config`).

**Errors**: git's refusals come back with the original output, and the client turns them into a Chinese/English sentence through `localizeError`. A failure the user is meant to act on (a conflict, an empty replay) is not an error but `{ok:false, paused:true, ...}`, with the sequencer state left in the repository.

**Serialization**: every write goes through the same `withWriteLock`, so only one index change happens at a time. Two overlapping hunk stages running concurrently would invalidate each other's patch pre-image.

## Tools for the model

The model side has 8 structured tools with schema-constrained parameters, so the model never assembles a command line:

| Tool | Purpose |
|---|---|
| `git_status` | Branch, upstream, ahead/behind, file list |
| `git_diff` | Worktree or index diff (structured hunks) |
| `git_log` | The commit DAG |
| `git_show` | One commit's metadata and diff |
| `git_stage` | Stage / unstage (file, hunk, lines) |
| `git_commit` | Commit the index |
| `git_branch` | List / switch / create branches |
| `git_blame` | Line-by-line authors |

They go through the same `GitService` layer as the panel, so there is no such thing as "the Agent sees a different state than the panel".
