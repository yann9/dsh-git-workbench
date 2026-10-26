/**
 * Tool bootstrap.
 *
 * `@deepseek-ai/dsh-tools` is resolved from the harness closure, not from this
 * package's own node_modules, so it is imported lazily: a missing symbol must
 * degrade to "no model tools", never to "the Git panel does not load".
 */

export async function bootTools(ctx, service) {
  if (ctx.tools === undefined) return
  let defineTool
  try {
    ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch (error) {
    ctx.logger?.warn?.('git-workbench: @deepseek-ai/dsh-tools is unavailable, skipping model tools')
    return
  }
  if (typeof defineTool !== 'function') return
  const { registerTools } = await import('./tools.js')
  registerTools(ctx, service, defineTool)
}
