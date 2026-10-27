/**
 * Commit-message drafting.
 *
 * Uses the harness's own model route (`ctx.llm`) when it is mounted, so the
 * suggestion follows the same provider, model and credentials the session
 * already uses. Two rules the previous version broke and this one keeps:
 *
 *  - **No hard-coded model ids.** The model comes from the session's own
 *    selection (`agentDefaultModel`), then the caller's config, then the
 *    provider's catalog/default. Guessing an id means one wrong id silently
 *    costs the whole feature on another provider.
 *  - **The session's selection is the route, not the first provider in the
 *    registry.** An official-account login registers routes whose catalog lives
 *    behind the app's model picker; taking `listProviders()[0]` there finds a
 *    provider with no model at all, while the route chat actually uses is fine.
 *  - **No hard-coded language.** Prompts, warnings and the deterministic
 *    fallback follow the requested language (default follows the UI locale).
 */

/**
 * @typedef {object} MessageResult
 * @property {string} message
 * @property {'model' | 'heuristic'} source
 * @property {string | null} model
 * @property {string | null} warning
 */

/** Prompts and operator-facing text, keyed by language. */
const DICT = {
  zh: {
    role: '你是一位严谨的高级工程师，正在为一次提交撰写提交信息。',
    rules: [
      '要求：',
      '1. 第一行是主题，遵循 Conventional Commits：<type>(<scope>): <subject>，不超过 72 个字符，句末不加句号。',
      '2. 主题要说明"改了什么、为什么"，不要复述文件名列表。',
      '3. 若改动包含多个独立要点，空一行后写 2-3 条以 "- " 开头的正文。',
      '4. 只输出提交信息本身：不要代码块围栏、不要引号、不要任何解释。',
    ],
    changes: '改动内容：',
    truncated: '… (差异已截断)',
    emptyReply: (chunks) => `模型返回了空消息（chunks: ${chunks || 'none'}）`,
    noRoute: '当前 profile 没有可用的模型路由，已用本地规则生成',
    noProvider: '没有已注册的模型 provider',
    noModel: (provider) => `provider ${provider} 没有可用模型：先在 DSH 里选一个模型，或在插件配置里指定 llmModel`,
    callFailed: '模型调用失败',
    fallback: (detail) => `模型不可用（${detail}），已用本地规则生成提交信息`,
    credential: '模型凭据未配置，已用本地规则生成提交信息',
    signIn: '模型账号未登录，已用本地规则生成提交信息',
    quota: '模型额度不足，已用本地规则生成提交信息',
    timeout: '模型响应超时，已用本地规则生成提交信息',
    noChanges: 'chore: 无改动',
    subject: (tail) => `更新 ${tail}`,
    joiner: '、',
    more: (count) => ` 等 ${count} 个文件`,
  },
  en: {
    role: 'You are a careful senior engineer writing the message for one commit.',
    rules: [
      'Rules:',
      '1. The first line is the subject in Conventional Commits form: <type>(<scope>): <subject>, at most 72 characters, no trailing period.',
      '2. The subject says *what changed and why* — do not restate the file list.',
      '3. When the change has several independent points, leave one blank line and add 2-3 body bullets starting with "- ".',
      '4. Output only the message: no code fences, no quotes, no commentary.',
    ],
    changes: 'Changes:',
    truncated: '… (diff truncated)',
    emptyReply: (chunks) => `the model returned an empty message (chunks: ${chunks || 'none'})`,
    noRoute: 'no model route is available in this profile; drafted with the local rules',
    noProvider: 'no model provider is registered',
    noModel: (provider) => `provider ${provider} exposes no model: pick a model in DSH, or set llmModel in the plugin config`,
    callFailed: 'the model call failed',
    fallback: (detail) => `the model is unavailable (${detail}); drafted with the local rules`,
    credential: 'model credentials are not configured; drafted with the local rules',
    signIn: 'the DSH account is not signed in; drafted with the local rules',
    quota: 'model quota is exhausted; drafted with the local rules',
    timeout: 'the model timed out; drafted with the local rules',
    noChanges: 'chore: no changes',
    subject: (tail) => `update ${tail}`,
    joiner: ', ',
    more: (count) => ` and ${count} more`,
  },
}

/** @param {string | undefined} language */
function dictFor(language) {
  return language === 'en' ? DICT.en : DICT.zh
}

/**
 * @param {any} ctx
 * @param {{ files: any[] }} diff
 * @param {{ language?: string, provider?: string, model?: string, timeoutMs?: number }} [options]
 * @returns {Promise<MessageResult>}
 */
