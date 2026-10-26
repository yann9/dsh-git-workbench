/**
 * Repository revision token + filesystem watch.
 *
 * The UI caches responses, so the cache needs a truth source that also sees
 * git operations this plugin did not perform — a commit in a terminal, a
 * stage in the IDE, a rebase by another tool. Two cheap mechanisms:
 *
 *  1. `revisionToken(root)` — HEAD sha + the mtime/size of the files git
 *     actually rewrites (index, packed-refs, refs/*). One `rev-parse`, no
 *     worktree scan; ~a few milliseconds, memoised for 200ms.
 *  2. `watchRepo(root, listener)` — fs.watch on `.git` so external writes
 *     invalidate the memo and reach connected clients within a debounce.
 */

import { stat, readdir, readFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const MEMO_MS = 200
function hashOf(parts) {
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)
}

async function statOrNull(target) {
  try {
    const info = await stat(target)
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return '-'
  }
}

/**
 * The git directory behind a work tree. `.git` may be a directory or a
 * `gitdir: …` pointer file (linked worktrees, submodules).
 * @param {string} root
 */
async function resolveGitDir(root) {
  const dotGit = path.join(root, '.git')
  try {
    const info = await stat(dotGit)
    if (info.isDirectory()) return dotGit
  } catch {
    return dotGit
  }
  try {
    const pointer = (await readFile(dotGit, 'utf8')).trim()
    const match = /^gitdir:\s*(.+)$/.exec(pointer)
    if (match) return path.resolve(root, match[1])
  } catch {
    /* fall through */
  }
  return dotGit
}

/**
 * HEAD's commit sha read from the filesystem (`HEAD` → loose ref or
 * `packed-refs`), or `''` while unborn. `git rev-parse` would cost a process
 * on every request; this is the same answer for a few stats.
 * @param {string} gitDir
 * @returns {Promise<string>}
 */
async function headSha(gitDir) {
  try {
    const head = (await readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim()
    if (!head.startsWith('ref:')) return head
    const ref = head.slice(4).trim()
    try {
      return (await readFile(path.join(gitDir, ref), 'utf8')).trim()
    } catch {
      const packed = await readFile(path.join(gitDir, 'packed-refs'), 'utf8')
      for (const line of packed.split('\n')) {
        if (line.endsWith(` ${ref}`)) return line.slice(0, 40)
      }
      return ''
    }
  } catch {
    return ''
  }
}

/**
 * HEAD's commit sha for a work tree, filesystem-only. `''` while unborn.
 * @param {string} root
 * @returns {Promise<string>}
 */
export async function readHead(root) {
  return headSha(await resolveGitDir(root))
}

/** Latest mtime/size across the loose ref tree (bounded walk). */
async function refsSignature(gitDir) {
  const roots = [path.join(gitDir, 'refs')]
  const parts = []
  let visited = 0
  while (roots.length > 0 && visited < 400) {
    const dir = roots.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited += 1
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) roots.push(full)
      else parts.push(`${entry.name}:${await statOrNull(full)}`)
    }
  }
  return hashOf(parts.sort())
}

/**
 * @param {string} root repository work tree
 * @param {string} [head] HEAD sha, when the caller already has it
 * @returns {Promise<string>}
 */
export async function revisionToken(root, head) {
  const gitDir = await resolveGitDir(root)
  const [index, packedRefs, headFile, refs, sha] = await Promise.all([
    statOrNull(path.join(gitDir, 'index')),
    statOrNull(path.join(gitDir, 'packed-refs')),
    statOrNull(path.join(gitDir, 'HEAD')),
    refsSignature(gitDir),
    head !== undefined ? head : headSha(gitDir),
  ])
  return hashOf([sha ?? '', index, packedRefs, headFile, refs])
}

/* ------------------------------------------------------------------ watch */

/** @type {Map<string, { watchers: Set<(root: string) => void>, timers: Set<() => void> }>} */
const watching = new Map()

/**
 * Watch `.git` for external writes. Renames (git writes temp files and moves
 * them) show up as directory events, so a single non-recursive watcher on the
 * git dir is enough; events are debounced because one commit touches many.
 * @param {string} root
 * @param {(root: string) => void} listener
 * @returns {() => void} disposer
 */
export function watchRepo(root, listener) {
  const cacheKey = path.join(root, '.git')
  let entry = watching.get(cacheKey)
  if (!entry) {
    entry = { watchers: new Set(), timers: new Set() }
    watching.set(cacheKey, entry)
    const fire = () => {
      const timer = setTimeout(() => {
        entry.timers.delete(release)
        for (const watcher of entry.watchers) watcher(root)
      }, 150)
      const release = () => clearTimeout(timer)
      entry.timers.add(release)
    }
    // The work tree is watched recursively so edits made outside this plugin
    // (terminal, IDE, another tool) reach connected clients too; git itself is
    // covered by the git-dir watchers. resolveGitDir handles linked worktrees
    // and submodules, where `.git` is a pointer file rather than a directory.
    void resolveGitDir(root).then((gitDir) => {
      const targets = [gitDir, path.join(gitDir, 'refs'), path.join(gitDir, 'refs', 'heads')]
      try {
        const tree = watch(root, { recursive: true }, () => fire())
        entry.timers.add(() => tree.close())
      } catch {
        // Node without recursive watching: git operations are still covered.
      }
      for (const target of targets) {
        try {
          const handle = watch(target, () => fire())
          const closer = () => handle.close()
          entry.timers.add(closer)
        } catch {
          // A missing directory (bare layout, packed-only refs) is not fatal.
        }
      }
    }).catch(() => {})
  }
  entry.watchers.add(listener)
  return () => {
    entry.watchers.delete(listener)
    if (entry.watchers.size === 0) {
      for (const release of entry.timers) {
        try {
          release()
        } catch {
          /* ignore */
        }
      }
      watching.delete(cacheKey)
    }
  }
}
