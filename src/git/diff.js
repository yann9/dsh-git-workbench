/**
 * Unified-diff parser.
 *
 * The server never returns raw `git diff` text to the browser: the workbench
 * needs hunks with both line numbers so it can build a side-by-side view and
 * offer hunk/line staging without re-parsing on the client.
 */

/**
 * @typedef {object} DiffLine
 * @property {'context'|'add'|'del'} type
 * @property {string} text content without the leading marker
 * @property {number | null} oldLine
 * @property {number | null} newLine
 * @property {string} id stable id `h<index>l<index>` used for selection
 */

/**
 * @typedef {object} DiffHunk
 * @property {string} header raw `@@ ... @@` line
 * @property {string} section text after the closing `@@`
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {DiffLine[]} lines
 */

/**
 * @typedef {object} FileDiff
 * @property {string} path new path (or old path for deletions)
 * @property {string} oldPath
 * @property {'modified'|'added'|'deleted'|'renamed'|'copied'|'typechange'} status
 * @property {boolean} binary
 * @property {DiffHunk[]} hunks
 * @property {number} additions
 * @property {number} deletions
 */

/**
 * @param {string} patch
 * @returns {FileDiff[]}
 */
export function parseDiff(patch) {
  /** @type {FileDiff[]} */
  const files = []
  /** @type {FileDiff | null} */
  let current = null
  /** @type {DiffHunk | null} */
  let hunk = null
  let oldNo = 0
  let newNo = 0
  let hunkIndex = 0

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = newFileDiff(raw)
      files.push(current)
      hunk = null
      hunkIndex = 0
      continue
    }
    if (!current) continue

    if (raw.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(raw)
      if (!match) continue
      oldNo = Number(match[1])
      newNo = Number(match[3])
      hunk = {
        header: raw,
        section: match[5] ?? '',
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      }
      current.hunks.push(hunk)
      hunkIndex = current.hunks.length - 1
      continue
    }

    if (!hunk) {
      readFileHeader(current, raw)
      continue
    }

    if (raw === '') {
      // `patch.split('\n')` ends with an empty element for the trailing
      // newline; a genuine empty context line is always prefixed with a space.
      continue
    }

    if (raw.startsWith('\\')) {
      const last = hunk.lines[hunk.lines.length - 1]
      if (last) last.noNewline = last.type === 'add' ? 'new' : last.type === 'del' ? 'old' : 'both'
      continue
    }

    const marker = raw[0]
    const text = raw.slice(1)
    if (marker === '+') {
      hunk.lines.push({
        type: 'add',
        text,
        oldLine: null,
        newLine: newNo,
        id: `h${hunkIndex}l${hunk.lines.length}`,
      })
      newNo += 1
      current.additions += 1
      continue
    }
    if (marker === '-') {
      hunk.lines.push({
        type: 'del',
        text,
        oldLine: oldNo,
        newLine: null,
        id: `h${hunkIndex}l${hunk.lines.length}`,
      })
      oldNo += 1
      current.deletions += 1
      continue
    }
    hunk.lines.push({
      type: 'context',
      text,
      oldLine: oldNo,
      newLine: newNo,
      id: `h${hunkIndex}l${hunk.lines.length}`,
    })
    oldNo += 1
    newNo += 1
  }

  return files
}

/**
 * @param {string} header
 * @returns {FileDiff}
 */
function newFileDiff(header) {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(header)
  const path = match ? unquote(match[2]) : header.slice('diff --git '.length)
  return {
    path,
    oldPath: match ? unquote(match[1]) : path,
    status: 'modified',
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
  }
}

/**
 * Metadata lines between `diff --git` and the first `@@`.
 * @param {FileDiff} file
 * @param {string} line
 */
function readFileHeader(file, line) {
  if (line.startsWith('new file mode')) {
    file.status = 'added'
    return
  }
  if (line.startsWith('deleted file mode')) {
    file.status = 'deleted'
    return
  }
  if (line.startsWith('old mode') || line.startsWith('new mode')) {
    file.status = 'typechange'
    return
  }
  if (line.startsWith('rename from ')) {
    file.status = 'renamed'
    file.oldPath = unquote(line.slice('rename from '.length))
    return
  }
  if (line.startsWith('rename to ')) {
    file.path = unquote(line.slice('rename to '.length))
    return
  }
  if (line.startsWith('copy from ')) {
    file.status = 'copied'
    file.oldPath = unquote(line.slice('copy from '.length))
    return
  }
  if (line.startsWith('copy to ')) {
    file.path = unquote(line.slice('copy to '.length))
    return
  }
  if (line.startsWith('--- ')) {
    const target = line.slice(4)
    if (target !== '/dev/null') file.oldPath = stripPrefix(target)
    return
  }
  if (line.startsWith('+++ ')) {
    const target = line.slice(4)
    if (target !== '/dev/null') file.path = stripPrefix(target)
    return
  }
  if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
    file.binary = true
  }
}

/** @param {string} value */
function stripPrefix(value) {
  const unquoted = unquote(value)
  return unquoted.replace(/^[ab]\//, '')
}

/** @param {string} value */
function unquote(value) {
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(Number.parseInt(oct, 8)))
      .replace(/\\(.)/g, '$1')
  }
  return value
}

/**
 * Re-index ids after concatenating several diffs (index + worktree) so the
 * client can address a line unambiguously.
 * @param {FileDiff[]} files
 * @param {string} prefix
 */
export function scopeIds(files, prefix) {
  for (const file of files) {
    const index = files.indexOf(file)
    for (const [hunkIdx, hunk] of file.hunks.entries()) {
      for (const [lineIdx, line] of hunk.lines.entries()) {
        line.id = `${prefix}${index}:h${hunkIdx}l${lineIdx}`
      }
    }
  }
  return files
}