export async function draftCommitMessage(ctx, diff, options = {}) {
  const language = options.language === 'en' ? 'en' : 'zh'
  const text = dictFor(language)
  const files = diff.files ?? []
  const prompt = buildPrompt(files, language)
  const llm = safeGet(ctx, 'llm')

  if (llm && typeof llm.stream === 'function') {
    try {
      const route = resolveRoute(ctx, options)
      const { text: reply, model, chunkTypes } = await callModel(llm, prompt, { ...options, ...route, language })
      const cleaned = cleanup(reply)
      if (cleaned !== '') return { message: cleaned, source: 'model', model, warning: null }
      safeWarn(ctx, `empty model reply from ${model}; chunks: ${chunkTypes.join(',') || '(none)'}`)
      return {
        message: heuristic(files, language),
        source: 'heuristic',
        model,
        warning: text.emptyReply(chunkTypes.join(',')),
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      safeWarn(ctx, `commit message fell back to the local rules: ${detail}`)
      return {
        message: heuristic(files, language),
        source: 'heuristic',
        model: null,
        warning: friendly(detail, language),
      }
    }
  }

  return {
    message: heuristic(files, language),
    source: 'heuristic',
    model: null,
    warning: text.noRoute,
  }
}

/**
 * The route chat itself uses. A plugin config entry overrides it, field by
 * field: a provider alone keeps the selection's model only while both name the
 * same route, since another provider's model id would be meaningless there.
 * @param {any} ctx
 * @param {{ provider?: string, model?: string }} options
 * @returns {{ provider: string, model: string }}
 */
function resolveRoute(ctx, options) {
  const defaults = safeGet(ctx, 'agentDefaultModel')
  let current = null
  try {
    current = typeof defaults?.currentSelection === 'function' ? defaults.currentSelection() : null
  } catch {
    current = null
  }
  const selectedProvider = typeof current?.provider === 'string' ? current.provider : ''
  const provider = options.provider || selectedProvider
  const sameRoute = provider !== '' && provider === selectedProvider
  const model = options.model || (sameRoute && typeof current?.model === 'string' ? current.model : '')
  return { provider, model }
}

/**
 * @param {any} llm
 * @param {string} prompt
 * @param {{ provider?: string, model?: string, language?: string, timeoutMs?: number }} options
 */
async function callModel(llm, prompt, options) {
  const language = options.language === 'en' ? 'en' : 'zh'
  const text = dictFor(language)
  const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  const provider = options.provider || pickProviderRoute(providers)
  if (!provider) throw new Error(text.noProvider)

  const candidates = await modelCandidates(llm, provider, options)
  if (candidates.length === 0) throw new Error(text.noModel(provider))

  let lastError = null
  for (const model of candidates) {
    try {
      return await streamOnce(llm, provider, model, prompt, options)
    } catch (error) {
      lastError = error
      // A missing key or exhausted quota will fail for every model id.
      if (isFatal(error)) break
    }
  }
  throw lastError ?? new Error(text.callFailed)
}

/**
 * Model resolution, most specific first: the caller's config, the provider's
 * catalog, then the provider's declared default. Nothing is guessed — a
 * hard-coded id only works on one provider and silently breaks the rest.
 * @param {any} llm
 * @param {string} provider
 * @param {{ model?: string }} options
 * @returns {Promise<string[]>}
 */
async function modelCandidates(llm, provider, options) {
  /** @type {string[]} */
  const list = []
  if (options.model) list.push(options.model)
  try {
    const models = typeof llm.listModels === 'function' ? await llm.listModels(provider) : []
    for (const model of models ?? []) if (model?.id) list.push(model.id)
  } catch {
    // a catalog failure must not block the fallback path
  }
  if (list.length === 0) {
    const declared = defaultModelFor(llm, provider)
    if (declared) list.push(declared)
  }
  return [...new Set(list.filter(Boolean))]
}

/**
 * @param {any} llm
 * @param {string} provider
 */
function defaultModelFor(llm, provider) {
  const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  for (const entry of providers) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (id !== provider) continue
    if (entry && typeof entry !== 'string') {
      return entry.defaultModel ?? entry.default?.model ?? entry.model ?? null
    }
  }
  return llm?.defaultModel ?? llm?.default?.model ?? null
}

/**
 * @param {any} llm
 * @param {string} provider
 * @param {string} model
 * @param {string} prompt
 * @param {{ timeoutMs?: number }} options
 */
async function streamOnce(llm, provider, model, prompt, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45_000)
  let text = ''
  const seen = new Set()
  try {
    const stream = llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (typeof chunk?.type === 'string') seen.add(chunk.type)
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        continue
      }
      if (chunk?.type === 'finish') {
        const reason = chunk.reason
        if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
          const failure = reason.failure ?? {}
          throw new Error(`${failure.code ?? reason.kind}: ${failure.message ?? 'model call failed'}`)
        }
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return { text, model: `${provider}/${model}`, chunkTypes: [...seen] }
}

