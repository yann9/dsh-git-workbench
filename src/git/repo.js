/**
 * Repository reads: identity, working-tree status, history, branches, blame.
 * Every parser here is written against a pinned git output format, so a
 * user's pager / color / quotePath configuration cannot change the shape.
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { splitNul, runGit } from './exec.js'

/**
 * @typedef {object} RepoInfo
 * @property {string} root absolute worktree root (git dir for bare repos)
 * @property {string} gitDir
 * @property {string} name
 * @property {boolean} bare
 * @property {boolean} unborn HEAD exists?
 */

/**
 * @typedef {object} StatusFile
 * @property {string} path repo-relative, forward slashes
 * @property {string | null} origPath rename/copy source
 * @property {string} index single-letter index state (`''` when clean)
 * @property {string} worktree single-letter worktree state (`''` when clean)
 * @property {'added'|'modified'|'deleted'|'renamed'|'copied'|'untracked'|'conflicted'|'typechange'} kind
 * @property {boolean} staged
 * @property {boolean} unstaged
 */

/**
 * @typedef {object} RepoStatus
 * @property {RepoInfo} repo
 * @property {string | null} branch
 * @property {string | null} upstream
 * @property {number} ahead
 * @property {number} behind
 * @property {boolean} detached
 * @property {boolean} merging `MERGE_HEAD` exists: a commit completes the merge
 * @property {'merge'|'rebase'|'cherry-pick'|'revert'|null} operation sequencer state that `--abort` can unwind
 * @property {StatusFile[]} files
 * @property {{ staged: number, unstaged: number, untracked: number, conflicted: number }} counts
 */

/**
 * @param {string} cwd
 * @returns {Promise<RepoInfo>}
 */
export async function resolveRepo(cwd) {
  // Repository identity never moves within a process; caching it turns the
  // nested resolveDir/readStatus calls in one panel request from 6 git spawns
  // into 0. `unborn` is the one volatile bit — computed from the filesystem
  // (HEAD + ref files) so the first commit flips it without a spawn.
  const key = path.resolve(cwd)
  let structure = cache.get(key)
  if (!structure) {
    const result = await runGit(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--is-bare-repository'], {
      allowFailure: true,
    })
    if (result.code !== 0) {
      throw new RepoNotFound(cwd, result.stderr)
    }
    const [rootLine, gitDirLine, bareLine] = result.stdout.trim().split('\n')
    const bare = bareLine === 'true'
    const root = bare ? gitDirLine : rootLine
    structure = { root, gitDir: gitDirLine, name: path.basename(root), bare }
    cache.set(key, structure)
  }
  return { ...structure, unborn: await isUnbornHead(structure.gitDir) }
}

/** @type {Map<string, { root: string, gitDir: string, name: string, bare: boolean }>} */
const cache = new Map()

/**
 * HEAD is unborn when it points at a ref nobody has created yet.
 * Same answer as `git rev-parse --verify HEAD`, without a process.
 * @param {string} gitDir
 */
