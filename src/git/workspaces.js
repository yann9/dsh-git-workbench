/**
 * Workspace discovery.
 *
 * A Git panel inside an agent harness should not ask for a repository path:
 * the harness already knows which directories the user works in. This reads
 * that registry — the live service when it is mounted, the durable store
 * otherwise — and classifies each entry by whether it is a work tree.
 */

import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runGit } from './exec.js'

/**
 * @typedef {object} WorkspaceEntry
 * @property {string} id
 * @property {string} title
 * @property {string} path
 * @property {boolean} isRepo repository root found
 * @property {string | null} repoRoot
 * @property {string | null} branch
 * @property {number} updatedAt epoch ms (0 when unknown)
 */

/**
 * @param {any} ctx
 * @returns {Promise<WorkspaceEntry[]>}
 */
export async function listWorkspaces(ctx) {
  const raw = await readRegistry(ctx)
  /** @type {WorkspaceEntry[]} */
  const entries = []
  for (const workspace of raw) {
    const entry = await classify(workspace)
    entries.push(entry)
  }
  return entries.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title))
}

/**
 * Live service first: it is already loaded and ordered by the user's own
 * arrangement. The JSON store is the fallback for headless or early boot.
 * @param {any} ctx
 * @returns {Promise<{ id: string, title: string, path: string, updatedAt: number }[]>}
 */
async function readRegistry(ctx) {
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    if (registry && typeof registry.list === 'function') {
      return registry.list().map((entity) => ({
        id: String(entity.id ?? ''),
        title: String(entity.title ?? entity.name ?? path.basename(entity.path ?? '')),
        path: String(entity.path ?? ''),
        updatedAt: entity.updatedAt ? Date.parse(entity.updatedAt) : 0,
      }))
    }
  } catch {
    // fall through to the durable store
  }

  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const store = path.join(home, 'storages', 'workspace.json')
  try {
    const parsed = JSON.parse(await readFile(store, 'utf8'))
    const table = parsed?.tables?.workspaces ?? {}
    const order = parsed?.global?.workspaceIds ?? Object.keys(table)
    return order
      .map((id) => {
        const entity = table[id]
        if (!entity?.path) return null
        return {
          id: String(id),
          title: String(entity.title ?? path.basename(entity.path)),
          path: String(entity.path),
          updatedAt: entity.updatedAt ? Date.parse(entity.updatedAt) : 0,
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * @param {{ id: string, title: string, path: string, updatedAt: number }} workspace
 * @returns {Promise<WorkspaceEntry>}
 */
async function classify(workspace) {
  const result = await runGit(workspace.path, ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], {
    allowFailure: true,
    env: {},
  })
  if (result.code !== 0) {
    return { ...workspace, isRepo: false, repoRoot: null, branch: null }
  }
  const [root, branch] = result.stdout.trim().split('\n')
  return { ...workspace, isRepo: true, repoRoot: root, branch: branch === 'HEAD' ? null : branch }
}
