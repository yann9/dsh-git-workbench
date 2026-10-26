/**
 * Git service: the only place that decides *what* to run. HTTP routes and
 * model tools both call into this layer, so the web panel and the agent can
 * never disagree about repository state or safety rules.
 *
 * Writes are serialized per service instance. Git takes its own index lock,
 * but two agent calls that stage overlapping hunks must not interleave their
 * read-modify-write of the patch either.
 */

import path from 'node:path'
import { copyFile, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readStatus, readLog, readBranches, readBlame, readFileAt, resolveRepo } from './repo.js'
import { parseDiff, scopeIds } from './diff.js'
import { applyToIndex, applyToWorktree, applyWholeFiles, buildPatch, revertSelectedLines } from './patch.js'
import { git, runGit, splitNul, readGitConsole, clearGitConsole, CONSOLE_LIMIT } from './exec.js'
import { analyzeConflicts, applyDecision } from './conflict.js'
import { revisionToken, readHead, watchRepo } from './revision.js'
import { readPackageChecks, runPackageCheck } from './checks.js'

/**
 * @typedef {object} StageRequest
 * @property {'stage'|'unstage'} direction
 * @property {string} file repo-relative path
 * @property {'file'|'hunk'|'lines'} mode
 * @property {number} [hunk]
 * @property {number[]} [lines]
 */

/** Whole-file context for the diff view: long enough that git emits the entire file. */
const FULL_CONTEXT = 1_000_000

/** Sequence editor handed to `git rebase -i`; see rebase-editor.js. */
const REBASE_EDITOR = fileURLToPath(new URL('./rebase-editor.js', import.meta.url))

/** Message editor for a `reword` todo line; see reword-editor.js. */
const REWORD_EDITOR = fileURLToPath(new URL('./reword-editor.js', import.meta.url))

export class GitService {
  /**
   * @param {{ defaultDir?: string, maxLog?: number }} [options]
   */
  constructor(options = {}) {
    this.defaultDir = options.defaultDir ?? process.cwd()
    this.maxLog = options.maxLog ?? 400
    /** @type {Promise<unknown>} */
    this.writeQueue = Promise.resolve()
    /** @type {Map<string, { time: number, value: { head: string, rev: string } }>} */
    this.revisions = new Map()
  }

  /**
   * @param {string} [dir]
   * @returns {Promise<string>}
   */
  async resolveDir(dir) {
    const candidate = dir && dir.trim() !== '' ? dir : this.defaultDir
    const repo = await resolveRepo(candidate)
    return repo.root
  }