/**
 * Errors that no other model id can fix.
 * @param {unknown} error
 */
function isFatal(error) {
  const message = String(error instanceof Error ? error.message : error)
  return /MISSING_CREDENTIAL|INVALID_CREDENTIAL|QUOTA|no API key/i.test(message)
}

/**
 * The route key is the provider *id*; `name` is a human label and passing it to
 * `stream()` fails with "no adapter registered for provider …".
 * @param {any[]} providers
 */
function pickProviderRoute(providers) {
  if (!Array.isArray(providers) || providers.length === 0) return null
  const first = providers[0]
  if (typeof first === 'string') return first
  return first?.id ?? first?.route ?? null
}

/**
 * @param {any[]} files
 * @param {string} language
 */
function buildPrompt(files, language) {
  const text = dictFor(language)
  const lines = []
  let budget = 12_000
  for (const file of files) {
    const header = `${file.status ?? 'modified'} ${file.path}  (+${file.additions ?? 0} -${file.deletions ?? 0})`
    lines.push(header)
    budget -= header.length
    for (const hunk of file.hunks ?? []) {
      for (const line of hunk.lines) {
        if (line.type === 'context') continue
        const rendered = `${line.type === 'add' ? '+' : '-'}${line.text}`
        if (budget - rendered.length < 0) break
        lines.push(rendered)
        budget -= rendered.length + 1
      }
      if (budget <= 0) break
    }
    if (budget <= 0) {
      lines.push(text.truncated)
      break
    }
  }

  return [text.role, ...text.rules, '', text.changes, ...lines].join('\n')
}

/** Strip fences, surrounding quotes and the model's habitual preamble. */
function cleanup(text) {
  let value = String(text ?? '').trim()
  value = value.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '')
  value = value.replace(/^(提交信息|commit message)\s*[:：]\s*/i, '')
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('「') && value.endsWith('」'))) {
    value = value.slice(1, -1)
  }
  return value.trim()
}

/**
 * Deterministic fallback: still conventional, still specific about the scope.
 * @param {any[]} files
 * @param {string} [language]
 */
export function heuristic(files, language = 'zh') {
  const text = dictFor(language)
  if (files.length === 0) return text.noChanges

  const statuses = new Set(files.map((file) => file.status ?? 'modified'))
  const type = statuses.size === 1 && statuses.has('added')
    ? 'feat'
    : statuses.size === 1 && statuses.has('deleted')
      ? 'chore'
      : files.every((file) => /\.(md|txt|rst)$/i.test(file.path))
        ? 'docs'
        : 'fix'

  const scope = commonScope(files.map((file) => String(file.path)))
  const shown = files.slice(0, 3)
  const names = shown.map((file) => String(file.path).split('/').pop()).join(text.joiner)
  const more = files.length > 3 ? text.more(files.length) : ''
  const tail = language === 'en' && files.length > 3 ? `${names}${more}` : `${names}${more}`
  return `${type}${scope ? `(${scope})` : ''}: ${text.subject(tail)}`
}

/** @param {string[]} paths */
function commonScope(paths) {
  if (paths.length === 0) return ''
  const first = paths[0].split('/')
  let shared = first.slice(0, -1)
  for (const item of paths.slice(1)) {
    const parts = item.split('/')
    let index = 0
    while (index < shared.length && index < parts.length - 1 && shared[index] === parts[index]) index += 1
    shared = shared.slice(0, index)
  }
  if (shared.length === 0) return ''
  return shared[shared.length - 1]
}

/**
 * Turn transport-level failures into something a commit dialog can show.
 * @param {string} detail
 * @param {string} language
 */
function friendly(detail, language) {
  const text = dictFor(language)
  if (/ACCOUNT_SIGN_IN_REQUIRED|Sign in to /i.test(detail)) return text.signIn
  if (/MISSING_CREDENTIAL|no API key/i.test(detail)) return text.credential
  if (/QUOTA|余额|exceeded/i.test(detail)) return text.quota
  if (/timeout|aborted/i.test(detail)) return text.timeout
  return text.fallback(detail.slice(0, 80))
}

/** @param {any} ctx @param {string} message */
function safeWarn(ctx, message) {
  try {
    ctx?.logger?.warn?.(`git-workbench: ${message}`)
  } catch {
    // logging must never break the commit flow
  }
}

/** @param {any} ctx @param {string} name */
function safeGet(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}