async function isUnbornHead(gitDir) {
  try {
    const head = (await readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim()
    if (!head.startsWith('ref:')) return false
    const ref = head.slice(4).trim()
    try {
      await stat(path.join(gitDir, ref))
      return false
    } catch {
      // packed refs still count as existing
      const packed = await readFile(path.join(gitDir, 'packed-refs'), 'utf8')
      return !packed.split('\n').some((line) => line.endsWith(` ${ref}`))
    }
  } catch {
    return true
  }
}

export class RepoNotFound extends Error {
  /**
   * @param {string} cwd
   * @param {string} detail
   */
  constructor(cwd, detail) {
    super(`not a git repository: ${cwd}${detail ? ` (${detail.trim()})` : ''}`)
    this.name = 'RepoNotFound'
  }
}

/**
 * Would `git commit` be able to name an author?
 *
 * `git var GIT_AUTHOR_IDENT` is the check git itself runs before writing a
 * commit, so an identity that arrives from the environment is accepted here
 * too — reimplementing the lookup would disagree with git about the one case
 * that matters (an auto-detected hostname address git refuses to sign).
 * @param {string} root
 */
export async function hasAuthorIdentity(root) {
  const result = await runGit(root, ['var', 'GIT_AUTHOR_IDENT'], { allowFailure: true })
  return result.code === 0
}

/**
 * The values the identity dialog should start from. `scope` says where
 * `user.name` lives, so the dialog can default to the same level.
 * @param {string} root
 * @returns {Promise<{ configured: boolean, name: string, email: string, scope: 'local' | 'global' }>}
 */
export async function readIdentity(root) {
  const [configured, name, email, local] = await Promise.all([
    hasAuthorIdentity(root),
    runGit(root, ['config', '--get', 'user.name'], { allowFailure: true }),
    runGit(root, ['config', '--get', 'user.email'], { allowFailure: true }),
    runGit(root, ['config', '--local', '--get', 'user.name'], { allowFailure: true }),
  ])
  return {
    configured,
    name: name.stdout.trim(),
    email: email.stdout.trim(),
    scope: local.code === 0 ? 'local' : 'global',
  }
}

/**
 * `git status --porcelain=v2 --branch -z`, parsed into a flat file list.
 * @param {string} root
 * @returns {Promise<RepoStatus>}
 */
export async function readStatus(root) {
  const repo = await resolveRepo(root)
  const raw = await runGit(
    repo.root,
    ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignored=no'],
    { allowFailure: false },
  )

  /** @type {RepoStatus} */
  const status = {
    repo,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    merging: false,
    operation: null,
    files: [],
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  }

  const parts = splitNul(raw.stdout)
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]
    if (entry.startsWith('#')) {
      readBranchHeader(status, entry)
      continue
    }
    if (entry.startsWith('1 ')) {
      const fields = entry.split(' ')
      const xy = fields[1] ?? '..'
      status.files.push(makeFile(decode(fields.slice(8).join(' ')), null, xy, 'tracked'))
      continue
    }
    if (entry.startsWith('2 ')) {
      const fields = entry.split(' ')
      const xy = fields[1] ?? '..'
      const filePath = decode(fields.slice(9).join(' '))
      const origPath = parts[i + 1] !== undefined ? decode(parts[i + 1]) : null
      i += 1
      status.files.push(makeFile(filePath, origPath, xy, 'tracked'))
      continue
    }
    if (entry.startsWith('u ')) {
      const fields = entry.split(' ')
      const xy = fields[1] ?? '..'
      status.files.push(makeFile(decode(fields.slice(10).join(' ')), null, xy, 'conflicted'))
      continue
    }
    if (entry.startsWith('? ')) {
      status.files.push(makeFile(decode(entry.slice(2)), null, '??', 'untracked'))
      continue
    }
  }

  for (const file of status.files) {
    if (file.staged) status.counts.staged += 1
    if (file.unstaged) status.counts.unstaged += 1
    if (file.kind === 'untracked') status.counts.untracked += 1
    if (file.kind === 'conflicted') status.counts.conflicted += 1
  }

  // Resolving every conflict in favour of HEAD leaves an empty change list,
  // yet the merge still has to be committed. `git status` does not put that
  // state in porcelain v2, so read the marker git itself uses.
  status.operation = await readOperation(repo.gitDir)
  status.merging = status.operation === 'merge'

  return status
}

/**
 * Which paused sequencer, if any. The markers are the same ones `git status`
 * prints in its "You have ... in progress" hint; order matters because a
 * conflicted cherry-pick inside a rebase leaves both sets behind.
 * @param {string} gitDir
 * @returns {Promise<'merge'|'rebase'|'cherry-pick'|'revert'|null>}
 */
