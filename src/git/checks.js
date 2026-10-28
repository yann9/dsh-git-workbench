/**
 * Pre-commit checks: the repository's own package scripts, run before a commit.
 *
 * Only names discovered in the working tree's package.json are accepted, and
 * the package manager is spawned as an argv array — the caller supplies a
 * script name, never a command line.
 */

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { killTree } from './exec.js'

/** Scripts that start a server or watch loop: a check run would never finish. */
const LONG_RUNNING = /^(start|dev|serve|watch|preview|storybook)(:|$)/i

const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/
const SCRIPT_LIMIT = 40
const COMMAND_DISPLAY = 160
const TIMEOUT_MS = 120_000
const OUTPUT_LIMIT = 120_000
const MANAGERS = ['npm', 'pnpm', 'yarn', 'bun']

/**
 * @param {string} root
 * @returns {Promise<{ root: string, manager: string, scripts: { name: string, command: string }[], reason: string }>}
 */
export async function readPackageChecks(root) {
  let raw
  try {
    raw = await readFile(path.join(root, 'package.json'), 'utf8')
  } catch {
    return { root, manager: 'npm', scripts: [], reason: 'no-package' }
  }
  let pkg
  try {
    pkg = JSON.parse(raw)
  } catch {
    return { root, manager: 'npm', scripts: [], reason: 'invalid-package' }
  }
  const table = pkg?.scripts
  const scripts = []
  if (table && typeof table === 'object' && !Array.isArray(table)) {
    for (const [name, command] of Object.entries(table)) {
      if (scripts.length >= SCRIPT_LIMIT) break
      if (typeof command !== 'string' || command.trim() === '') continue
      // The name becomes an argv element, but a bound keeps it to something a
      // package manager will actually resolve (and keeps the menu readable).
      if (!SCRIPT_NAME.test(name) || LONG_RUNNING.test(name)) continue
      scripts.push({ name, command: command.trim().slice(0, COMMAND_DISPLAY) })
    }
  }
  return {
    root,
    manager: await detectManager(root, pkg),
    scripts,
    reason: scripts.length > 0 ? 'ok' : 'no-scripts',
  }
}

/**
 * Lock files beat a default; `packageManager` (Corepack) beats both.
 * @param {string} root
 * @param {any} pkg
 */
async function detectManager(root, pkg) {
  const declared = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : ''
  if (MANAGERS.includes(declared)) return declared
  for (const [file, manager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
  ]) {
    try {
      await stat(path.join(root, file))
      return manager
    } catch {
      /* try the next lock file */
    }
  }
  return 'npm'
}

/** Windows package managers are `.cmd` shims; spawning them needs the suffix. */
function managerBinary(manager) {
  if (process.platform !== 'win32') return manager
  return manager === 'bun' ? 'bun.exe' : `${manager}.cmd`
}

/**
 * @param {string} root
 * @param {string} script
 * @returns {Promise<{ ok: boolean, script: string, command: string, manager: string, code: number, ms: number, timedOut: boolean, truncated: boolean, output: string }>}
 */
export async function runPackageCheck(root, script) {
  const discovery = await readPackageChecks(root)
  const entry = discovery.scripts.find((item) => item.name === script)
  if (!entry) throw new Error(`unknown check script: ${String(script ?? '')}`)
  const started = Date.now()
  const win = process.platform === 'win32'
  const command = `${discovery.manager} run ${script}`
  // Windows npm/pnpm/yarn are .cmd shims, which Node cannot spawn directly.
  // cmd.exe gets one verbatim command line built from the fixed manager name
  // and the SCRIPT_NAME-validated script — never from caller-shaped text.
  const file = win ? process.env.ComSpec || 'cmd.exe' : managerBinary(discovery.manager)
  const args = win ? ['/d', '/s', '/c', `${managerBinary(discovery.manager)} run ${script}`] : ['run', script]

  return new Promise((resolve, reject) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child
    try {
      child = spawn(file, args, {
        windowsVerbatimArguments: win,
        cwd: root,
        env: {
          ...process.env,
          // Checks run from a panel: never let a tool open a watch prompt or
          // decorate output with ANSI colour the dialog cannot render.
          CI: '1',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          TERM: 'dumb',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX: its own group, so a timeout can kill the whole pipeline.
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      reject(error)
      return
    }

    /** @type {Buffer[]} */
    const chunks = []
    let bytes = 0
    let truncated = false
    let timedOut = false
    let outputTimer = null

    const collect = (chunk) => {
      if (bytes + chunk.length > OUTPUT_LIMIT) {
        const room = Math.max(0, OUTPUT_LIMIT - bytes)
        if (room > 0) chunks.push(chunk.subarray(0, room))
        bytes = OUTPUT_LIMIT
        truncated = true
        return
      }
      bytes += chunk.length
      chunks.push(chunk)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    if (TIMEOUT_MS > 0) {
      outputTimer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, TIMEOUT_MS)
      outputTimer.unref?.()
    }

    let settled = false
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (outputTimer) clearTimeout(outputTimer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (outputTimer) clearTimeout(outputTimer)
      const output = Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n')
      const exit = timedOut ? -1 : code ?? -1
      resolve({
        ok: exit === 0,
        script,
        command,
        manager: discovery.manager,
        code: exit,
        ms: Date.now() - started,
        timedOut,
        truncated,
        output: truncated ? `${output}\n… (output capped at ${OUTPUT_LIMIT} characters)` : output,
      })
    })
  })
}
