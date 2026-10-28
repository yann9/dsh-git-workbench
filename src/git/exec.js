/**
 * Git process runner.
 *
 * Every invocation is an argv array: no shell ever parses an argument, so a
 * path containing `"`, `$(...)`, `%PATH%` or a newline is just a path. Reads
 * and writes both go through here; the caller decides which one it is.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * Process-spawn counter. Windows process creation is the dominant cost of a
 * panel refresh, so the tests assert on it: a diff open must not quietly grow
 * from 3 git calls to 10 again.
 */
export const gitStats = { spawns: 0 }

/**
 * Ring buffer behind the Git tool window's Console tab. Entries are argv
 * arrays, never shell strings; output is clipped so a dozen noisy commands
 * cannot pin megabytes in the host process.
 */
export const CONSOLE_LIMIT = 200
const CONSOLE_TEXT_LIMIT = 12000
const consoleEntries = []
let consoleSeq = 0

function clipOutput(value) {
  const text = String(value ?? '')
  if (text.length <= CONSOLE_TEXT_LIMIT) return text
  return `${text.slice(0, CONSOLE_TEXT_LIMIT)}\n… (${text.length - CONSOLE_TEXT_LIMIT} more characters)`
}

/**
 * Recent git invocations, newest first. `root` scopes the list to one working
 * tree — the Console tab must not show another repository's commands.
 * @param {string} [root]
 */
export function readGitConsole(root) {
  const base = root ? platformKey(root) : ''
  return consoleEntries
    .filter((entry) => {
      if (!base) return true
      const relative = path.relative(base, platformKey(entry.cwd))
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    })
    .slice()
    .reverse()
}

/**
 * Drop one repository's console history. Returns how many entries went away.
 * @param {string} root
 */
export function clearGitConsole(root) {
  const base = platformKey(root)
  let removed = 0
  for (let index = consoleEntries.length - 1; index >= 0; index -= 1) {
    const relative = path.relative(base, platformKey(consoleEntries[index].cwd))
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      consoleEntries.splice(index, 1)
      removed += 1
    }
  }
  return removed
}

function platformKey(value) {
  const resolved = path.resolve(value)
  // Windows paths are case-insensitive; a different drive-letter case must
  // not hide every entry from the panel.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function openConsoleEntry(cwd, args) {
  const entry = {
    id: ++consoleSeq,
    at: new Date().toISOString(),
    cwd,
    args: [...args],
    code: null,
    ms: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
  }
  consoleEntries.push(entry)
  if (consoleEntries.length > CONSOLE_LIMIT) consoleEntries.splice(0, consoleEntries.length - CONSOLE_LIMIT)
  return entry
}

/** Non-interactive, locale-stable, color-free git. Always applied. */
const BASE_ARGS = [
  '--no-pager',
  '-c', 'core.quotepath=false',
  '-c', 'color.ui=false',
  '-c', 'diff.noprefix=false',
  '-c', 'apply.whitespace=nowarn',
]

/**
 * Ambient variables that would make git behave differently than the user
 * expects inside an agent session (or try to open an editor / credential UI).
 */
const SCRUBBED = ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER', 'GIT_EXTERNAL_DIFF', 'GIT_INDEX_FILE']

/**
 * @typedef {object} GitResult
 * @property {number} code exit status (128 for git-level failure, -1 when spawn failed)
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {object} GitOptions
 * @property {string} [input] fed to stdin (patches), then closed
 * @property {number} [maxBytes] stdout cap; exceeding it rejects
 * @property {boolean} [allowFailure] return the result instead of throwing
 * @property {Record<string, string>} [env]
 * @property {number} [timeoutMs] kill the process after this long (network ops)
 */