async function readOperation(gitDir) {
  const markers = /** @type {const} */ ([
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['revert-merge', 'revert'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
    ['MERGE_HEAD', 'merge'],
  ])
  for (const [marker, operation] of markers) {
    try {
      await stat(path.join(gitDir, marker))
      return operation
    } catch {
      /* not this one */
    }
  }
  return null
}

/**
 * @param {RepoStatus} status
 * @param {string} line
 */
function readBranchHeader(status, line) {
  const [key, ...rest] = line.slice(2).split(' ')
  const value = rest.join(' ')
  if (key === 'branch.oid') status.repo = { ...status.repo, unborn: value === '(initial)' }
  else if (key === 'branch.head') {
    status.detached = value === '(detached)'
    status.branch = status.detached ? null : value
  } else if (key === 'branch.upstream') status.upstream = value
  else if (key === 'branch.ab') {
    const match = /\+(-?\d+)\s+-(-?\d+)/.exec(value)
    if (match) {
      status.ahead = Number(match[1])
      status.behind = Number(match[2])
    }
  }
}

/**
 * @param {string} filePath
 * @param {string | null} origPath
 * @param {string} xy
 * @param {'tracked'|'untracked'|'conflicted'} source
 * @returns {StatusFile}
 */
function makeFile(filePath, origPath, xy, source) {
  const index = xy[0] === '.' ? '' : xy[0]
  const worktree = xy[1] === '.' ? '' : xy[1]
  let kind = 'modified'
  if (source === 'untracked') kind = 'untracked'
  else if (source === 'conflicted') kind = 'conflicted'
  // git only writes a `u` record for an unmerged path, but an index left half
  // resolved reports the same state through an ordinary record with a U side.
  else if (xy.includes('U') || xy === 'AA' || xy === 'DD') kind = 'conflicted'
  else if (index === 'R' || worktree === 'R') kind = 'renamed'
  else if (index === 'C' || worktree === 'C') kind = 'copied'
  else if (index === 'A') kind = 'added'
  else if (index === 'D' || worktree === 'D') kind = 'deleted'
  else if (index === 'T' || worktree === 'T') kind = 'typechange'
  const unmerged = kind === 'conflicted'
  return {
    path: filePath,
    origPath,
    index,
    worktree,
    kind,
    staged: source !== 'untracked' && !unmerged ? index !== '' : false,
    unstaged: source === 'untracked' || unmerged ? true : worktree !== '',
  }
}

/**
 * git prints paths relative to the worktree root and, with `-z`, raw bytes.
 * @param {string} value
 */
function decode(value) {
  return value.replaceAll('\\', '/')
}

/**
 * @typedef {object} LogEntry
 * @property {string} hash
 * @property {string[]} parents
 * @property {string} author
 * @property {string} email
 * @property {string} date ISO-8601 author date
 * @property {string} commitDate ISO-8601 committer date
 * @property {string} subject
 * @property {string[]} refs
 */

/**
 * Commit DAG for the graph view. `--date-order` keeps children above parents,
 * which is what the lane renderer assumes. `ref` scopes the walk to one branch
 * (SourceTree 的“查看此分支历史”); `rev` is kept as an alias for old callers.
 * @param {string} root
 * @param {{ limit?: number, all?: boolean, ref?: string, rev?: string, path?: string }} [options]
 * @returns {Promise<LogEntry[]>}
 */
export async function readLog(root, options = {}) {
  const { limit = 400, all = true, ref, rev, path } = options
  const scope = ref ?? rev
  const args = [
    'log',
    `--max-count=${clamp(limit, 1, 5000)}`,
    '--date-order',
    '--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%s%x1f%D%x1e',
  ]
  // Not `--all`: that walks refs/stash too, and its pseudo-commits
  // ("index on …", "untracked files on …") would litter the history. The shelf
  // has its own section in the branch popup, exactly like the IDE.
  if (all) args.push('--branches', '--remotes', '--tags')
  if (scope) args.push(scope)
  if (path) {
    // Rename tracking is the IDE's default for "Show History for File", but git
    // only follows a rename from one starting revision — combined with the
    // multi-ref walk above it silently returns nothing, so it stays off there.
    if (scope) args.push('--follow')
    args.push('--', String(path))
  }
  const raw = await runGit(root, args, { allowFailure: false })
  // Mark the commit HEAD points at so the UI can offer HEAD-only actions
  // (undo) without guessing from ref decorations, which omit a plain HEAD.
  const head = (await runGit(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true })).stdout.trim()
  return raw.stdout
    .split('\u001e')
    .map((chunk) => chunk.replace(/^\n/, ''))
    .filter(Boolean)
    .map(parseLogEntry)
    .map((entry) => ({ ...entry, head: head !== '' && entry.hash === head }))
}

