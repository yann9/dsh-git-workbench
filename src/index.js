/**
 * dsh-git-workbench — host half.
 *
 * Owns the Git engine and exposes it twice: an origin-relative HTTP surface
 * for the workbench UI (`/dsh-git`), and structured tools for the model. The
 * browser half lives in `src/client/browser.js` and is discovered through
 * `package.json#dsh.client`.
 */

import { GitService } from './git/service.js'
import { registerRoutes } from './http/routes.js'
import { bootTools } from './tools-boot.js'

export const name = 'git-workbench'
export const inject = ['webServer']

/**
 * @param {any} ctx
 * @param {{ repoPath?: string, readOnly?: boolean, maxLog?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const service = new GitService({
    defaultDir: config.repoPath && config.repoPath.trim() !== '' ? config.repoPath : undefined,
    maxLog: config.maxLog ?? 400,
  })

  ctx.effect(
    () => registerRoutes(ctx.webServer, service, { readOnly: config.readOnly === true, ctx, config }),
    'git-workbench: /dsh-git routes',
  )

  // Tools are optional: a profile without the tools service still gets the UI.
  bootTools(ctx, service).catch((error) => {
    ctx.logger?.warn?.(`git-workbench: tool registration failed: ${error instanceof Error ? error.message : error}`)
  })

  ctx.logger?.info?.(`git-workbench: workbench available at /dsh-git (repo: ${service.defaultDir})`)
}

export { GitService }
