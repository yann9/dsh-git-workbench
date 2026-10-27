/**
 * Per-turn changes.
 *
 * DeepSeek Harness records what each top-level turn changed (`workspace/changes`
 * + `ctx.workspaceChanges`). That record is *not* the working tree: it compares
 * the turn's start and end, so it stays readable after the user commits or the
 * agent overwrites the file. The workbench renders it with the same diff
 * components as the live view, which is the whole point of the entry point on
 * the chat card.
 */

/**
 * @typedef {object} TurnFile
 * @property {string} path durable path (relative to the session cwd when inside it)
 * @property {string} display label used for ordering
 * @property {number} index position in the turn summary (the card's coordinates)
 * @property {number} additions
 * @property {number} deletions
 * @property {any} diff normalized FileDiff (read-only)
 */

/**
 * A delivery card names its own `deliverables/presented` event, while the turn
 * snapshot is keyed by the turn's `workspace/changes` event — different event
 * sequences over the same log. Bridge them so the card can still open the
 * snapshot it was built from.
 * @param {readonly any[]} events - the session log, in order.
 * @param {number} seq - delivered event sequence from the card.
 * @param {number} index - card file index within that event.
 * @returns {{ seq: number, path: string } | null} the changes event and the file it declared.
 */
export function resolvePresentedTurn(events, seq, index) {
  const presented = events.find((event) => event?.type === 'deliverables/presented' && Number(event.seq) === seq)
  const turn = presented?.data?.turn
  if (!Number.isSafeInteger(turn)) return null
  let changes = null
  for (const event of events) {
    if (event?.type !== 'workspace/changes' || event.data?.turn !== turn) continue
    // The latest announcement for a turn replaces earlier ones.
    if (!changes || Number(event.seq) > Number(changes.seq)) changes = event
  }
  if (!changes) return null
  const files = presented.data.files
  const declared = Array.isArray(files) ? files[index]?.path : ''
  return { seq: Number(changes.seq), path: typeof declared === 'string' ? declared : '' }
}

/**
 * Read the live session log without demanding a service this bundle never
 * declared: `sessions` is optional here, and reading it the wrong way throws.
 * @param {any} ctx
 * @param {string} session
 * @returns {readonly any[]}
 */
function sessionEvents(ctx, session) {
  let sessions
  try {
    sessions = ctx?.get?.('sessions')
  } catch {
    return []
  }
  let live
  try {
    live = sessions?.get?.(session)
    const snap = typeof live?.snapshotEvents === 'function' ? live.snapshotEvents() : []
    return snap
  } catch {
    return []
  }
}

/**
 * @param {any} ctx
 * @param {{ session?: string, seq?: string | number, index?: string | number }} input
 * @returns {Promise<{ turn: number | null, session: string, seq: number, focus: number, files: TurnFile[], total: number }>}
 */
export async function readTurn(ctx, input) {
  const session = String(input.session ?? '')
  const requested = Number(input.seq)
  if (!session) throw new Error('missing session id')
  if (!Number.isSafeInteger(requested) || requested < 0) throw new Error('missing or invalid event sequence')

  const changes = ctx?.get?.('workspaceChanges')
  if (!changes || typeof changes.summary !== 'function') {
    throw new Error('this harness build does not expose workspace changes (workspaceChanges service missing)')
  }

  const cardIndex = Number.parseInt(String(input.index ?? ''), 10)
  let seq = requested
  let focusPath = ''
  let summary = changes.summary(session, seq)
  if (!summary) {
    const resolved = resolvePresentedTurn(sessionEvents(ctx, session), requested, Number.isSafeInteger(cardIndex) ? cardIndex : -1)
    if (resolved) {
      seq = resolved.seq
      focusPath = resolved.path
      summary = changes.summary(session, seq)
    }
  }
  if (!summary) {
    throw new Error('this turn is no longer available: summaries live only while the session lives in this host process')
  }

  const listed = Array.isArray(summary.files) ? summary.files : []
  /** @type {TurnFile[]} */
  const files = []
  for (const [index, file] of listed.entries()) {
    let diff = null
    try {
      diff = await changes.diff(session, seq, index)
    } catch {
      diff = null
    }
    files.push({
      path: String(file.path ?? file.display ?? `file-${index}`),
      display: String(file.display ?? file.path ?? `file-${index}`),
      index,
      additions: Number(file.added ?? 0),
      deletions: Number(file.deleted ?? 0),
      diff: normalizeTurnDiff(diff, file),
    })
  }

  // The card's index counts its own presented list, so land on the same path
  // in the turn summary instead of trusting the number.
  let focus = 0
  if (focusPath) {
    const wanted = slashPath(focusPath)
    let at = files.findIndex((file) => slashPath(file.path) === wanted || slashPath(file.display) === wanted)
    if (at < 0) {
      const leaf = wanted.slice(wanted.lastIndexOf('/') + 1)
      at = files.findIndex((file) => slashPath(file.path).split('/').pop() === leaf)
    }
    if (at >= 0) focus = at
  }

  return {
    turn: summary.turn ?? null,
    session,
    seq,
    focus,
    total: summary.total ?? files.length,
    files,
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function slashPath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '')
}

/**
 * `ctx.workspaceChanges.diff` yields hunks whose body is raw `git diff` lines
 * (` `, `+`, `-`). The workbench speaks a normalized FileDiff, so convert once
 * here instead of teaching the browser two shapes.
 * @param {any} result
 * @param {any} file
 */
export function normalizeTurnDiff(result, file) {
  const path = String(result?.path ?? file?.path ?? '')
  const display = String(result?.display ?? file?.display ?? path)
  const base = {
    path: display || path,
    oldPath: path,
    status: 'modified',
    binary: false,
    hunks: [],
    additions: Number(file?.added ?? 0),
    deletions: Number(file?.deleted ?? 0),
  }

  if (!result || typeof result !== 'object') return base
  if (result.kind !== 'text') {
    return { ...base, binary: result.kind === 'binary', note: result.kind }
  }

  const before = result.before === true
  const after = result.after === true
  const status = !before && after ? 'added' : before && !after ? 'deleted' : 'modified'

  let additions = 0
  let deletions = 0
  const hunks = (result.hunks ?? []).map((hunk, hunkIndex) => {
    let oldNo = Number(hunk.oldStart ?? 1)
    let newNo = Number(hunk.newStart ?? 1)
    const lines = (hunk.lines ?? []).map((raw, lineIndex) => {
      const marker = String(raw)[0]
      const text = String(raw).slice(1)
      if (marker === '+') {
        additions += 1
        return { type: 'add', text, oldLine: null, newLine: newNo++, id: `h${hunkIndex}l${lineIndex}` }
      }
      if (marker === '-') {
        deletions += 1
        return { type: 'del', text, oldLine: oldNo++, newLine: null, id: `h${hunkIndex}l${lineIndex}` }
      }
      return { type: 'context', text, oldLine: oldNo++, newLine: newNo++, id: `h${hunkIndex}l${lineIndex}` }
    })
    return {
      header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      section: '',
      oldStart: Number(hunk.oldStart ?? 1),
      oldLines: Number(hunk.oldLines ?? 0),
      newStart: Number(hunk.newStart ?? 1),
      newLines: Number(hunk.newLines ?? 0),
      lines,
    }
  })

  return { ...base, status, hunks, additions, deletions, coarse: result.coarse === true }
}
