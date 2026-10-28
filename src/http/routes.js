/**
 * HTTP surface.
 *
 * One prefix route owns the JSON API. Nothing here trusts the caller: every
 * write validates its path/rev, bodies are size-capped, and cross-origin
 * requests are refused because the API runs git in the user's worktree.
 */

export const BASE_PATH = '/dsh-git'

/**
 * Server-side response memo, keyed by the repository revision. Unlike a TTL
 * cache it cannot go stale: when the revision changes — by this plugin, a
 * terminal, an IDE — the key changes and the entry simply stops being used.
 * @type {Map<string, unknown>}
 */
const responseMemo = new Map()
const MEMO_LIMIT = 200

/**
 * Which GET endpoints the revision fully describes.
 *
 * `volatile: true` means the answer can change without the revision changing
 * (working-tree edits, reflog/stash rewrites, the workspace registry,
 * `.git/config`), so it is never memoised and never short-circuited with 304.
 * The default for anything not listed here is volatile — forgetting to
 * classify a new endpoint must degrade to "always fresh", never to stale.
 * @type {Map<string, { volatile: boolean }>}
 */
/** Find our own entry in the cordis tree (ids are assigned by the loader). */
function findOwnEntry(loader) {
  if (!loader || typeof loader.entries !== 'function') return null
  try {
    for (const entry of loader.entries()) {
      const name = entry?.options?.name
      if (typeof name === 'string' && name.includes('dsh-git-workbench')) return entry
    }
  } catch {
    /* a broken tree must not take the endpoint down */
  }
  return null
}

/** The config shape, with defaults — one place for GET, POST and validation. */
const CONFIG_KEYS = [
  'branchPattern',
  'diffFullFile',
  'diffWrap',
  'diffFoldThreshold',
  'diffSideBySide',
  'listMode',
  'confirmDirtySwitch',
  'readOnly',
  'commitLanguage',
  'llmProvider',
  'llmModel',
  'maxLog',
]

function publicConfig(source = {}) {
  return {
    branchPattern: str(source.branchPattern, 'session/{date}-{time}'),
    diffFullFile: bool(source.diffFullFile, true),
    diffWrap: bool(source.diffWrap, true),
    diffFoldThreshold: num(source.diffFoldThreshold, 8, 2, 500),
    diffSideBySide: bool(source.diffSideBySide, true),
    listMode: ['flat', 'tree', 'last'].includes(source.listMode) ? source.listMode : 'last',
    confirmDirtySwitch: bool(source.confirmDirtySwitch, true),
    readOnly: bool(source.readOnly, false),
    commitLanguage: ['auto', 'zh', 'en'].includes(source.commitLanguage) ? source.commitLanguage : 'auto',
    llmProvider: str(source.llmProvider, ''),
    llmModel: str(source.llmModel, ''),
    maxLog: num(source.maxLog, 400, 1, 5000),
  }
}

/** Merge a client patch over the current config, ignoring unknown keys. */
function normalizeConfig(current = {}, patch = {}) {
  const merged = { ...current }
  for (const key of CONFIG_KEYS) if (patch && key in patch) merged[key] = patch[key]
  return publicConfig(merged)
}

/** Config values arrive from YAML: coerce them instead of trusting the shape. */
function str(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}
/**
 * Whole-file context is a host setting. Every hunk/line index a caller sends
 * was counted from the diff the panel rendered, so the host must parse it the
 * same way unless the caller states its own answer.
 */
function wantsFull(explicit, config) {
  if (explicit === true || explicit === '1') return true
  if (explicit === false || explicit === '0') return false
  return bool(config?.diffFullFile, true)
}
function num(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback
}

