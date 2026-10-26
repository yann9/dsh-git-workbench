/**
 * Reading a conflicted worktree file.
 *
 * The markers are the only record of a merge that survives in the working
 * tree, so the three-way view is rebuilt from them: whatever sits between two
 * marker blocks is already agreed, and each block holds both sides — plus the
 * ancestor when the repo uses a diff3 conflict style.
 */

const START = /^<{7}(?:\s|$)/
const BASE = /^\|{7}(?:\s|$)/
const SEP = /^={7}(?:\s|$)/
const END = /^>{7}(?:\s|$)/

/** @typedef {{ kind: 'plain', lines: string[] }} PlainSegment */
/** @typedef {{ kind: 'conflict', index: number, line: number, base: string[], ours: string[], theirs: string[], raw: string[] }} ConflictSegment */
/** @typedef {PlainSegment | ConflictSegment} Segment */

/**
 * @param {string} text
 * @returns {{ segments: Segment[], count: number, complete: boolean }}
 *   `complete` is false when a block was never closed — a hand-broken file the
 *   view must show rather than rewrite.
 */
export function analyzeConflicts(text) {
  const lines = String(text ?? '').split('\n')
  /** @type {Segment[]} */
  const segments = []
  const plain = []
  /** @type {ConflictSegment|null} */
  let open = null
  let raw = null
  let side = 'ours'
  let conflicts = 0

  const close = () => {
    if (!open) return
    // A region without a separator is not a conflict git wrote; leave it alone.
    if (open.ours.length > 0 || open.theirs.length > 0) {
      // Numbered by order in the file, so an id stays meaningful to the reader
      // even after an earlier block was answered and the segments shift.
      open.index = conflicts
      conflicts += 1
      segments.push(open)
    } else segments.push({ kind: 'plain', lines: raw })
    open = null
    raw = null
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!open) {
      if (START.test(line)) {
        if (plain.length > 0) segments.push({ kind: 'plain', lines: plain.splice(0, plain.length) })
        open = { kind: 'conflict', index: conflicts, line: i + 1, base: [], ours: [], theirs: [], raw: [line] }
        // The same array object: every marker line read from here on belongs to
        // the block, and an unanswered block has to be rewritten verbatim.
        raw = open.raw
        side = 'ours'
      } else {
        plain.push(line)
      }
      continue
    }
    raw.push(line)
    if (side === 'ours') {
      if (BASE.test(line)) side = 'base'
      else if (SEP.test(line)) side = 'theirs'
      else if (END.test(line)) close()
      else open.ours.push(line)
      continue
    }
    if (side === 'base') {
      if (SEP.test(line)) side = 'theirs'
      else open.base.push(line)
      continue
    }
    if (END.test(line)) close()
    else open.theirs.push(line)
  }

  if (open && raw.length > 0) segments.push({ kind: 'plain', lines: raw })
  if (plain.length > 0) segments.push({ kind: 'plain', lines: plain })
  return { segments, count: conflicts, complete: open === null }
}

/**
 * Rewrite the file with one decision applied. `region === null` answers every
 * conflict at once, which is what the whole-file buttons do. `custom` carries
 * the hand-edited lines for that block instead of a side.
 * @param {Segment[]} segments
 * @param {number|null} region
 * @param {'ours'|'theirs'|'both'|'custom'} strategy
 * @param {string[]} resolution
 */
export function applyDecision(segments, region, strategy, resolution = []) {
  const out = []
  for (const segment of segments) {
    if (segment.kind === 'plain') {
      out.push(...segment.lines)
      continue
    }
    if (region !== null && region !== segment.index) {
      out.push(...segment.raw)
      continue
    }
    if (strategy === 'ours') out.push(...segment.ours)
    else if (strategy === 'theirs') out.push(...segment.theirs)
    else if (strategy === 'custom') out.push(...resolution)
    else out.push(...segment.ours, ...segment.theirs)
  }
  return out.join('\n')
}