/**
 * @param {string} chunk
 * @returns {LogEntry}
 */
function parseLogEntry(chunk) {
  const [hash, parents, author, email, date, commitDate, subject, refs] = chunk.split('\u001f')
  return {
    hash,
    parents: parents ? parents.split(' ') : [],
    author,
    email,
    date,
    commitDate,
    subject: subject ?? '',
    refs: (refs ?? '')
      .split(',')
      .map((ref) => ref.trim())
      .filter(Boolean),
  }
}

/**
 * @typedef {object} Branch
 * @property {string} name short name (`main`, `origin/main`)
 * @property {string} full full ref name
 * @property {string} hash
 * @property {boolean} current
 * @property {boolean} remote
 * @property {string | null} upstream
 * @property {string} subject
 */

/**
 * @param {string} root
 * @returns {Promise<{ local: Branch[], remote: Branch[] }>}
 */
export async function readBranches(root) {
  const format = ['%(refname)', '%(refname:short)', '%(objectname)', '%(HEAD)', '%(upstream:short)', '%(contents:subject)', '%(committerdate:unix)'].join('%1f')
  const raw = await runGit(root, ['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes'], { allowFailure: false })
  /** @type {{ local: Branch[], remote: Branch[] }} */
  const out = { local: [], remote: [] }
  for (const line of raw.stdout.split('\n')) {
    if (!line) continue
    const [full, name, hash, head, upstream, subject, date] = line.split('\u001f')
    if (name.endsWith('/HEAD')) continue
    const branch = {
      name,
      full,
      hash,
      current: head === '*',
      remote: full.startsWith('refs/remotes/'),
      upstream: upstream || null,
      subject: subject ?? '',
      date: Number(date) || 0,
    }
    if (branch.remote) out.remote.push(branch)
    else out.local.push(branch)
  }
  return out
}

/**
 * @typedef {object} BlameLine
 * @property {number} line 1-based line number in this revision
 * @property {string} hash
 * @property {string} author
 * @property {string} email
 * @property {number} time epoch ms
 * @property {string} summary
 * @property {string} text
 * @property {boolean} boundary
 */

/**
 * `git blame --line-porcelain`: one record per line, stable across locales.
 * @param {string} root
 * @param {string} file repo-relative
 * @param {string} [rev]
 * @returns {Promise<BlameLine[]>}
 */
export async function readBlame(root, file, rev) {
  const args = ['blame', '--line-porcelain']
  if (rev) args.push(rev)
  args.push('--', file)
  const raw = await runGit(root, args, { allowFailure: false, maxBytes: 64 * 1024 * 1024 })
  /** @type {BlameLine[]} */
  const lines = []
  /** @type {{ hash: string, author: string, email: string, time: number, summary: string, boundary: boolean, final: number } | null} */
  let current = null
  for (const line of raw.stdout.split('\n')) {
    if (line.startsWith('\t')) {
      if (current) {
        lines.push({ ...current, line: current.final, text: line.slice(1) })
      }
      current = null
      continue
    }
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line)
    if (header) {
      current = {
        hash: header[1],
        final: Number(header[2]),
        author: '',
        email: '',
        time: 0,
        summary: '',
        boundary: false,
      }
      continue
    }
    if (!current) continue
    if (line.startsWith('author ')) current.author = line.slice(7)
    else if (line.startsWith('author-mail ')) current.email = line.slice(12).replace(/^<|>$/g, '')
    else if (line.startsWith('author-time ')) current.time = Number(line.slice(12)) * 1000
    else if (line.startsWith('summary ')) current.summary = line.slice(8)
    else if (line.startsWith('boundary')) current.boundary = true
  }
  return lines
}

/**
 * File content at a revision, or the worktree file when `rev` is omitted.
 * @param {string} root
 * @param {string} file
 * @param {string} [rev]
 * @returns {Promise<string>}
 */
export async function readFileAt(root, file, rev) {
  if (!rev) return readFile(path.join(root, file), 'utf8')
  return runGit(root, ['show', `${rev}:${file}`], { allowFailure: false, maxBytes: 64 * 1024 * 1024 }).then((r) => r.stdout)
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}