export class GitError extends Error {
  /**
   * @param {string} message
   * @param {GitResult & { argv: string[] }} result
   */
  constructor(message, result) {
    super(message)
    this.name = 'GitError'
    this.code = result.code
    this.stdout = result.stdout
    this.stderr = result.stderr
    this.argv = result.argv
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {GitOptions} [options]
 * @returns {Promise<GitResult>}
 */
export function runGit(cwd, args, options = {}) {
  const { input, maxBytes = 32 * 1024 * 1024, allowFailure = true, env = {}, timeoutMs = 0 } = options
  const argv = [...BASE_ARGS, ...args]
  const trace = openConsoleEntry(cwd, args)
  const started = Date.now()

  return new Promise((resolve, reject) => {
    /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
    let child
    try {
      gitStats.spawns += 1
      child = spawn('git', argv, {
        cwd,
        env: childEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      trace.code = -1
      trace.ms = Date.now() - started
      trace.stderr = clipOutput(error?.message ?? String(error))
      reject(error)
      return
    }

    let timedOut = false
    let timer = null
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return
        timedOut = true
        trace.timedOut = true
        killTree(child)
        // `close` may never come when a grandchild (ssh, git-remote-https)
        // keeps the pipes open, so settle here instead of waiting for it —
        // the caller may hold the write lock.
        fail(new GitError(`git ${args[0]}: timed out after ${timeoutMs}ms`, {
          code: -1,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: 'timeout',
          argv,
        }))
      }, timeoutMs)
      timer.unref?.()
    }

    /** @type {Buffer[]} */
    const out = []
    /** @type {Buffer[]} */
    const err = []
    let outBytes = 0
    let settled = false

    const fail = (error) => {
      if (settled) return
      settled = true
      trace.code = -1
      trace.ms = Date.now() - started
      trace.stdout = clipOutput(Buffer.concat(out).toString('utf8'))
      trace.stderr = clipOutput(error?.message ?? String(error))
      reject(error)
    }

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes > maxBytes) {
        child.kill()
        fail(new Error(`git ${args[0]}: output exceeded ${maxBytes} bytes`))
        return
      }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (err.length < 512) err.push(chunk)
    })
    child.on('error', fail)
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (settled) return
      settled = true
      trace.code = timedOut ? -1 : code ?? -1
      trace.ms = Date.now() - started
      trace.timedOut = timedOut
      trace.stdout = clipOutput(Buffer.concat(out).toString('utf8'))
      trace.stderr = clipOutput(timedOut ? 'timeout' : Buffer.concat(err).toString('utf8'))
      if (timedOut) {
        reject(new GitError(`git ${args[0]}: timed out after ${timeoutMs}ms`, { code: -1, stdout: Buffer.concat(out).toString('utf8'), stderr: 'timeout', argv }))
        return
      }
      const result = {
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        argv,
      }
      if (result.code !== 0 && !allowFailure) {
        reject(new GitError(formatGitFailure(args, result), result))
        return
      }
      resolve(result)
    })

    if (input !== undefined) child.stdin.end(input, 'utf8')
    else child.stdin.end()
  })
}

/**
 * Run git and throw with a readable message on a non-zero exit.
 * @param {string} cwd
 * @param {string[]} args
 * @param {GitOptions} [options]
 * @returns {Promise<string>}
 */
export async function git(cwd, args, options = {}) {
  const result = await runGit(cwd, args, { ...options, allowFailure: false })
  return result.stdout
}

/**
 * @param {Record<string, string>} extra
 * @returns {NodeJS.ProcessEnv}
 */
function childEnv(extra) {
  const env = { ...process.env }
  for (const key of SCRUBBED) delete env[key]
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    LANG: 'C',
    GIT_ASKPASS: 'echo',
    GIT_OPTIONAL_LOCKS: '0',
    ...extra,
  }
}

/**
 * @param {string[]} args
 * @param {GitResult} result
 */
function formatGitFailure(args, result) {
  const detail = (result.stderr || result.stdout).trim()
  /** @type {string[]} */
  const lines = detail.split('\n').slice(0, 12)
  return `git ${args.filter((a) => !a.startsWith('-c') && !a.startsWith('--no-pager')).join(' ')} failed (exit ${result.code})${lines.length ? `: ${lines.join('\n')}` : ''}`
}

/**
 * Kill a child and everything it spawned. On Windows git's remote helpers
 * (ssh, git-remote-https) are separate processes that outlive `child.kill()`
 * and keep the pipes open.
 * @param {import('node:child_process').ChildProcess} child
 */
export function killTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/**
 * Split NUL-separated porcelain output.
 * @param {string} value
 * @returns {string[]}
 */
export function splitNul(value) {
  return value.split('\u0000').filter((part) => part !== '')
}