  /**
   * @param {string} [dir]
   */
  async info(dir) {
    const root = await this.resolveDir(dir)
    const repo = await resolveRepo(root)
    const remotes = await runGit(root, ['remote', '-v'], { allowFailure: true })
    /** @type {{ name: string, url: string }[]} */
    const remoteList = []
    for (const line of remotes.stdout.split('\n')) {
      const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line)
      if (match && match[3] === 'fetch') remoteList.push({ name: match[1], url: match[2] })
    }
    return { ...repo, root, remotes: remoteList }
  }

  /**
   * @param {string} [dir]
   */
  async status(dir) {
    const root = await this.resolveDir(dir)
    return readStatus(root)
  }

  /**
   * The Git tool window's Console: what actually ran, in argv form, scoped to
   * this working tree. Read-only; the caller cannot inject commands here.
   * @param {object} [input]
   * @param {string} [input.dir]
   */
  async console(input = {}) {
    const root = await this.resolveDir(input.dir)
    return { entries: readGitConsole(root), limit: CONSOLE_LIMIT }
  }

  async clearConsole(input = {}) {
    const root = await this.resolveDir(input.dir)
    return { removed: clearGitConsole(root) }
  }

  /**
   * Scripts the repository offers as pre-commit checks. Discovery only reads
   * package.json; running one is a separate, explicitly named request.
   * @param {string} [dir]
   */
  async checks(dir) {
    const root = await this.resolveDir(dir)
    return readPackageChecks(root)
  }

  /**
   * @param {{ dir?: string, script: string }} input
   */
  async runCheck(input) {
    const root = await this.resolveDir(input.dir)
    return runPackageCheck(root, input.script)
  }

  /**
   * Working-tree diff (index → worktree) or staged diff (HEAD → index).
   * @param {object} input
   * @param {string} [input.dir]
   * @param {string} [input.file]
   * @param {boolean} [input.staged]
   * @param {string} [input.rev] diff against an arbitrary revision (`sha^` for a commit view)
   * @param {boolean} [input.full] whole-file context instead of the usual 3 lines
   */
  async diff(input) {
    const root = await this.resolveDir(input.dir)
    const args = ['diff', '--no-textconv', '--no-color', '--no-ext-diff', `-U${input.full ? FULL_CONTEXT : 3}`, '--find-renames']
    if (input.ignoreWhitespace) args.push('-w')
    if (input.staged) args.push('--cached')
    if (input.rev) args.push(input.rev)
    if (input.file) {
      assertSafePath(input.file)
      args.push('--', input.file)
    }
    const raw = await git(root, args)
    const files = parseDiff(raw)
    return { root, files: scopeIds(files, '') }
  }

  /**
   * A file as it changed in one commit. `git diff <parent> <sha>` rather than
   * `git show`, so a merge commit reports against its first parent instead of a
   * combined diff nobody can stage anyway. Read-only: the working tree is not
   * involved, which is why the panel disables the hunk actions for this source.
   * @param {string} [dir]
   * @param {string} sha
   * @param {string} file
   */
  async commitFile(dir, sha, file, options = {}) {
    assertSafePath(file)
    const root = await this.resolveDir(dir)
    const parents = await runGit(root, ['rev-list', '--parents', '-n', '1', sha], { allowFailure: true })
    const [, firstParent] = parents.stdout.trim().split(' ')
    const context = `-U${options.full ? FULL_CONTEXT : 3}`
    const args = firstParent
      ? ['diff', '--no-textconv', '--no-color', '--no-ext-diff', '--find-renames', context, ...(options.ignoreWhitespace ? ['-w'] : []), firstParent, sha, '--', file]
      : ['show', '--format=', '--no-color', '--no-ext-diff', ...(options.ignoreWhitespace ? ['-w'] : []), '--root', context, sha, '--', file]
    const raw = await runGit(root, args, { allowFailure: true })
    const parsed = parseDiff(raw.stdout)[0]
    if (!parsed) return { file, entry: { kind: 'modified', path: file }, staged: null, unstaged: null }
    const entry = { kind: parsed.status, path: file, origPath: parsed.oldPath }
    return { file, entry, staged: null, unstaged: { ...parsed, path: file } }
  }

  /**
   * Both sides for one file in a single response — the panel shows the
   * "staged / unstaged" split per file like JetBrains does.
   * @param {string} [dir]
   * @param {string} file
   */
  async fileDiff(dir, file, options = {}) {
    assertSafePath(file)
    const root = await this.resolveDir(dir)
    const [unstaged, staged, status] = await Promise.all([
      this.diff({ dir: root, file, staged: false, full: options.full, ignoreWhitespace: options.ignoreWhitespace }),
      this.diff({ dir: root, file, staged: true, full: options.full, ignoreWhitespace: options.ignoreWhitespace }),
      readStatus(root),
    ])
    const entry = status.files.find((candidate) => candidate.path === file)
    let worktreeDiff = unstaged.files[0] ?? null
    if (!worktreeDiff && entry?.kind === 'untracked') {
      worktreeDiff = await this.untrackedDiff(root, file, options)
    }
    return {
      file,
      staged: staged.files[0] ?? null,
      unstaged: worktreeDiff,
      entry: entry ?? null,
    }
  }

  /**
   * Whole-repository review: every changed file with both of its sides in one
   * response, so the panel can render a single scrollable "all changes" page
   * instead of one round trip per file.
   *
   * Untracked files are included (their diff is synthesized), because "what did
   * I change" is not answered by `git diff` alone. Both lists are capped so a
   * runaway tree cannot turn the panel into a 200 MB JSON body.
   * @param {string} [dir]
   * @param {{ maxUntracked?: number, maxFiles?: number }} [options]
   */
  async overview(dir, options = {}) {
    const root = await this.resolveDir(dir)
    const status = await readStatus(root)
    const [unstaged, staged] = await Promise.all([
      this.diff({ dir: root, staged: false }),
      this.diff({ dir: root, staged: true }),
    ])

    /** @type {Map<string, { path: string, kind: string, untracked: boolean, staged: any, unstaged: any }>} */
    const files = new Map()
    const ensure = (filePath, kind) => {
      let entry = files.get(filePath)
      if (!entry) {
        entry = { path: filePath, kind, untracked: kind === 'untracked', staged: null, unstaged: null }
        files.set(filePath, entry)
      }
      return entry
    }

    for (const file of status.files) ensure(file.path, file.kind)
    for (const file of staged.files) ensure(file.path, file.status).staged = file
    for (const file of unstaged.files) ensure(file.path, file.status).unstaged = file

    const untrackedEntries = status.files.filter((file) => file.kind === 'untracked')
    const maxUntracked = options.maxUntracked ?? 30
    let skippedUntracked = Math.max(0, untrackedEntries.length - maxUntracked)
    for (const entry of untrackedEntries.slice(0, maxUntracked)) {
      const diff = await this.untrackedDiff(root, entry.path)
      if (diff) ensure(entry.path, 'untracked').unstaged = diff
      else skippedUntracked += 1
    }

    const maxFiles = options.maxFiles ?? 300
    const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
    const truncated = list.length > maxFiles

    return {
      root,
      branch: status.detached ? null : status.branch,
      detached: status.detached,
      unborn: status.repo.unborn,
      counts: status.counts,
      files: truncated ? list.slice(0, maxFiles) : list,
      truncated,
      skippedUntracked,
      total: list.length,
    }
  }

  /**
   * `git diff` never shows untracked files; the panel still needs their
   * content, so synthesize the same shape through `--no-index`.
   * @param {string} root
   * @param {string} file
   */
  async untrackedDiff(root, file, options = {}) {
    const raw = await runGit(root, ['diff', '--no-index', '--no-textconv', '--no-color', '--no-ext-diff', ...(options.ignoreWhitespace ? ['-w'] : []), `-U${options.full ? FULL_CONTEXT : 3}`, '--', '/dev/null', file], {
      allowFailure: true,
      maxBytes: 4 * 1024 * 1024,
    })
    const files = scopeIds(parseDiff(raw.stdout), '')
    const parsed = files[0]
    if (!parsed) return null
    return { ...parsed, path: file, oldPath: file, status: 'added' }
  }

  /**
   * @param {object} input
   * @param {string} [input.dir]
   * @param {string} input.sha
   */
  /**
   * Cheap repository revision: HEAD sha plus the mtime/size of the files git
   * rewrites (index, packed-refs, refs/*). All filesystem reads — no git
   * process. Memoised for 200ms so a burst of panel requests pays for one
   * scan, and it changes when anything — this plugin, a terminal or the IDE —
   * touches the repository.
   * @returns {Promise<{ root: string, head: string, rev: string }>}
   */
  async revision(input = {}) {
    const root = await this.resolveDir(input.dir)
    const now = Date.now()
    const hit = this.revisions.get(root)
    if (hit && now - hit.time < 200) return { root, head: hit.value.head, rev: hit.value.rev }
    const head = await readHead(root)
    const rev = await revisionToken(root, head)
    this.revisions.set(root, { time: now, value: { head, rev } })
    return { root, head, rev }
  }

  /**
   * Subscribe to changes this process did not cause (terminal, IDE, other
   * tools). Returns a disposer.
   * @param {string} root
   * @param {(root: string) => void} listener
   */
  onRepoChange(root, listener) {
    return watchRepo(root, listener)
  }

  async showCommit(input) {
    assertRev(input.sha)
    const root = await this.resolveDir(input.dir)
    const meta = await runGit(
      root,
      ['show', '--no-patch', '--date=iso-strict', '--pretty=format:%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%B', input.sha],
      { allowFailure: false },
    )
    const [hash, author, email, date, parents, message] = meta.stdout.split('\u001f')
    const parentList = parents ? parents.split(' ').filter(Boolean) : []
    // `git show` prints nothing for merge commits; diff against the first parent
    // instead, so a merge lists the changes it brought in.
    const args = parentList.length > 0
      ? ['diff', '--no-textconv', '--no-color', '--no-ext-diff', '--find-renames', ...(input.ignoreWhitespace ? ['-w'] : []), '-U3', parentList[0], input.sha]
      : ['show', '--root', '--format=', '--no-color', '--no-ext-diff', '--find-renames', ...(input.ignoreWhitespace ? ['-w'] : []), '-U3', input.sha]
    // A merge against its first parent can be enormous; never let it pin the host.
    const patch = await git(root, args, { timeoutMs: 30_000 })
    return {
      hash,
      author,
      email,
      date,
      parents: parentList,
      message,
      files: scopeIds(parseDiff(patch), ''),
    }
  }

  /**
   * @param {object} [input]
   * @param {string} [input.dir]
   * @param {number} [input.limit]
   * @param {boolean} [input.all]
   * @param {string} [input.ref] branch/tag/sha to scope the walk to
   */
  async log(input = {}) {
    const root = await this.resolveDir(input.dir)
    // `ref` lets the Log pane view the history of any branch, not just HEAD.
    const ref = typeof input.ref === 'string' ? input.ref.trim() : ''
    // argv 数组本身没有 shell 注入面，但要挡住以 `-` 开头的选项注入。
    if (ref.startsWith('-') || ref.length > 255) throw new Error(`invalid ref: ${ref.slice(0, 40)}`)
    // `path` scopes the walk to one file — the IDE's "Show History for File".
    const path = typeof input.path === 'string' ? input.path.trim().replaceAll('\\', '/') : ''
    if (path.startsWith('-') || path.length > 512) throw new Error(`invalid path: ${path.slice(0, 40)}`)
    return readLog(root, {
      limit: input.limit ?? this.maxLog,
      all: input.all ?? true,
      ref: ref || undefined,
      path: path || undefined,
    })
  }

  /** Detach HEAD onto a commit — the log pane's right-click "checkout". */
  async checkoutCommit(input = {}) {
    const sha = String(input.sha ?? '').trim()
    if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) throw new Error(`invalid commit sha: ${sha}`)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const result = await runGit(root, ['switch', '--detach', sha], { allowFailure: true })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'git switch --detach failed')
      return { ok: true }
    })
  }

  /**
   * Delete a local branch. `-d` refuses unmerged branches unless `force`.
   * @returns {Promise<{ ok: boolean, output: string }>}
   */
  async deleteBranch(input = {}) {
    const branch = assertBranchName(input.branch)
    if (branch === 'main' || branch === 'master' || branch === 'HEAD') {
      throw new Error(`refusing to delete the default branch ${branch}`)
    }
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const result = await runGit(root, ['branch', input.force ? '-D' : '-d', branch], { allowFailure: true })
      const output = [result.stdout, result.stderr].map((part) => part.trim()).filter(Boolean).join('\n')
      if (result.code !== 0) throw new Error(output || `git branch -d ${branch} failed`)
      return { ok: true, output }
    })
  }

  /**
   * Rename a local branch. Git only ever moves the local ref, so the answer
   * reports the upstream the renamed branch is still tracking — the remote
   * branch keeps the old name until the user pushes it themselves.
   */
  async renameBranch(input = {}) {
    const branch = assertBranchName(input.branch)
    const name = assertBranchName(input.name)
    if (branch === name) throw new Error(`the branch is already called ${name}`)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const exists = await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true })
      if (exists.code !== 0) throw new Error(`no such local branch: ${branch}`)
      const taken = await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { allowFailure: true })
      if (taken.code === 0) throw new Error(`a branch called ${name} already exists`)
      const upstream = await runGit(root, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { allowFailure: true })
      const result = await runGit(root, ['branch', '-m', branch, name], { allowFailure: true })
      if (result.code !== 0) throw new Error(result.stderr.trim() || `git branch -m ${branch} failed`)
      return { ok: true, branch: name, upstream: upstream.code === 0 ? upstream.stdout.trim() : '' }
    })
  }

  /**
   * Point a local branch at a remote-tracking branch — the IDE's
   * "Set Upstream to...". Both refs have to exist: a tracking config that
   * points at nothing breaks every later pull, and git only finds out when
   * it tries.
   */
  async setUpstream(input = {}) {
    const branch = assertBranchName(input.branch)
    const upstream = assertUpstreamName(input.upstream)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const local = await runGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true })
      if (local.code !== 0) throw new Error(`no such local branch: ${branch}`)
      const remote = await runGit(root, ['show-ref', '--verify', '--quiet', `refs/remotes/${upstream}`], { allowFailure: true })
      if (remote.code !== 0) throw new Error(`no such remote branch: ${upstream}`)
      const result = await runGit(root, ['branch', `--set-upstream-to=${upstream}`, branch], { allowFailure: true })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'git branch --set-upstream-to failed')
      return { ok: true, branch, upstream }
    })
  }

  /**
   * Drop the tracking relationship. The branch and its commits stay; only
   * the "pull and push know where to go" part is gone.
   */
  async unsetUpstream(input = {}) {
    const branch = assertBranchName(input.branch)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const current = await runGit(root, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { allowFailure: true })
      if (current.code !== 0) throw new Error(`the branch ${branch} has no upstream`)
      const result = await runGit(root, ['branch', '--unset-upstream', branch], { allowFailure: true })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'git branch --unset-upstream failed')
      return { ok: true, branch }
    })
  }

  /**
   * What two refs have that the other lacks — the IDE's "Compare with Current".
   * @returns {Promise<{ left: string, right: string, ahead: number, behind: number, leftOnly: object[], rightOnly: object[] }>}
   */
  async compare(input = {}) {
    const left = assertCompareRef(input.left, 'HEAD')
    const right = assertCompareRef(input.right, '')
    if (!right) throw new Error('compare needs a branch, tag or commit on the right side')
    const limit = input.limit ?? 60
    const root = await this.resolveDir(input.dir)
    for (const ref of [left, right]) {
      const known = await runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true })
      if (known.code !== 0) throw new Error(`unknown revision: ${ref}`)
    }
    const counts = await runGit(root, ['rev-list', '--left-right', '--count', `${left}...${right}`], { allowFailure: true })
    if (counts.code !== 0) throw new Error(counts.stderr.trim() || 'git rev-list failed')
    const [ahead, behind] = counts.stdout.trim().split(/\s+/).map((value) => Number(value) || 0)
    // Each side's own commits: `right..left` walks what left added on top of the
    // merge base, and the other way round.
    const [leftOnly, rightOnly] = await Promise.all([
      ahead > 0 ? readLog(root, { limit, all: false, ref: `${right}..${left}` }) : [],
      behind > 0 ? readLog(root, { limit, all: false, ref: `${left}..${right}` }) : [],
    ])
    return { left, right, ahead, behind, leftOnly, rightOnly }
  }

  /**
   * @param {string} [dir]
   */
  async branches(dir) {
    const root = await this.resolveDir(dir)
    const [branches, tags] = await Promise.all([
      readBranches(root),
      runGit(root, ['tag', '--list', '--sort=-creatordate', '--format=%(refname:short)'], { allowFailure: true }),
    ])
    return { ...branches, tags: tags.stdout.split('\n').filter(Boolean).slice(0, 50) }
  }

  /**
   * @param {object} input
   * @param {string} [input.dir]
   * @param {string} input.file
   * @param {string} [input.rev]
   */
  async blame(input) {
    assertSafePath(input.file)
    const root = await this.resolveDir(input.dir)
    const [lines, content] = await Promise.all([
      readBlame(root, input.file, input.rev),
      readFileAt(root, input.file, input.rev).catch(() => ''),
    ])
    return { file: input.file, rev: input.rev ?? 'HEAD', lines, lines_total: content === '' ? 0 : content.split('\n').length }
  }

  /**
   * Stage or unstage files, hunks, or arbitrary line selections.
   * @param {StageRequest & { dir?: string }} request
   */
  /**
   * Discard worktree changes for a hunk or a set of lines — the IDE's "还原"
   * (Ctrl+Alt+R). Only the unstaged side is affected: staged lines stay in the
   * index, exactly like the IDE's Local Changes rollback.
   * @param {{ dir?: string, file: string, mode?: string, hunk?: number, lines?: number[], full?: boolean, selection?: {hunk: number, lines?: number[]}[] }} request
   */
  async revertLines(request) {
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(request.dir)
      assertSafePath(request.file)
      const status = await readStatus(root)
      const entry = status.files.find((file) => file.path === request.file)
      if (!entry) throw new Error(`file is not in the working-tree status: ${request.file}`)
      if (entry.kind === 'untracked') throw new Error('untracked files have nothing to revert')

      const diff = await this.diff({ dir: root, file: request.file, staged: false, full: request.full === true })
      const fileDiff = diff.files[0]
      if (!fileDiff) throw new Error(`no worktree changes for ${request.file}`)

      /** @type {Set<string>} */
      const selected = new Set()
      const picks =
        Array.isArray(request.selection) && request.selection.length > 0
          ? request.selection
          : [{ hunk: request.hunk ?? 0, lines: request.mode === 'hunk' ? undefined : request.lines }]

      for (const pick of picks) {
        const hunk = fileDiff.hunks[pick.hunk ?? 0]
        if (!hunk) throw new Error(`hunk ${pick.hunk} not found in ${request.file}`)
        if (!Array.isArray(pick.lines)) {
          for (const line of hunk.lines) selected.add(line.id)
          continue
        }
        for (const index of pick.lines) {
          const line = hunk.lines[index]
          if (!line) throw new Error(`line ${index} not found in hunk ${pick.hunk}`)
          selected.add(line.id)
        }
      }

      // A line subset cannot be expressed as a cropped reverse patch — the
      // unselected lines break the context the worktree has to match. Whole
      // hunks still go through `git apply`, which handles modes and renames.
      if (picks.some((pick) => Array.isArray(pick.lines))) {
        const changed = await revertSelectedLines(root, fileDiff, selected)
        if (!changed) throw new Error('nothing selected to revert')
        return { ok: true, applied: 'lines' }
      }

      const patch = buildPatch(fileDiff, selected, 'stage')
      if (!patch) throw new Error('nothing selected to revert')
      await applyToWorktree(root, patch, { reverse: true })
      return { ok: true, applied: request.mode ?? 'hunk' }
    })
  }

  async stage(request) {
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(request.dir)
      const status = await readStatus(root)

      // Bulk whole-file move (toolbar "stage all" / "unstage all").
      if (Array.isArray(request.files) && request.files.length > 0) {
        for (const file of request.files) assertSafePath(file)
        await applyWholeFiles(root, request.files, request.direction, status.repo.unborn)
        return { ok: true, applied: 'files', count: request.files.length }
      }

      assertSafePath(request.file)
      const entry = status.files.find((file) => file.path === request.file)
      if (!entry) throw new Error(`file is not in the working-tree status: ${request.file}`)

      const wholeFileOnly =
        entry.kind === 'untracked' || entry.kind === 'conflicted' || entry.kind === 'added' || entry.kind === 'renamed' || entry.kind === 'copied'

      if (request.mode === 'file' || wholeFileOnly) {
        const paths = entry.origPath ? [entry.path, entry.origPath] : [entry.path]
        await applyWholeFiles(root, paths, request.direction, status.repo.unborn)
        return { ok: true, applied: 'file' }
      }

      const diff = await this.diff({ dir: root, file: request.file, staged: request.direction === 'unstage', full: request.full === true })
      const fileDiff = diff.files[0]
      if (!fileDiff) throw new Error(`no ${request.direction === 'unstage' ? 'staged ' : ''}changes for ${request.file}`)

      /** @type {Set<string>} */
      const selected = new Set()
      const picks = Array.isArray(request.selection) && request.selection.length > 0
        ? request.selection
        : [{ hunk: request.hunk ?? 0, lines: request.mode === 'hunk' ? undefined : request.lines }]

      for (const pick of picks) {
        const hunk = fileDiff.hunks[pick.hunk ?? 0]
        if (!hunk) throw new Error(`hunk ${pick.hunk} not found in ${request.file}`)
        if (!Array.isArray(pick.lines)) {
          for (const line of hunk.lines) selected.add(line.id)
          continue
        }
        for (const index of pick.lines) {
          const line = hunk.lines[index]
          if (!line) throw new Error(`line ${index} not found in hunk ${pick.hunk}`)
          selected.add(line.id)
        }
      }

      const patch = buildPatch(fileDiff, selected, request.direction)
      if (!patch) throw new Error('nothing selected to apply')
      await applyToIndex(root, patch, { reverse: request.direction === 'unstage' })
      return { ok: true, applied: request.mode, bytes: patch.length }
    })
  }

  /**
   * Resolve a conflicted file: take one side (or keep the edited file) and
   * stage it, which is what tells git the conflict is settled.
   * @param {{ dir?: string, file: string, strategy?: 'mark'|'ours'|'theirs'|'both' }} input
   */
  async resolveConflict(input = {}) {
    const file = String(input.file ?? '')
    assertSafePath(file)
    const strategy = ['ours', 'theirs', 'both'].includes(input.strategy) ? input.strategy : 'mark'
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      if (strategy === 'both') {
        // "Accept both" has no git equivalent: it is our side followed by
        // theirs, in place, for every block at once.
        await this.#writeDecision(root, file, null, 'both')
      } else if (strategy !== 'mark') {
        const take = await runGit(root, ['checkout', `--${strategy}`, '--', file], { allowFailure: true })
        if (take.code !== 0) throw new Error(take.stderr.trim() || `git checkout --${strategy} failed`)
      }
      const add = await runGit(root, ['add', '--', file], { allowFailure: true })
      if (add.code !== 0) throw new Error(add.stderr.trim() || 'git add failed')
      return { ok: true, strategy }
    })
  }

  /**
   * The three-way view of one conflicted file: both sides of every marker
   * block, plus the ancestor straight from the index. Read-only.
   * @param {{ dir?: string, file: string }} input
   */
  async conflictView(input = {}) {
    const file = String(input.file ?? '')
    assertSafePath(file)
    const root = await this.resolveDir(input.dir)
    const text = await this.#readWorktree(root, file)
    const { segments, count, complete } = analyzeConflicts(text)
    const base = await runGit(root, ['show', `:1:${file}`], { allowFailure: true })
    // A CRLF checkout leaves `\r` on every line; the view is only for reading,
    // and resolveRegion re-reads the file, so dropping it here is safe.
    const trim = (lines) => lines.map((line) => line.replace(/\r$/, ''))
    return {
      path: file,
      count,
      complete,
      segments: segments.map((segment) =>
        segment.kind === 'plain'
          ? { ...segment, lines: trim(segment.lines) }
          : { ...segment, base: trim(segment.base), ours: trim(segment.ours), theirs: trim(segment.theirs) },
      ),
      base: base.code === 0 ? base.stdout.replace(/\r\n/g, '\n').replace(/\n$/, '') : null,
    }
  }

  /**
   * Answer a single conflict block and leave the rest marked — the incremental
   * path a merge tool needs. Once the last block is gone the file is staged,
   * because there is nothing left to resolve. `custom` writes the hand-edited
   * text for that block instead of one of the two sides.
   * @param {{ dir?: string, file: string, region: number, strategy?: 'ours'|'theirs'|'both'|'custom', result?: string }} input
   */
  async resolveRegion(input = {}) {
    const file = String(input.file ?? '')
    assertSafePath(file)
    const strategy = ['ours', 'theirs', 'custom'].includes(input.strategy) ? input.strategy : 'both'
    const text = String(input.result ?? '').replace(/\r\n/g, '\n')
    const resolution = strategy === 'custom' && text !== '' ? text.split('\n') : []
    const region = Number(input.region)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      if (!Number.isInteger(region) || region < 0) throw new Error('no such conflict region')
      const before = analyzeConflicts(await this.#readWorktree(root, file))
      if (!before.complete) throw new Error('conflict markers are broken')
      if (region >= before.count) throw new Error('no such conflict region')
      await this.#writeDecision(root, file, region, strategy, resolution)
      const remaining = analyzeConflicts(await this.#readWorktree(root, file)).count
      if (remaining === 0) {
        const add = await runGit(root, ['add', '--', file], { allowFailure: true })
        if (add.code !== 0) throw new Error(add.stderr.trim() || 'git add failed')
      }
      return { ok: true, strategy, region, remaining }
    })
  }

  /** @param {string} root @param {string} file */
  async #readWorktree(root, file) {
    try {
      return await readFile(path.join(root, file), 'utf8')
    } catch {
      throw new Error('conflict file missing')
    }
  }

  /** @param {string} root @param {string} file @param {number|null} region @param {'ours'|'theirs'|'both'|'custom'} strategy @param {string[]} [resolution] */
  async #writeDecision(root, file, region, strategy, resolution = []) {
    const text = await this.#readWorktree(root, file)
    const { segments, count, complete } = analyzeConflicts(text)
    if (count === 0) throw new Error('no conflict markers')
    if (!complete) throw new Error('conflict markers are broken')
    await writeFile(path.join(root, file), applyDecision(segments, region, strategy, resolution), 'utf8')
  }

  /**
   * Unwind a paused sequencer — the escape hatch JetBrains puts beside the
   * conflict list. Which command runs depends on the marker git left behind.
   * @param {{ dir?: string }} input
   */
  async abortOperation(input = {}) {
    /** @type {Record<string, string[]>} */
    const commands = {
      merge: ['merge', '--abort'],
      rebase: ['rebase', '--abort'],
      'cherry-pick': ['cherry-pick', '--abort'],
      revert: ['revert', '--abort'],
    }
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const status = await readStatus(root)
      const command = status.operation ? commands[status.operation] : undefined
      if (!command) throw new Error('nothing is in progress')
      const result = await runGit(root, command, { allowFailure: true })
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${command.join(' ')} failed`)
      }
      return { ok: true, operation: status.operation }
    })
  }

  /**
   * Interactive rebase, step one: the commits after `base` in the order git
   * replays them (oldest first). A merge commit cannot be represented in a
   * plain todo file — git would silently flatten it — so the plan refuses
   * instead of changing history in a way the user did not ask for.
   * @param {{ dir?: string, base?: string }} input
   */
  async rebasePlan(input = {}) {
    const base = this.refToken(input.base, 'rebase base')
    const root = await this.resolveDir(input.dir)
    return this.#rebasePlan(root, base)
  }

  /** @param {string} root @param {string} base */
  async #rebasePlan(root, base) {
    const status = await readStatus(root)
    if (status.operation) throw new Error(`a ${status.operation} is already in progress`)
    // Only tracked edits block a rebase; untracked files are left alone by git.
    if (status.files.some((file) => file.staged || file.unstaged)) throw new Error('rebase needs a clean worktree')
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim()
    const ancestor = await runGit(root, ['merge-base', '--is-ancestor', base, 'HEAD'], { allowFailure: true })
    if (ancestor.code !== 0) throw new Error(`not an ancestor of HEAD: ${base}`)
    const raw = await git(root, ['log', '--reverse', '--format=%H%x1f%h%x1f%P%x1f%an%x1f%as%x1f%s', `${base}..HEAD`])
    const commits = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, short, parents, author, date, subject] = line.split('\u001f')
        return { hash, short, author, date, subject, merge: parents.split(' ').filter(Boolean).length > 1 }
      })
    if (commits.length === 0) throw new Error('nothing to rebase: the base is HEAD')
    if (commits.length > 100) throw new Error('interactive rebase is limited to 100 commits here')
    if (commits.some((commit) => commit.merge)) throw new Error('interactive rebase does not support merge commits yet')
    return { root, head, base, commits }
  }

  /**
   * Interactive rebase, step two. The todo is written by the host and handed
   * to git through a sequence editor — nothing a user typed reaches a shell.
   * Actions: pick (keep), squash (fold into the previous kept commit and
   * combine messages), fixup (fold and discard this message), drop.
   * @param {{ dir?: string, base?: string, entries?: {hash: string, action: string}[] }} input
   */
  async rebase(input = {}) {
    const base = this.refToken(input.base, 'rebase base')
    const requested = Array.isArray(input.entries) ? input.entries : []
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const plan = await this.#rebasePlan(root, base)
      const known = new Map(plan.commits.map((commit) => [commit.hash, commit]))
      if (requested.length !== known.size) throw new Error('the rebase plan must include every commit exactly once')
      const seen = new Set()
      // `kept` counts the commits that will exist afterwards (one per pick),
      // not the rows that survive: a squash/fixup row is folded away too.
      let kept = 0
      let folded = 0
      let dropped = 0
      let keptRows = 0
      const lines = []
      for (const entry of requested) {
        const hash = String(entry?.hash ?? '').trim()
        const action = String(entry?.action ?? 'pick')
        if (!['pick', 'squash', 'fixup', 'drop'].includes(action)) throw new Error(`invalid rebase action: ${action.slice(0, 20)}`)
        if (!known.has(hash) || seen.has(hash)) throw new Error(`unknown or duplicate commit in the rebase plan: ${hash.slice(0, 40)}`)
        seen.add(hash)
        // git folds squash/fixup into the previous kept commit; there must be one.
        if ((action === 'squash' || action === 'fixup') && keptRows === 0) throw new Error('the first kept commit cannot be squashed')
        if (action === 'drop') {
          dropped += 1
        } else {
          keptRows += 1
          if (action === 'pick') kept += 1
          else folded += 1
        }
        lines.push(`${action} ${hash}`)
      }
      if (seen.size !== known.size) throw new Error('the rebase plan must include every commit exactly once')
      const todoFile = path.join(tmpdir(), `dsh-rebase-${process.pid}-${Date.now()}.todo`)
      await writeFile(todoFile, `${lines.join('\n')}\n`, 'utf8')
      try {
        const editor = `"${process.execPath.replaceAll('\\', '/')}" "${REBASE_EDITOR.replaceAll('\\', '/')}"`
        const result = await runGit(root, ['rebase', '-i', base], {
          allowFailure: true,
          timeoutMs: 180_000,
          env: {
            GIT_SEQUENCE_EDITOR: editor,
            // Squash stops to ask for the combined message; keep git's default.
            GIT_EDITOR: 'true',
            DSH_REBASE_TODO: todoFile,
            ELECTRON_RUN_AS_NODE: '1',
          },
        })
        if (result.code !== 0) {
          const after = await readStatus(root)
          if (after.operation === 'rebase') {
            // Paused for conflicts (or an empty commit): the panel already knows
            // how to show and abort a sequencer, so this is not an HTTP error.
            const conflicts = after.files.filter((file) => file.kind === 'conflicted').length
            const output = [result.stdout, result.stderr].map((part) => part.trim()).filter(Boolean).join('\n')
            return { ok: false, paused: true, conflicts, empty: /is now empty/i.test(output), output }
          }
          throw new Error(result.stderr.trim() || result.stdout.trim() || 'git rebase failed')
        }
        return { ok: true, kept, folded, dropped }
      } finally {
        await rm(todoFile, { force: true })
      }
    })
  }

  /**
   * Rewrite one commit's message without touching its tree. HEAD is amended;
   * an older commit is marked reword in a same-order rebase, so no patch can
   * conflict — the rebase replays exactly the commits it started with.
   * @param {{ dir?: string, sha?: string, message?: string }} input
   */
  async reword(input = {}) {
    const sha = this.shaList(input.sha)[0]
    const message = String(input.message ?? '').trim()
    if (!message) throw new Error('the commit message cannot be empty')
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const status = await readStatus(root)
      if (status.operation) throw new Error(`a ${status.operation} is already in progress`)
      if (status.files.some((file) => file.staged || file.unstaged)) throw new Error('reword needs a clean worktree')
      const resolved = await runGit(root, ['rev-parse', '--verify', `${sha}^{commit}`], { allowFailure: true })
      if (resolved.code !== 0) throw new Error('unknown commit for reword')
      const full = resolved.stdout.trim()
      const head = (await git(root, ['rev-parse', 'HEAD'])).trim()
      if (full === head) {
        const amended = await runGit(root, ['commit', '--amend', '-m', message], { allowFailure: true, timeoutMs: 60_000 })
        if (amended.code !== 0) throw new Error(amended.stderr.trim() || amended.stdout.trim() || 'git commit --amend failed')
        return { ok: true, amended: true, sha: (await git(root, ['rev-parse', 'HEAD'])).trim() }
      }
      const ancestor = await runGit(root, ['merge-base', '--is-ancestor', full, 'HEAD'], { allowFailure: true })
      if (ancestor.code !== 0) throw new Error('the commit to reword is not an ancestor of HEAD')
      const parents = (await git(root, ['rev-list', '--parents', '-n', '1', full])).trim().split(/\s+/).slice(1)
      if (parents.length > 1) throw new Error('reword does not support merge commits')
      if (parents.length === 0) throw new Error('reword does not support the root commit')
      const base = parents[0]
      const raw = await git(root, ['log', '--reverse', '--format=%H', `${base}..HEAD`])
      const lines = raw
        .split('\n')
        .filter(Boolean)
        .map((hash) => `${hash.trim() === full ? 'reword' : 'pick'} ${hash.trim()}`)
      if (!lines.some((line) => line.startsWith('reword '))) throw new Error('the commit to reword is not on the current branch')
      const todoFile = path.join(tmpdir(), `dsh-reword-${process.pid}-${Date.now()}.todo`)
      await writeFile(todoFile, `${lines.join('\n')}\n`, 'utf8')
      try {
        const exe = process.execPath.replaceAll('\\', '/')
        const result = await runGit(root, ['rebase', '-i', base], {
          allowFailure: true,
          timeoutMs: 180_000,
          env: {
            GIT_SEQUENCE_EDITOR: `"${exe}" "${REBASE_EDITOR.replaceAll('\\', '/')}"`,
            GIT_EDITOR: `"${exe}" "${REWORD_EDITOR.replaceAll('\\', '/')}"`,
            DSH_REBASE_TODO: todoFile,
            DSH_REWORD_MESSAGE: message,
            ELECTRON_RUN_AS_NODE: '1',
          },
        })
        if (result.code !== 0) {
          const after = await readStatus(root)
          if (after.operation === 'rebase') {
            const conflicts = after.files.filter((file) => file.kind === 'conflicted').length
            const output = [result.stdout, result.stderr].map((part) => part.trim()).filter(Boolean).join('\n')
            return { ok: false, paused: true, conflicts, empty: /is now empty/i.test(output), output }
          }
          throw new Error(result.stderr.trim() || result.stdout.trim() || 'git rebase failed while rewording')
        }
        return { ok: true, sha: (await git(root, ['rev-parse', 'HEAD'])).trim() }
      } finally {
        await rm(todoFile, { force: true })
      }
    })
  }

  /**
   * Continue a paused sequencer after the conflicts are resolved. Merge is
   * intentionally absent: finishing a merge is a commit, which the commit bar
   * already offers with an editable message.
   * @param {{ dir?: string }} input
   */
  async continueOperation(input = {}) {
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const status = await readStatus(root)
      if (!status.operation) throw new Error('nothing is in progress')
      if (status.operation === 'merge') throw new Error('finish the merge with a commit')
      if (status.files.some((file) => file.kind === 'conflicted')) throw new Error('resolve the conflicts first')
      const result = await runGit(root, [status.operation, '--continue'], {
        allowFailure: true,
        timeoutMs: 180_000,
        env: { GIT_EDITOR: 'true' },
      })
      if (result.code !== 0) {
        const after = await readStatus(root)
        // Still inside the sequencer: git stopped again for conflicts or because
        // the replayed commit became empty. Both are states the panel can resume
        // from, so report them instead of failing the request.
        if (after.operation) {
          const conflicts = after.files.filter((file) => file.kind === 'conflicted').length
          const output = [result.stdout, result.stderr].map((part) => part.trim()).filter(Boolean).join('\n')
          return { ok: false, paused: true, conflicts, empty: /is now empty/i.test(output), output }
        }
        throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${status.operation} --continue failed`)
      }
      return { ok: true, operation: status.operation }
    })
  }

  /**
   * Add paths to the repository's own `.gitignore`, the way JetBrains offers it
   * on unversioned files. Existing lines are left alone so hand-tuned patterns
   * survive; only genuinely new patterns are appended.
   * @param {{ dir?: string, files?: string[] }} input
   */
  async ignore(input = {}) {
    const files = [...new Set((Array.isArray(input.files) ? input.files : []).filter(Boolean))]
    if (files.length === 0) throw new Error('no files selected')
    for (const file of files) assertSafePath(file)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const file = path.join(root, '.gitignore')
      let text = ''
      try {
        text = await readFile(file, 'utf8')
      } catch {
        /* the repository has no .gitignore yet */
      }
      const lines = text.split(/\r?\n/)
      const known = new Set(lines.map((line) => line.trim()))
      const added = files.filter((pattern) => !known.has(pattern) && !known.has(`/${pattern}`) && !known.has(pattern.replace(/^\//, '')))
      if (added.length > 0) {
        const prefix = text === '' || text.endsWith('\n') ? text : `${text}\n`
        await writeFile(file, `${prefix}${added.join('\n')}\n`, 'utf8')
      }
      return { ok: true, path: '.gitignore', added: added.length }
    })
  }


  /**
   * Discard changes (JetBrains' Rollback): put the paths back to exactly what
   * HEAD holds — tracked files are restored, staged-only files are un-staged,
   * untracked files are deleted. Destructive by design; the caller confirms.
   * @param {{ dir?: string, files?: string[] }} input
   */
  async rollback(input = {}) {
    const files = [...new Set((Array.isArray(input.files) ? input.files : []).filter(Boolean))]
    if (files.length === 0) throw new Error('no files selected')
    for (const file of files) assertSafePath(file)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const status = await readStatus(root)
      /** @type {Map<string, { restore: string[], unstage: string[], clean: string[] }>} */
      const plan = { restore: [], unstage: [], clean: [] }
      for (const file of files) {
        const entry = status.files.find((item) => item.path === file)
        if (entry?.kind === 'untracked') {
          plan.clean.push(file)
          continue
        }
        const paths = entry?.origPath ? [file, entry.origPath] : [file]
        for (const path of paths) {
          const inHead = await runGit(root, ['cat-file', '-e', `HEAD:${path}`], { allowFailure: true })
          if (inHead.code === 0) plan.restore.push(path)
          else plan.unstage.push(path)
        }
      }
      const errors = []
      if (plan.restore.length > 0) {
        const back = await runGit(root, ['checkout', 'HEAD', '--', ...plan.restore], { allowFailure: true })
        if (back.code !== 0) errors.push(back.stderr.trim() || 'git checkout failed')
      }
      if (plan.unstage.length > 0) {
        const drop = await runGit(root, ['rm', '--cached', '-q', '--', ...plan.unstage], { allowFailure: true })
        if (drop.code !== 0) errors.push(drop.stderr.trim() || 'git rm --cached failed')
      }
      if (plan.clean.length > 0) {
        const gone = await runGit(root, ['clean', '-f', '--', ...plan.clean], { allowFailure: true })
        if (gone.code !== 0) errors.push(gone.stderr.trim() || 'git clean failed')
      }
      if (errors.length > 0) throw new Error(errors.join('\n'))
      return { ok: true, restored: plan.restore.length, unstaged: plan.unstage.length, removed: plan.clean.length }
    })
  }

  /**
   * Commit only the staged content of the given files (a JetBrains changelist
   * commit). Every other staged file stays staged for the next commit.
   *
   * The commit runs against a temporary index: the real one is copied, the
   * files outside the list are unstaged in the copy, and git commits that copy.
   * Afterwards the real index is refreshed for the committed paths, so they do
   * not come back as staged deletions.
   *
   * @param {object} input
   * @param {string} [input.dir]
   * @param {string} input.message
   * @param {string[]} input.files
   */
  async commitPaths(input = {}) {
    const message = String(input.message ?? '').trim()
    if (message === '') throw new Error('commit message is empty')
    const files = Array.isArray(input.files) ? input.files.map((file) => String(file)) : []
    if (files.length === 0) throw new Error('no files selected')
    for (const file of files) assertSafePath(file)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const status = await readStatus(root)
      if (status.operation) throw new Error(`a ${status.operation} is already in progress`)
      if (status.files.some((file) => file.kind === 'conflicted')) throw new Error('resolve the conflicts before committing')
      const wanted = new Set(files)
      const staged = status.files.filter((file) => file.staged && wanted.has(file.path))
      const untracked = status.files.filter((file) => file.kind === 'untracked' && wanted.has(file.path))
      if (staged.length === 0 && untracked.length === 0) throw new Error('nothing staged in this changelist')
      const indexPath = await this.resolveIndexPath(root)
      const temp = path.join(tmpdir(), `dsh-changelist-${process.pid}-${Date.now()}.index`)
      const env = { GIT_INDEX_FILE: temp }
      try {
        await copyFile(indexPath, temp).catch((error) => {
          // A repository without an index file yet has nothing staged to copy.
          if (error?.code !== 'ENOENT') throw error
        })
        const others = status.files
          .filter((file) => file.staged && !wanted.has(file.path))
          .flatMap((file) => (file.origPath ? [file.path, file.origPath] : [file.path]))
        if (others.length > 0) {
          const reset = await runGit(root, ['reset', '-q', 'HEAD', '--', ...others], { env, allowFailure: true })
          if (reset.code !== 0) throw new Error(reset.stderr.trim() || reset.stdout.trim() || 'git reset failed')
        }
        if (untracked.length > 0) {
          const add = await runGit(root, ['add', '--', ...untracked.map((file) => file.path)], { env, allowFailure: true })
          if (add.code !== 0) throw new Error(add.stderr.trim() || add.stdout.trim() || 'git add failed')
        }
        const result = await runGit(root, ['commit', '-m', message], { env, allowFailure: true })
        if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'git commit failed')
        // A rename is two paths: resetting only the new name would leave the
        // deletion of the old one behind.
        const committed = [...staged, ...untracked].flatMap((file) =>
          file.origPath ? [file.path, file.origPath] : [file.path],
        )
        const refresh = await runGit(root, ['reset', '-q', 'HEAD', '--', ...committed], { allowFailure: true })
        if (refresh.code !== 0) throw new Error(refresh.stderr.trim() || refresh.stdout.trim() || 'git reset failed')
        const head = await runGit(root, ['rev-parse', 'HEAD'], { allowFailure: true })
        return { ok: true, hash: head.stdout.trim(), files: committed, output: result.stdout }
      } finally {
        await rm(temp, { force: true }).catch(() => {})
      }
    })
  }

  /** Absolute path of the repository's index file. */
  async resolveIndexPath(root) {
    const result = await runGit(root, ['rev-parse', '--git-path', 'index'], { allowFailure: true })
    const value = result.stdout.trim()
    if (!value) throw new Error('could not locate the git index')
    return path.isAbsolute(value) ? value : path.resolve(root, value)
  }

  /**
   * @param {object} input
   * @param {string} [input.dir]
   * @param {string} input.message
   * @param {boolean} [input.amend]
   * @param {string[]} [input.files] commit only these paths (staged changes of other paths stay staged)
   */
  async commit(input) {
    const message = (input.message ?? '').trim()
    if (message === '') throw new Error('commit message is empty')
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const args = ['commit', '-m', message]
      if (input.amend) args.push('--amend')
      if (input.files && input.files.length > 0) {
        for (const file of input.files) assertSafePath(file)
        args.push('--', ...input.files)
      }
      const result = await runGit(root, args, { allowFailure: true })
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || 'git commit failed')
      }
      const head = await runGit(root, ['rev-parse', 'HEAD'], { allowFailure: true })
      return { ok: true, hash: head.stdout.trim(), output: result.stdout }
    })
  }

  /** Full message of one commit, without computing its diff. */
  async commitMessage(input = {}) {
    const root = await this.resolveDir(input.dir)
    const rev = (input.rev ?? 'HEAD').trim()
    assertRev(rev)
    const result = await runGit(root, ['show', '--no-patch', '--format=%B', rev])
    return { message: result.stdout.replace(/\s+$/, '') }
  }

  /**
   * @param {object} input
   * @param {string} [input.dir]
   * @param {string} input.branch
   * @param {boolean} [input.create]
   * @param {string} [input.from]
   */
  async checkout(input) {
    const branch = (input.branch ?? '').trim()
    if (!/^[A-Za-z0-9._\/-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..')) {
      throw new Error(`invalid branch name: ${branch}`)
    }
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      // A remote-tracking ref is not a local branch: create a local branch that
      // tracks it. Any remote is accepted, not just `origin`.
      const remote = input.create
        ? { code: 1 }
        : await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${branch}`], { allowFailure: true })
      let args = ['switch', branch]
      if (input.create) {
        args = ['switch', '-c', branch]
      } else if (remote.code === 0 && branch.includes('/')) {
        const local = branch.slice(branch.indexOf('/') + 1)
        const exists = await runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`], { allowFailure: true })
        args = exists.code === 0 ? ['switch', local] : ['switch', '-c', local, branch]
      }
      if (input.create && input.from) {
        assertRev(input.from)
        args.push(input.from)
      }
      const result = await runGit(root, args, { allowFailure: true })
      if (result.code !== 0) {
        if (!input.create && /not a valid object name|invalid reference/.test(result.stderr)) {
          const fallback = await runGit(root, ['checkout', branch], { allowFailure: true })
          if (fallback.code === 0) return { ok: true, output: fallback.stdout }
        }
        throw new Error(result.stderr.trim() || 'git switch failed')
      }
      return { ok: true, output: result.stdout }
    })
  }

  /**
   * Network operations (pull/push/fetch/merge). Git cannot ask for credentials
   * here — `GIT_TERMINAL_PROMPT=0` makes it fail fast instead of hanging — and
   * every call is time-boxed, so a stalled remote cannot pin the host.
   * @param {string} root
   * @param {string[]} args
   * @returns {Promise<{ ok: boolean, output: string }>}
   */
  async network(root, args) {
    const result = await runGit(root, args, { allowFailure: true, timeoutMs: 120_000 })
    const output = [result.stdout, result.stderr].map((part) => part.trim()).filter(Boolean).join('\n')
    if (result.code !== 0) throw new Error(output || `git ${args[0]} failed (exit ${result.code})`)
    return { ok: true, output }
  }

  /** @returns {Promise<{ ok: boolean, output: string }>} */
  async pull(input = {}) {
    const root = await this.resolveDir(input.dir)
    // Two accepted strategies: merge (default) and rebase.
    const args = ['pull', input.rebase ? '--rebase' : '--no-rebase']
    return this.withWriteLock(() => this.network(root, args))
  }

  /** @returns {Promise<{ ok: boolean, output: string }>} */
  async push(input = {}) {
    const root = await this.resolveDir(input.dir)
    const remote = input.remote ? this.remoteNameToken(input.remote) : ''
    return this.withWriteLock(async () => {
      // No upstream yet: publish the current branch instead of failing with a
      // message about --set-upstream.
      const upstream = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFailure: true })
      let args
      if (upstream.code === 0) {
        args = ['push']
      } else {
        // `origin` is a convention, not a fact: push to the remote the user
        // picked, else `origin` when it exists, else the only remote there is.
        const target = remote || (await this.defaultRemote(root))
        args = ['push', '-u', target, 'HEAD']
      }
      // Force uses --force-with-lease: it refuses to overwrite a remote commit
      // we have not seen, unlike plain --force.
      if (input.force) args.push('--force-with-lease')
      return this.network(root, args)
    })
  }

  /**
   * The remote a first push should use: the one the user chose, else
   * `origin`, else the first configured one. Throws when the repo has none —
   * "origin does not appear to be a git repository" is not an answer.
   */
  async defaultRemote(root) {
    const list = await this.listRemotes(root)
    if (list.length === 0) throw new Error('no remote configured: add one before pushing')
    const origin = list.find((remote) => remote.name === 'origin')
    return (origin ?? list[0]).name
  }

  /** @returns {Promise<{ ok: boolean, output: string }>} */
  async fetchAll(input = {}) {
    const root = await this.resolveDir(input.dir)
    return this.withWriteLock(() => this.network(root, ['fetch', '--prune']))
  }

  /** @returns {Promise<{ ok: boolean, output: string }>} */
  async merge(input = {}) {
    const branch = this.branchToken(input.branch)
    const root = await this.resolveDir(input.dir)
    return this.withWriteLock(() => this.network(root, ['merge', '--no-edit', branch]))
  }

  /**
   * Rebase the checked-out branch onto another ref, the way the IDE's
   * "Rebase Current onto Selected" does. It rewrites hashes, so the worktree
   * must be clean and no other sequencer may own HEAD.
   * @param {{ dir?: string, branch?: string }} input
   */
  async rebaseOnto(input = {}) {
    const branch = this.branchToken(input.branch)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const status = await readStatus(root)
      if (status.operation) throw new Error(`a ${status.operation} is already in progress`)
      if (status.files.some((file) => file.staged || file.unstaged)) throw new Error('rebase needs a clean worktree')
      const current = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      if (current === branch) throw new Error('cannot rebase a branch onto itself')
      const target = await runGit(root, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`], { allowFailure: true })
      if (target.code !== 0) throw new Error(`unknown branch: ${branch}`)
      const result = await runGit(root, ['rebase', branch], { allowFailure: true, timeoutMs: 180_000 })
      const output = [result.stdout, result.stderr].map((part) => part.trim()).filter(Boolean).join('\n')
      if (result.code !== 0) {
        const after = await readStatus(root)
        if (after.operation === 'rebase') {
          const conflicts = after.files.filter((file) => file.kind === 'conflicted').length
          return { ok: false, paused: true, conflicts, output }
        }
        throw new Error(output || 'git rebase failed')
      }
      return { ok: true, output }
    })
  }

  /** A branch-shaped argv token with no option or revision-range injection. */
  branchToken(value) {
    const branch = String(value ?? '').trim()
    if (branch.length === 0 || branch.length > 255 || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..')) {
      throw new Error(`invalid branch name: ${branch.slice(0, 40)}`)
    }
    return branch
  }

  /**
   * A ref-ish token that is safe as a single argv entry: no leading dash (that
   * would be option injection), no shell-ish noise, bounded length. `~` and `^`
   * stay legal because `HEAD~2` is how the UI asks for an ancestor.
   */
  refToken(value, what = 'ref') {
    const token = String(value ?? '').trim()
    if (token.length === 0 || token.length > 255 || token.startsWith('-') || !/^[A-Za-z0-9._/@{}+=:^~-]+$/.test(token)) {
      throw new Error(`invalid ${what}: ${token.slice(0, 40)}`)
    }
    return token
  }

  /** @returns {string[]} validated commit shas */
  shaList(value) {
    const list = (Array.isArray(value) ? value : [value]).map((item) => String(item ?? '').trim()).filter(Boolean)
    for (const sha of list) {
      if (!/^[0-9a-fA-F]{4,40}$/.test(sha)) throw new Error(`invalid commit sha: ${sha.slice(0, 40)}`)
    }
    if (list.length === 0) throw new Error('no commits selected')
    return list
  }

  /**
   * Order commits oldest first. A log lists newest first, but a cherry-pick
   * has to replay a stack in the order it was written, and a revert has to
   * undo it in that same order.
   */
  async chronological(root, shas) {
    if (shas.length < 2) return shas
    const result = await runGit(root, ['rev-list', '--reverse', '--no-walk', ...shas], { allowFailure: true })
    if (result.code !== 0) return shas
    const ordered = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    const known = new Set(ordered)
    // A sha the walk did not know keeps its place at the end instead of
    // silently vanishing from the batch.
    return [...ordered, ...shas.filter((sha) => !known.has(sha))]
  }

  /** Create a tag, optionally at `ref`; `force` moves an existing one. */
  async createTag(input = {}) {
    const name = this.refToken(input.name, 'tag name')
    const ref = input.ref ? this.refToken(input.ref) : ''
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const args = ['tag']
      if (input.force) args.push('-f')
      args.push(name)
      if (ref) args.push(ref)
      const result = await runGit(root, args, { allowFailure: true })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'git tag failed')
      return { ok: true, name }
    })
  }

  /** Delete local tags, and on that `remote` as well when one is given. */
  async deleteTag(input = {}) {
    const raw = Array.isArray(input.names) ? input.names : [input.name]
    const names = [...new Set(raw.map((item) => this.refToken(item, 'tag name')))]
    if (names.length === 0) throw new Error('no tags selected')
    const remote = input.remote ? this.refToken(input.remote, 'remote') : ''
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const local = await runGit(root, ['tag', '-d', ...names], { allowFailure: true })
      if (local.code !== 0) throw new Error(local.stderr.trim() || 'git tag -d failed')
      if (!remote) return { ok: true, removed: names.length }
      const pushed = await this.network(root, ['push', remote, '--delete', ...names.map((name) => `refs/tags/${name}`)])
      return { ok: true, removed: names.length, output: pushed.output }
    })
  }

  /** Publish a single tag without touching any branch. */
  async pushTag(input = {}) {
    const name = this.refToken(input.name, 'tag name')
    const root = await this.resolveDir(input.dir)
    const remote = input.remote ? this.remoteNameToken(input.remote) : await this.defaultRemote(root)
    return this.network(root, ['push', remote, `refs/tags/${name}:refs/tags/${name}`])
  }

  /** Detached checkout of any ref — the tag menu's "checkout". */
  async switchTo(input = {}) {
    const ref = this.refToken(input.ref)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const result = await runGit(root, ['switch', '--detach', ref], { allowFailure: true })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'git switch failed')
      return { ok: true, ref }
    })
  }

  /** Cherry-pick one or more commits onto the current branch. */
  async cherryPick(input = {}) {
    const hashes = this.shaList(input.hashes ?? input.hash)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const ordered = await this.chronological(root, hashes)
      const args = ['cherry-pick']
      if (input.noCommit) args.push('-n')
      args.push(...ordered)
      const result = await runGit(root, args, { allowFailure: true })
      // On a conflict the sequencer stays paused so the commit pane can show the
      // conflicted files; the message still explains what went wrong.
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'git cherry-pick failed')
      return { ok: true, picked: ordered.length }
    })
  }

  /** Revert a commit into a new commit, or stage the inverse with `noCommit`. */
  async revertCommit(input = {}) {
    const hashes = this.shaList(input.hashes ?? input.hash)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      // Undoing a batch means undoing the oldest one first, so the branch ends
      // up where it was before the whole selection.
      const ordered = await this.chronological(root, hashes)
      const args = ['revert', input.noCommit ? '--no-commit' : '--no-edit', ...ordered]
      const result = await runGit(root, args, { allowFailure: true })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'git revert failed')
      return { ok: true, reverted: ordered.length }
    })
  }

  /** Move HEAD: soft/mixed keep the working tree, hard throws it away. */
  async reset(input = {}) {
    const mode = String(input.mode ?? 'mixed')
    if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error(`invalid reset mode: ${mode.slice(0, 12)}`)
    const ref = this.refToken(input.ref ?? 'HEAD')
    if (mode === 'hard' && input.confirm !== true) {
      throw new Error('a hard reset needs an explicit confirmation')
    }
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const result = await runGit(root, ['reset', `--${mode}`, ref], { allowFailure: true })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'git reset failed')
      return { ok: true, mode, ref }
    })
  }

  async stashList(input = {}) {
    const root = await this.resolveDir(input.dir)
    // 不能带 `--date`：它会顺带改变 %gd/%gD 的渲染，把 stash@{0} 变成
    // stash@{日期}，`git stash pop <ref>` 就找不到储藏项了。短日期用 %as，
    // 它不受 --date 影响。
    const raw = await runGit(root, ['stash', 'list', '--pretty=format:%gd%x1f%H%x1f%an%x1f%as%x1f%s'], { allowFailure: true })
    return raw.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, hash, author, date, subject] = line.split('\u001f')
        return { ref, hash, author, date, subject }
      })
  }

  /**
   * @param {object} input
   * @param {string} [input.dir]
   * @param {'push'|'pop'|'apply'|'drop'} input.action
   * @param {string} [input.ref]
   * @param {string[]} [input.paths] push only: stash just these files
   */
  async stash(input) {
    const action = String(input.action ?? '')
    if (!['push', 'pop', 'apply', 'drop'].includes(action)) {
      throw new Error(`invalid stash action: ${action.slice(0, 20)}`)
    }
    const ref = typeof input.ref === 'string' ? input.ref.trim() : ''
    // argv 没有 shell 注入面，但 `-` 开头的 ref 会被 git 当成选项。
    if (ref.startsWith('-')) throw new Error(`invalid stash ref: ${ref.slice(0, 40)}`)
    const paths = action === 'push' && Array.isArray(input.paths) ? [...new Set(input.paths.map((file) => String(file)))] : []
    for (const file of paths) assertSafePath(file)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const args = ['stash', action]
      /** @type {string} */
      let indexFile = ''
      try {
        if (action === 'push') {
          // The shelf takes untracked files too — leaving them behind is the usual
          // "why did nothing get stashed" surprise. A message keeps the list readable.
          args.push('--include-untracked')
          const message = String(input.message ?? '').trim()
          if (message) args.push('--message', message)
          if (paths.length > 0) {
            // `git stash push -- <paths>` still writes the whole index into the
            // stash's second parent, so a staged file outside the selection is
            // captured by the entry and comes back on apply. Stashing through a
            // temporary index — HEAD outside the pathspec, the real entries
            // inside it — keeps the shelf limited to what was ticked.
            indexFile = path.join(tmpdir(), `dsh-stash-${process.pid}-${Date.now()}.index`)
            const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim()
            await copyFile(path.join(gitDir, 'index'), indexFile)
            const tempIndex = { GIT_INDEX_FILE: indexFile }
            await git(root, ['read-tree', 'HEAD'], { env: tempIndex })
            const listed = await git(root, ['ls-files', '-s', '-z', '--', ...paths])
            const entries = splitNul(listed)
            if (entries.length > 0) {
              await git(root, ['update-index', '-z', '--index-info'], { env: tempIndex, input: `${entries.join('\u0000')}\u0000` })
            }
            args.push('--', ...paths)
          }
        }
        if (ref) args.push(ref)
        const result = await runGit(root, args, { allowFailure: true, env: indexFile ? { GIT_INDEX_FILE: indexFile } : {} })
        if (result.code !== 0) throw new Error(result.stderr.trim() || `git stash ${action} failed`)
        if (paths.length > 0) {
          // The stash reverted the selected files' worktree, but the real index
          // still has them at their staged content: unstage just these paths.
          // An untracked path no longer has an index entry — reset reports it
          // and is skipped.
          for (const file of paths) await runGit(root, ['reset', '-q', 'HEAD', '--', file], { allowFailure: true })
        }
        return { ok: true, output: result.stdout }
      } finally {
        if (indexFile) await rm(indexFile, { force: true })
      }
    })
  }

  /**
   * `git stash show -p` skips the untracked third parent, so a shelf of brand
   * new files previews as empty. `--include-untracked` is what makes the
   * preview match what apply will really put back.
   * @param {string} root
   * @param {string} ref
   */
  async stashPatch(root, ref, full = false, ignoreWhitespace = false) {
    assertRev(ref)
    const context = `-U${full ? FULL_CONTEXT : 3}`
    const result = await runGit(root, ['stash', 'show', '-p', '--include-untracked', '--no-color', ...(ignoreWhitespace ? ['-w'] : []), context, ref], { allowFailure: true })
    if (result.code !== 0) throw new Error(result.stderr.trim() || `git stash show ${ref} failed`)
    return result.stdout
  }

  /**
   * Read-only preview of one stash: the same shape the commit view consumes.
   * @param {{ dir?: string, ref?: string }} input
   */
  async stashShow(input = {}) {
    const root = await this.resolveDir(input.dir)
    const ref = String(input.ref ?? '')
    const meta = (await this.stashList({ dir: root })).find((item) => item.ref === ref)
    if (!meta) throw new Error(`no such stash: ${ref}`)
    return { ...meta, files: scopeIds(parseDiff(await this.stashPatch(root, ref, false, input.ignoreWhitespace === true)), '') }
  }

  /**
   * One file out of a stash. `git stash show` takes no pathspec, so the whole
   * patch is parsed once and the file picked out of it.
   * @param {{ dir?: string, ref?: string, file?: string }} input
   */
  async stashFile(input = {}, options = {}) {
    const root = await this.resolveDir(input.dir)
    const file = String(input.file ?? '')
    assertSafePath(file)
    const files = parseDiff(await this.stashPatch(root, String(input.ref ?? ''), options.full, options.ignoreWhitespace === true))
    const parsed = files.find((item) => item.path === file || item.oldPath === file) ?? null
    if (!parsed) return { file, entry: null, staged: null, unstaged: null }
    return {
      file,
      entry: { kind: parsed.status, path: file, origPath: parsed.oldPath },
      staged: null,
      unstaged: { ...parsed, path: file },
    }
  }

  /**
   * @param {object} [input]
   * @param {string} [input.dir]
   */
  async untracked(input = {}) {
    const root = await this.resolveDir(input.dir)
    const raw = await runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { allowFailure: true })
    return raw.stdout.split('\u0000').filter((line) => line.startsWith('?? ')).map((line) => line.slice(3))
  }

  /**
   * Create a repository in a folder that has none. The panel only offers this
   * from the "not a git repository" empty state, but the guard lives here too:
   * a stale tab must not turn a second click into a nested repository, and a
   * folder inside an existing repo already belongs to that repo.
   * @param {{ dir?: string }} [input]
   */
  async initRepo(input = {}) {
    const candidate = String(input.dir ?? '').trim() || this.defaultDir
    if (!path.isAbsolute(candidate)) throw new Error(`init needs an absolute directory: ${candidate}`)
    const folder = await stat(candidate).catch(() => null)
    if (!folder || !folder.isDirectory()) throw new Error(`not a directory: ${candidate}`)
    return this.withWriteLock(async () => {
      const existing = await runGit(candidate, ['rev-parse', '--show-toplevel'], { allowFailure: true })
      // Already a repo (including a parent repo): report it as done so a stale
      // tab or a double click simply refreshes into the real repository.
      if (existing.code === 0) return { ok: true, root: existing.stdout.trim(), already: true }
      const result = await runGit(candidate, ['init', '-q'], { allowFailure: true })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'git init failed')
      const repo = await resolveRepo(candidate)
      return { ok: true, root: repo.root, gitDir: repo.gitDir }
    })
  }

  /**
   * Every configured remote with its fetch and push URLs. `git remote -v`
   * prints both sides; they differ only when the repo sets a push URL
   * explicitly, and the IDE shows both.
   * @param {string} [dir]
   */
  async listRemotes(dir) {
    const root = await this.resolveDir(dir)
    const raw = await runGit(root, ['remote', '-v'], { allowFailure: true })
    /** @type {Map<string, { name: string, url: string, pushUrl: string }>} */
    const out = new Map()
    for (const line of raw.stdout.split('\n')) {
      const match = /^(.+?)\s+(.+?)\s+\((fetch|push)\)$/.exec(line.trim())
      if (!match) continue
      const [, name, url, kind] = match
      const entry = out.get(name) ?? { name, url: '', pushUrl: '' }
      if (kind === 'fetch') entry.url = url
      else entry.pushUrl = url
      out.set(name, entry)
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * A remote name is an argv entry: a leading dash would be option injection,
   * and the IDE only ever deals in short identifiers.
   */
  remoteNameToken(value) {
    const name = String(value ?? '').trim()
    if (name.length === 0 || name.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new Error(`invalid remote name: ${name.slice(0, 40)}`)
    }
    return name
  }

  /**
   * A remote URL goes to git as one argv entry. It may be an https/ssh/git
   * URL, an scp-style `git@host:path`, or a local path — but never a leading
   * dash (option injection) and never anything with whitespace or control
   * characters in it.
   */
  remoteUrlToken(value) {
    const url = String(value ?? '').trim()
    if (url.length === 0 || url.length > 512 || url.startsWith('-') || [...url].some((ch) => ch.charCodeAt(0) <= 32)) {
      throw new Error(`invalid remote url: ${url.slice(0, 40)}`)
    }
    return url
  }

  /** Add a remote. Git refuses a duplicate name on its own. */
  async addRemote(input = {}) {
    const name = this.remoteNameToken(input.name)
    const url = this.remoteUrlToken(input.url)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const result = await runGit(root, ['remote', 'add', name, url], { allowFailure: true })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'git remote add failed')
      return { ok: true, name, url }
    })
  }

  /** Point an existing remote at a new URL. */
  async setRemoteUrl(input = {}) {
    const name = this.remoteNameToken(input.name)
    const url = this.remoteUrlToken(input.url)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const result = await runGit(root, ['remote', 'set-url', name, url], { allowFailure: true })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'git remote set-url failed')
      return { ok: true, name, url }
    })
  }

  /** Drop a remote. The refs it tracked stay until the next prune. */
  async removeRemote(input = {}) {
    const name = this.remoteNameToken(input.name)
    return this.withWriteLock(async () => {
      const root = await this.resolveDir(input.dir)
      const result = await runGit(root, ['remote', 'remove', name], { allowFailure: true })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'git remote remove failed')
      return { ok: true, name }
    })
  }

  /**
   * Serialize index-mutating operations.
   * @template T
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  async withWriteLock(work) {
    const run = this.writeQueue.then(work, work)
    this.writeQueue = run.catch(() => {})
    return run
  }
}

/**
 * Reject paths that could escape the worktree or be mistaken for a flag.
 * @param {string} file
 */
export function assertSafePath(file) {
  if (typeof file !== 'string' || file === '') throw new Error('missing file path')
  if (file.startsWith('-')) throw new Error(`refusing a path that looks like a flag: ${file}`)
  if (file.includes('\u0000')) throw new Error('path contains NUL')
  const normalized = path.posix.normalize(file.replaceAll('\\', '/'))
  if (normalized.startsWith('../') || normalized === '..') throw new Error(`path escapes the repository: ${file}`)
}

/**
 * Commits and revisions are passed as positional arguments, so they must not
 * look like options.
 * @param {string} rev
 */
export function assertRev(rev) {
  if (typeof rev !== 'string' || rev === '' || rev.startsWith('-') || rev.includes('\u0000') || /\s/.test(rev)) {
    throw new Error(`invalid revision: ${rev}`)
  }
}

/**
 * Local branch names for `git branch -m/-d`: no flags, no ref magic, no
 * trailing separators that git would reject anyway.
 * @param {unknown} value
 * @returns {string} the trimmed name
 */
export function assertBranchName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  const shape = /^[A-Za-z0-9._/-]+$/.test(name)
  if (!shape || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.lock') || name.includes('..') || name.includes('//')) {
    throw new Error(`invalid branch name: ${String(value).slice(0, 60)}`)
  }
  return name
}

/**
 * A remote-tracking branch: `remote/branch`. The remote half cannot contain a
 * slash, so the first one separates the two — `origin/feature/x` is the
 * branch `feature/x` on the remote `origin`.
 */
export function assertUpstreamName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  const remote = name.split('/')[0] ?? ''
  const branch = name.slice(remote.length + 1)
  const remoteOk = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)
  const branchOk = /^[A-Za-z0-9._/-]+$/.test(branch)
  if (!remoteOk || !branchOk || name.includes('..') || name.includes('//') || branch.endsWith('/') || branch.endsWith('.lock')) {
    throw new Error(`invalid upstream branch: ${String(value).slice(0, 60)}`)
  }
  return name
}

/** A ref for the compare view. Ranges and `^`/`@{}` walk-ins stay out. */
function assertCompareRef(value, fallback) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name === '') return fallback
  assertRev(name)
  if (name.includes('..') || name.includes('^') || name.includes('@{') || name.includes('~')) {
    throw new Error(`invalid revision: ${name.slice(0, 60)}`)
  }
  return name
}

export { parseDiff }