const GET_ROUTES = new Map([
  ['/rev', { volatile: false }],
  ['/info', { volatile: true }], // remotes live in .git/config, which the revision does not track
  ['/status', { volatile: true }],
  ['/console', { volatile: true }], // a log of processes, not repository state
  ['/checks', { volatile: true }], // package.json is not tracked by the git revision
  ['/identity', { volatile: true }], // user.name / user.email live in .git/config or the environment
  ['/overview', { volatile: true }],
  ['/turn', { volatile: false }], // immutable per session event
  ['/workspaces', { volatile: true }], // the registry is not git state at all
  ['/config', { volatile: false }], // static for the plugin's lifetime
  ['/diff', { volatile: true }],
  ['/file', { volatile: true }],
  ['/commit-file', { volatile: false }],
  ['/log', { volatile: false }],
  ['/compare', { volatile: false }],
  ['/commit', { volatile: false }],
  ['/message', { volatile: false }],
  ['/branches', { volatile: true }], // the upstream of a branch lives in .git/config
  ['/blame', { volatile: true }],
  ['/stash', { volatile: true }], // refs/stash is rewritten in place
  ['/stash-show', { volatile: true }],
  ['/stash-file', { volatile: true }],
  ['/untracked', { volatile: true }],
  ['/rebase-plan', { volatile: false }],
])

function memoPut(key, value) {
  if (responseMemo.size >= MEMO_LIMIT) responseMemo.delete(responseMemo.keys().next().value)
  responseMemo.set(key, value)
}

/** On a hit, re-insert so hot entries survive the FIFO eviction order. */
function memoGet(key) {
  const value = responseMemo.get(key)
  if (value !== undefined) {
    responseMemo.delete(key)
    responseMemo.set(key, value)
  }
  return value
}

const MAX_BODY = 2 * 1024 * 1024

/**
 * @param {import('../git/service.js').GitService} service
 * @param {{ repoPath?: string, readOnly?: boolean, ctx?: any, config?: any }} [options]
 */
export function createHandler(service, options = {}) {
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  return async function handle(req, res) {
    try {
      if (!originAllowed(req)) {
        sendJson(res, 403, { error: 'cross-origin request refused' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(BASE_PATH)) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const route = url.pathname.slice(BASE_PATH.length) || '/'

      if (route.startsWith('/api/')) {
        await handleApi(req, res, route.slice('/api'.length), url, service, options)
        return
      }
      // The workbench UI lives in the host as a plugin bundle; there are no
      // static assets under this prefix any more.
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = Number(/** @type {any} */ (error)?.statusCode) || 500
      if (!res.headersSent) sendJson(res, status, { error: message })
      else res.end()
    }
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} route
 * @param {URL} url
 * @param {import('../git/service.js').GitService} service
 * @param {{ readOnly?: boolean }} options
 */
async function handleApi(req, res, route, url, service, options) {
  const method = req.method ?? 'GET'
  const dir = url.searchParams.get('dir') ?? undefined

  if (method === 'GET') {
    // Server-sent events: external git operations reach the browser without
    // any polling by the client.
    if (route === '/events') {
      const opened = await service.revision({ dir })
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-git-rev': opened.rev,
      })
      res.write(`event: open\ndata: ${JSON.stringify({ rev: opened.rev })}\n\n`)
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
      const dispose = service.onRepoChange(opened.root, async () => {
        // The revision is memoised for 200ms; drop it so a watcher firing right
        // after a write sees the new state.
        service.revisions.delete(opened.root)
        const next = await service.revision({ dir }).catch(() => null)
        if (next) res.write(`event: change\ndata: ${JSON.stringify({ rev: next.rev })}\n\n`)
      })
      req.on('close', () => {
        clearInterval(ping)
        dispose()
      })
      return
    }

    // The revision is only an ETag: a route must still answer when there is no
    // repository behind the default dir yet (`/workspaces` is how the client
    // finds one in the first place). No revision → no cache, no 304.
    let rev = ''
    let revKnown = false
    try {
      const resolved = await service.revision({ dir })
      rev = resolved.rev
      revKnown = true
    } catch {
      /* no repository yet: the route itself decides whether that is an error */
    }
    if (rev) res.setHeader('x-git-rev', rev)
    // Unknown routes default to volatile: a new endpoint must never be served
    // stale just because nobody classified it.
    const volatile = GET_ROUTES.get(route)?.volatile !== false || !revKnown
    // Conditional GET: the client already holds this revision — 304, no body.
    // Only for answers the revision fully describes.
    if (!volatile && url.searchParams.get('rev') === rev) {
      res.writeHead(304)
      res.end()
      return
    }
    const memoKey = `${rev}|${route}|${url.searchParams.toString()}`
    if (!volatile) {
      const memoHit = memoGet(memoKey)
      if (memoHit !== undefined) {
        sendJson(res, 200, memoHit)
        return
      }
    }
    /** Memoised send: identical request at the same revision costs one git call. */
    const send = (payload) => {
      if (!volatile) memoPut(memoKey, payload)
      sendJson(res, 200, payload)
    }

    switch (route) {
      case '/rev':
        send({ rev })
        return
      case '/info':
        send(await service.info(dir))
        return
      case '/status':
        send(await service.status(dir))
        return
      case '/console':
        send(await service.console({ dir }))
        return
      case '/checks':
        send(await service.checks(dir))
        return
      case '/identity':
        send(await service.identity(dir))
        return
      case '/overview':
        send(await service.overview(dir))
        return
      case '/turn': {
        const { readTurn } = await import('../git/turns.js')
        send(await readTurn(options.ctx, {
          session: url.searchParams.get('session') ?? '',
          seq: url.searchParams.get('seq') ?? '',
          // Delivery cards count their own file list; the snapshot counts the
          // turn's. The server bridges the two, so it needs both coordinates.
          index: url.searchParams.get('index') ?? '',
        }))
        return
      }
      case '/workspaces': {
        const { listWorkspaces } = await import('../git/workspaces.js')
        send({ workspaces: await listWorkspaces(options.ctx) })
        return
      }
      case '/config':
        // Every knob the client honours, with the host's defaults filled in so
        // the UI never has to guess what "unset" means.
        send(publicConfig(options.config))
        return
      case '/diff':
        send(await service.diff({
          dir,
          file: url.searchParams.get('file') ?? undefined,
          staged: url.searchParams.get('staged') === '1',
          rev: url.searchParams.get('rev') ?? undefined,
          ignoreWhitespace: url.searchParams.get('ignoreWhitespace') === '1',
        }))
        return
      case '/file':
        send(await service.fileDiff(dir, url.searchParams.get('file') ?? '', {
          full: wantsFull(url.searchParams.get('full'), options.config),
          ignoreWhitespace: url.searchParams.get('ignoreWhitespace') === '1',
        }))
        return
      case '/commit-file':
        send(await service.commitFile(dir, url.searchParams.get('sha') ?? '', url.searchParams.get('file') ?? '', {
          full: wantsFull(url.searchParams.get('full'), options.config),
          ignoreWhitespace: url.searchParams.get('ignoreWhitespace') === '1',
        }))
        return
      case '/log':
        send(await service.log({
          dir,
          ref: url.searchParams.get('ref') ?? undefined,
          path: url.searchParams.get('path') ?? undefined,
          limit: Number(url.searchParams.get('limit') ?? '') || undefined,
          all: url.searchParams.get('all') !== '0',
        }))
        return
      case '/compare':
        send(await service.compare({
          dir,
          left: url.searchParams.get('left') ?? undefined,
          right: url.searchParams.get('right') ?? undefined,
          limit: Number(url.searchParams.get('limit') ?? '') || undefined,
        }))
        return
      case '/commit':
        send(await service.showCommit({ dir, sha: url.searchParams.get('sha') ?? '', ignoreWhitespace: url.searchParams.get('ignoreWhitespace') === '1' }))
        return
      case '/message':
        send(await service.commitMessage({ dir, rev: url.searchParams.get('rev') ?? undefined }))
        return
      case '/branches':
        send(await service.branches(dir))
        return
      case '/remotes':
        send({ remotes: await service.listRemotes(dir) })
        return
      case '/blame':
        send(await service.blame({
          dir,
          file: url.searchParams.get('file') ?? '',
          rev: url.searchParams.get('rev') ?? undefined,
        }))
        return
      case '/stash':
        send(await service.stashList({ dir }))
        return
      case '/stash-show':
        send(await service.stashShow({ dir, ref: url.searchParams.get('ref') ?? '', ignoreWhitespace: url.searchParams.get('ignoreWhitespace') === '1' }))
        return
      case '/stash-file':
        send(await service.stashFile(
          { dir, ref: url.searchParams.get('ref') ?? '', file: url.searchParams.get('file') ?? '' },
          { full: wantsFull(url.searchParams.get('full'), options.config), ignoreWhitespace: url.searchParams.get('ignoreWhitespace') === '1' },
        ))
        return
      case '/untracked':
        send(await service.untracked({ dir }))
        return
      case '/rebase-plan':
        send(await service.rebasePlan({ dir, base: url.searchParams.get('base') ?? '' }))
        return
      default:
        sendJson(res, 404, { error: `unknown endpoint: ${route}` })
    }
    return
  }

  if (method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }
  // Settings writes its own config, so it must work even in read-only mode.
  if (route === '/config') {
    const patch = await readJson(req)
    const next = normalizeConfig(options.config, patch)
    const loader = options.ctx?.get?.('loader') ?? options.ctx?.loader
    const entry = findOwnEntry(loader)
    if (!entry) {
      sendJson(res, 500, { error: 'cannot locate this plugin in the loader; edit the profile config instead' })
      return
    }
    try {
      // Merge into the entry and persist through its tree: the loader assigns
      // ids itself, so the entry object is the only reliable handle.
      await entry.update({ config: next }, false, true)
      entry.parent?.tree?.write?.()
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    // Keep this process honest even before the fiber restarts.
    options.config = next
    // `/config` is memoised by revision, and a config write does not move the
    // revision — drop the memo so the next GET returns the saved values.
    responseMemo.clear()
    sendJson(res, 200, { config: publicConfig(next) })
    return
  }

  if (options.readOnly || options.config?.readOnly === true) {
    sendJson(res, 403, { error: 'the workbench is configured read-only' })
    return
  }

  const body = await readJson(req)
  if (body.dir === undefined) body.dir = dir

  switch (route) {
    case '/console/clear':
      sendJson(res, 200, await service.clearConsole({ dir }))
      return
    case '/init':
      sendJson(res, 200, await service.initRepo({ dir: body.dir }))
      return
    case '/stage':
      sendJson(res, 200, await service.stage({ ...body, full: wantsFull(body.full, options.config) }))
      return
    case '/revert':
      sendJson(res, 200, await service.revertLines({ ...body, full: wantsFull(body.full, options.config) }))
      return
    case '/rollback':
      sendJson(res, 200, await service.rollback(/** @type {any} */ (body)))
      return
    case '/resolve':
      sendJson(res, 200, await service.resolveConflict({ dir, file: body.file, strategy: body.strategy }))
      return
    case '/conflict-view':
      sendJson(res, 200, await service.conflictView({ dir, file: body.file }))
      return
    case '/resolve-region':
      sendJson(res, 200, await service.resolveRegion(/** @type {any} */ (body)))
      return
    case '/abort':
      sendJson(res, 200, await service.abortOperation({ dir }))
      return
    case '/continue':
      sendJson(res, 200, await service.continueOperation({ dir }))
      return
    case '/rebase':
      sendJson(res, 200, await service.rebase(/** @type {any} */ ({ dir, base: body.base, entries: body.entries })))
      return
    case '/reword':
      sendJson(res, 200, await service.reword(/** @type {any} */ ({ dir, sha: body.sha, message: body.message })))
      return
    case '/ignore':
      sendJson(res, 200, await service.ignore(/** @type {any} */ (body)))
      return
    case '/tag':
      sendJson(res, 200, await service.createTag(/** @type {any} */ (body)))
      return
    case '/delete-tag':
      sendJson(res, 200, await service.deleteTag(/** @type {any} */ (body)))
      return
    case '/push-tag':
      sendJson(res, 200, await service.pushTag(/** @type {any} */ (body)))
      return
    case '/remote-add':
      sendJson(res, 200, await service.addRemote(/** @type {any} */ (body)))
      return
    case '/remote-url':
      sendJson(res, 200, await service.setRemoteUrl(/** @type {any} */ (body)))
      return
    case '/remote-remove':
      sendJson(res, 200, await service.removeRemote(/** @type {any} */ (body)))
      return
    case '/switch':
      sendJson(res, 200, await service.switchTo(/** @type {any} */ (body)))
      return
    case '/cherry-pick':
      sendJson(res, 200, await service.cherryPick(/** @type {any} */ (body)))
      return
    case '/revert-commit':
      sendJson(res, 200, await service.revertCommit(/** @type {any} */ (body)))
      return
    case '/reset':
      sendJson(res, 200, await service.reset(/** @type {any} */ (body)))
      return
    case '/commit':
      sendJson(res, 200, await service.commit(/** @type {any} */ (body)))
      return
    case '/identity':
      sendJson(res, 200, await service.saveIdentity(/** @type {any} */ (body)))
      return
    case '/commit-paths':
      sendJson(res, 200, await service.commitPaths(/** @type {any} */ (body)))
      return
    case '/pull':
      sendJson(res, 200, await service.pull({ dir, rebase: body.rebase === true }))
      return
    case '/push':
      sendJson(res, 200, await service.push({ dir, force: body.force === true, remote: body.remote }))
      return
    case '/fetch':
      sendJson(res, 200, await service.fetchAll({ dir }))
      return
    case '/checkout-commit':
      sendJson(res, 200, await service.checkoutCommit({ dir, sha: body.sha }))
      return
    case '/delete-branch':
      sendJson(res, 200, await service.deleteBranch({ dir, branch: body.branch, force: body.force }))
      return
    case '/rename-branch':
      sendJson(res, 200, await service.renameBranch({ dir, branch: body.branch, name: body.name }))
      return
    case '/set-upstream':
      sendJson(res, 200, await service.setUpstream({ dir, branch: body.branch, upstream: body.upstream }))
      return
    case '/unset-upstream':
      sendJson(res, 200, await service.unsetUpstream({ dir, branch: body.branch }))
      return
    case '/merge':
      sendJson(res, 200, await service.merge({ dir, branch: body.branch }))
      return
    case '/rebase-onto':
      sendJson(res, 200, await service.rebaseOnto({ dir, branch: body.branch }))
      return
    case '/checkout':
      sendJson(res, 200, await service.checkout(/** @type {any} */ (body)))
      return
    case '/stash':
      sendJson(res, 200, await service.stash(/** @type {any} */ (body)))
      return
    case '/check':
      sendJson(res, 200, await service.runCheck({ dir: body.dir, script: body.script }))
      return
    case '/commit-message': {
      const diff = await service.diff({ dir: body.dir, staged: true })
      if (diff.files.length === 0) throw new Error('nothing staged: stage the changes first, then draft the message')
      const { draftCommitMessage } = await import('../llm/commit-message.js')
      const language = typeof body.language === 'string' ? body.language : options.config?.commitLanguage
      sendJson(res, 200, await draftCommitMessage(options.ctx, diff, {
        language: language === 'en' ? 'en' : language === 'zh' ? 'zh' : undefined,
        provider: typeof body.provider === 'string' ? body.provider : options.config?.llmProvider,
        model: typeof body.model === 'string' ? body.model : options.config?.llmModel,
      }))
      return
    }
    default:
      sendJson(res, 404, { error: `unknown endpoint: ${route}` })
  }
}

/**
 * Refuse requests whose Origin names another site: git writes must never be
 * triggerable by a random page the user happens to have open.
 * @param {import('node:http').IncomingMessage} req
 */
function originAllowed(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return parsed.host === req.headers.host
  } catch {
    return false
  }
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, any>>}
 */
async function readJson(req) {
  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) {
      const error = new Error('request body too large')
      /** @type {any} */ (error).statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * @param {any} webServer
 * @param {import('../git/service.js').GitService} service
 * @param {{ readOnly?: boolean, ctx?: any, config?: any }} [options]
 * @returns {() => void}
 */
export function registerRoutes(webServer, service, options = {}) {
  const handler = createHandler(service, options)
  return webServer.register({ kind: 'prefix', path: BASE_PATH, handler })
}
