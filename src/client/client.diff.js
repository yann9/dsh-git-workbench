// dsh-git-workbench — client chunk (native DSH module chunk).
// Registered as a chunk of the plugin's client entry; see browser.js.

window.__ModuleLoader__.load({
  id: '@yann9/dsh-git-workbench',
  chunk: 'client.diff.js',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React
    const kit = require('@yann9/dsh-git-workbench/client.core.js')
    const { Api, COMMIT_KIND, closeDiffView, config, diffTargetStore, openDiff, openTab, statusColor, useRepoChanges, useSessionDirectory } = kit
    const { Badge, GitIcons, IconBtn, Menu, MenuRow, Safe, copyText, iconMarkup, openContextMenu, reportError, showConfirm, showToast } = require('@yann9/dsh-git-workbench/client.ui.js')
    const { tt, localizeError } = require('@yann9/dsh-git-workbench/client.i18n.js')

    /* ------------------------------------------------------------ diff grid */

    /*
     * A dependency-free highlighter. Not a parser: it recognises the token
     * classes that make a diff readable (keywords, strings, numbers, comments,
     * annotations, call sites) for the languages a repository actually carries.
     * Wrong colours are cosmetic; the text is only ever split, never rewritten.
     */
    const KEYWORDS = {
      clike: new Set(
        ('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed yield ' +
          'let function typeof delete export from of in undefined async await ' +
          'func go defer chan range map struct type impl fn trait match mut pub use mod loop where crate dyn self Self ' +
          'namespace using template typename virtual override operator friend explicit nullptr auto constexpr readonly partial params get set init ' +
          'string object decimal bool true false null nil')
          .split(' ')
          .filter(Boolean),
      ),
      python: new Set('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self'.split(' ')),
      shell: new Set('if then else elif fi for while do done case esac function return exit export local set unset readonly shift source alias unalias echo cd pwd true false'.split(' ')),
      sql: new Set('select from where group by order having insert into values update set delete join left right inner outer on as and or not null is like limit offset create table drop alter add column primary key foreign references index view distinct union all case when then end'.split(' ')),
    }

    const COMMENT_PREFIX = { clike: '//', python: '#', shell: '#', sql: '--', json: null, yaml: '#', text: null }

    /** Language family for a repository path. */
    function langOf(filePath) {
      const ext = String(filePath ?? '').split('.').pop().toLowerCase()
      if (['py', 'pyw'].includes(ext)) return 'python'
      if (['sh', 'bash', 'zsh', 'ksh'].includes(ext)) return 'shell'
      if (ext === 'sql') return 'sql'
      if (['md', 'markdown', 'txt', 'log', 'properties', 'conf', 'csv', 'toml', 'lock'].includes(ext)) return 'text'
      if (['json', 'jsonc', 'json5'].includes(ext)) return 'json'
      if (['yml', 'yaml'].includes(ext)) return 'yaml'
      return 'clike'
    }

    /**
     * @param {string} text
     * @param {string} lang
     * @returns {{ text: string, cls?: string }[]}
     */
    function highlightTokens(text, lang) {
      if (!text) return []
      if (lang === 'text') return [{ text }]
      // Continuation lines of a block comment: `* …` / `*/` at the start.
      if (lang === 'clike' && /^\s*\*/.test(text)) return [{ text, cls: 'com' }]
      const prefix = COMMENT_PREFIX[lang] ?? null
      const keywordSet = KEYWORDS[lang] ?? KEYWORDS.clike
      const tokens = []
      let plain = ''
      let index = 0
      const flush = () => {
        if (plain !== '') {
          tokens.push({ text: plain })
          plain = ''
        }
      }
      const push = (value, cls) => {
        flush()
        tokens.push({ text: value, cls })
      }
      while (index < text.length) {
        const rest = text.slice(index)
        if (prefix && rest.startsWith(prefix)) {
          push(rest, 'com')
          break
        }
        if (lang === 'clike' && rest.startsWith('/*')) {
          push(rest, 'com')
          break
        }
        const ch = rest[0]
        if (ch === '"' || ch === "'" || ch === '`') {
          let end = 1
          while (end < rest.length && rest[end] !== ch) {
            if (rest[end] === '\\') end += 1
            end += 1
          }
          const value = rest.slice(0, Math.min(end + 1, rest.length))
          push(value, 'str')
          index += value.length
          continue
        }
        if (ch === '@' && lang !== 'sql') {
          const annotation = /^@[\w.]+/.exec(rest)
          if (annotation) {
            push(annotation[0], 'ann')
            index += annotation[0].length
            continue
          }
        }
        const number = /^(?:0[xXbB][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?[fFdDlLuU]?)/.exec(rest)
        if (number) {
          push(number[0], 'num')
          index += number[0].length
          continue
        }
        const word = /^[A-Za-z_$][\w$]*/.exec(rest)
        if (word) {
          const value = word[0]
          if (keywordSet.has(value)) push(value, 'kw')
          else if (/^\s*\(/.test(rest.slice(value.length))) push(value, 'fn')
          else plain += value
          index += value.length
          continue
        }
        plain += ch
        index += 1
      }
      flush()
      return tokens
    }

    /** Common prefix/suffix of a changed pair, in characters. */
    function lineDiffSpans(left, right) {
      const max = Math.min(left.length, right.length)
      let prefix = 0
      while (prefix < max && left[prefix] === right[prefix]) prefix += 1
      let suffix = 0
      while (suffix < max - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1
      return { prefix, suffix }
    }

    /** Words, runs of whitespace and single punctuation marks, with offsets. */
    function wordTokens(text) {
      const tokens = []
      const pattern = /[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/g
      let match
      while ((match = pattern.exec(text)) !== null) tokens.push({ text: match[0], start: match.index })
      return tokens
    }

    /** Longest common subsequence of two token lists, as index pairs. */
    function tokenLcs(a, b) {
      const width = b.length + 1
      const table = new Uint16Array((a.length + 1) * width)
      const at = (i, j) => table[i * width + j]
      for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
          table[i * width + j] = a[i].text === b[j].text ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
        }
      }
      const pairs = []
      let i = 0
      let j = 0
      while (i < a.length && j < b.length) {
        if (a[i].text === b[j].text) {
          pairs.push([i, j])
          i += 1
          j += 1
        } else if (at(i + 1, j) >= at(i, j + 1)) i += 1
        else j += 1
      }
      return pairs
    }

    /**
     * JetBrains marks the words that changed, not the whole line. The common
     * prefix/suffix is trimmed as tokens first, so the alignment table stays
     * small; a pathological pair falls back to the character-level middle.
     * @returns {{ left: number[][], right: number[][] }} [start, end) runs
     */
    function wordDiffRanges(left, right) {
      const leftTokens = wordTokens(left)
      const rightTokens = wordTokens(right)
      let lo = 0
      while (lo < leftTokens.length && lo < rightTokens.length && leftTokens[lo].text === rightTokens[lo].text) lo += 1
      let hiLeft = leftTokens.length - 1
      let hiRight = rightTokens.length - 1
      while (hiLeft >= lo && hiRight >= lo && leftTokens[hiLeft].text === rightTokens[hiRight].text) {
        hiLeft -= 1
        hiRight -= 1
      }
      const middleLeft = leftTokens.slice(lo, hiLeft + 1)
      const middleRight = rightTokens.slice(lo, hiRight + 1)
      if (middleLeft.length === 0 || middleRight.length === 0 || middleLeft.length * middleRight.length > 40000) {
        const spans = lineDiffSpans(left, right)
        const endLeft = left.length - spans.suffix
        const endRight = right.length - spans.suffix
        return {
          left: endLeft > spans.prefix ? [[spans.prefix, endLeft]] : [],
          right: endRight > spans.prefix ? [[spans.prefix, endRight]] : [],
        }
      }
      const pairs = tokenLcs(middleLeft, middleRight)
      const runs = (tokens, used) => {
        const out = []
        let open = null
        for (let i = 0; i < tokens.length; i += 1) {
          const changed = !used.has(i)
          if (changed && open === null) open = i
          if (!changed && open !== null) {
            out.push([tokens[open].start, tokens[i - 1].start + tokens[i - 1].text.length])
            open = null
          }
        }
        if (open !== null) out.push([tokens[open].start, tokens[tokens.length - 1].start + tokens[tokens.length - 1].text.length])
        return out
      }
      return {
        left: runs(middleLeft, new Set(pairs.map(([i]) => i))),
        right: runs(middleRight, new Set(pairs.map(([, j]) => j))),
      }
    }

    /**
     * Tokens → spans, with every [start, end) run wrapped in the word-diff
     * class. Mark boundaries split tokens so syntax colours and the changed-word
     * highlight compose instead of fighting.
     */
    function tokenSpans(tokens, ranges, markCls) {
      const span = (text, cls, key, marked) =>
        h('span', { key, className: `${marked ? `gwb-word ${markCls}` : ''}${cls ? ` gwb-syn-${cls}` : ''}`.trim() || undefined }, text)
      const nodes = []
      const marks = ranges ?? []
      let offset = 0
      let key = 0
      for (const token of tokens) {
        const tokenStart = offset
        const tokenEnd = offset + token.text.length
        offset = tokenEnd
        const inside = marks.filter(([start, end]) => end > tokenStart && start < tokenEnd)
        if (inside.length === 0) {
          nodes.push(span(token.text, token.cls, key++, false))
          continue
        }
        let cursor = tokenStart
        for (const [start, end] of inside) {
          const from = Math.max(tokenStart, start)
          const to = Math.min(tokenEnd, end)
          if (from > cursor) nodes.push(span(token.text.slice(cursor - tokenStart, from - tokenStart), token.cls, key++, false))
          nodes.push(span(token.text.slice(from - tokenStart, to - tokenStart), token.cls, key++, true))
          cursor = to
        }
        if (cursor < tokenEnd) nodes.push(span(token.text.slice(cursor - tokenStart), token.cls, key++, false))
      }
      return nodes
    }

    function diffStatsOf(payload) {
      let additions = 0
      let deletions = 0
      for (const part of [payload?.staged, payload?.unstaged]) {
        if (!part) continue
        additions += part.additions ?? 0
        deletions += part.deletions ?? 0
      }
      return { additions, deletions }
    }

    function cellNumber(value, extraClass) {
      return h('div', { className: `gwb-dc ln${extraClass ? ` ${extraClass}` : ''}` }, value ?? '')
    }

    /** The change bar: 3px state stripe plus the line-staging click target. */
    function cellBar({ type, cellKey, selectable, onToggle, hint }) {
      return h('div', {
        className: `gwb-dc bar${type === 'add' ? ' add' : type === 'del' ? ' del' : ''}${selectable ? '' : ' inert'}`,
        'data-key': cellKey,
        title: selectable ? hint : undefined,
        onClick: selectable ? () => onToggle(cellKey) : undefined,
      })
    }

    /** One code cell: syntax-coloured, optionally word-marked. */
    function cellCode(line, { type, mark, lang, cellKey, side, lineIndex, fileIndex }) {
      const tokens = highlightTokens(line.text, lang)
      const children = tokenSpans(tokens, mark, type === 'add' ? 'add' : 'del')
      const cls = type === 'add' ? ' add' : type === 'del' ? ' del' : ''
      return h(
        'div',
        {
          className: `gwb-dc code${cls}`,
          'data-key': cellKey ?? undefined,
          'data-side': side ?? undefined,
          'data-line': lineIndex ?? undefined,
          'data-file-index': fileIndex ?? undefined,
        },
        children,
      )
    }

    /** Whether the diff view asks git for whole-file context. */
    const usesFullContext = () => config().diffFullFile !== false

    /**
     * The change run an anchor line sits in. With whole-file context git emits a
     * single hunk for the file, so a hunk index alone is not "the block on
     * screen" — the run is, and the host addresses lines by index.
     * @returns {number[] | null} null when the anchor is not a changed line
     */
    function changeRunIndexes(hunk, anchor) {
      const lines = hunk?.lines ?? []
      if (!Number.isSafeInteger(anchor) || lines[anchor]?.type === 'context' || !lines[anchor]) return null
      let start = anchor
      let end = anchor
      while (start > 0 && lines[start - 1].type !== 'context') start -= 1
      while (end + 1 < lines.length && lines[end + 1].type !== 'context') end += 1
      return Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
    }

    /**
     * Split one hunk into render segments: change groups and unchanged runs.
     * A long unchanged run becomes a fold band — the IDE's collapsed region.
     * With whole-file context (`full=1`) this is what keeps a diff readable.
     */
    const FOLD_MIN = () => (typeof config().diffFoldThreshold === 'number' ? config().diffFoldThreshold : 8)

    function foldSegments(lines, hunkIndex, options) {
      const segments = []
      let cursor = 0
      while (cursor < lines.length) {
        if (lines[cursor].type !== 'context') {
          const items = []
          while (cursor < lines.length && lines[cursor].type !== 'context') {
            items.push({ line: lines[cursor], index: cursor })
            cursor += 1
          }
          segments.push({ type: 'lines', items })
          continue
        }
        const start = cursor
        const items = []
        while (cursor < lines.length && lines[cursor].type === 'context') {
          items.push({ line: lines[cursor], index: cursor })
          cursor += 1
        }
        const key = `${options.side}:${hunkIndex}:${start}`
        if (!options.expandAll && items.length > FOLD_MIN() && !options.expandedFolds?.has(key)) segments.push({ type: 'fold', key, count: items.length })
        else segments.push({ type: 'lines', items })
      }
      return segments
    }

    function foldBand(segment, options) {
      return h(
        'div',
        { key: `fold:${segment.key}`, className: 'gwb-drow gwb-foldrow', 'data-mode': options.sideBySide ? 'side' : 'unified' },
        h(
          'div',
          {
            className: 'gwb-foldspan',
            title: tt('diff.expand'),
            onClick: () => options.onToggleFold && options.onToggleFold(segment.key),
          },
          h('span', { className: 'gwb-hunkmark' }, '⋯'),
          h('span', null, tt('diff.foldedLines', { count: segment.count })),
        ),
      )
    }

    /**
     * Word-level marks for the unified list. A del run and the add run that
     * follow it are the same edit split in two, so pairing them index-wise is
     * what lets the reader see *which* words moved.
     */
    function unifiedMarks(items) {
      const marks = new Map()
      let cursor = 0
      while (cursor < items.length) {
        if (items[cursor].line.type !== 'del') {
          cursor += 1
          continue
        }
        const dels = []
        while (cursor < items.length && items[cursor].line.type === 'del') {
          dels.push(items[cursor])
          cursor += 1
        }
        const adds = []
        while (cursor < items.length && items[cursor].line.type === 'add') {
          adds.push(items[cursor])
          cursor += 1
        }
        for (let i = 0; i < Math.min(dels.length, adds.length); i += 1) {
          if (dels[i].line.text === adds[i].line.text) continue
          const ranges = wordDiffRanges(dels[i].line.text, adds[i].line.text)
          if (ranges.left.length > 0) marks.set(dels[i].index, ranges.left)
          if (ranges.right.length > 0) marks.set(adds[i].index, ranges.right)
        }
      }
      return marks
    }

    function unifiedRows(items, hunkIndex, options) {
      const marks = unifiedMarks(items)
      let previousContext = true
      return items.map(({ line, index }) => {
        const cellKey = `${options.side}:${hunkIndex}:${index}`
        const selected = !options.readOnly && options.selection.has(cellKey)
        const selectable = !options.readOnly && line.type !== 'context'
        const startsChange = line.type !== 'context' && previousContext
        previousContext = line.type === 'context'
        const rowCls = `gwb-drow${selected ? ' selected' : ''}${line.type === 'add' ? ' add-row' : line.type === 'del' ? ' del-row' : ''}${startsChange ? ' gwb-change' : ''}`
        return h(
          'div',
          {
            key: cellKey,
            className: rowCls,
            'data-mode': 'unified',
            'data-hunk': hunkIndex,
            'data-line': index,
            'data-side': options.side,
            'data-file-index': options.fileIndex,
          },
          cellNumber(line.oldLine),
          cellNumber(line.newLine),
          cellBar({ type: line.type, cellKey, selectable, onToggle: options.onToggle, hint: options.stageHint }),
          cellCode(line, { type: line.type, mark: marks.get(index) ?? null, lang: options.lang, cellKey, side: options.side, lineIndex: index, fileIndex: options.fileIndex }),
        )
      })
    }

    function sideRows(items, hunkIndex, options) {
      const pairs = []
      let cursor = 0
      while (cursor < items.length) {
        const item = items[cursor]
        if (item.line.type === 'context') {
          pairs.push({ left: item, right: item })
          cursor += 1
          continue
        }
        const dels = []
        const adds = []
        while (cursor < items.length && items[cursor].line.type === 'del') {
          dels.push(items[cursor])
          cursor += 1
        }
        while (cursor < items.length && items[cursor].line.type === 'add') {
          adds.push(items[cursor])
          cursor += 1
        }
        const count = Math.max(dels.length, adds.length)
        for (let i = 0; i < count; i += 1) pairs.push({ left: dels[i] ?? null, right: adds[i] ?? null })
      }
      let previousContext = true
      return pairs.map((pair, pairIndex) => {
        const leftKey = pair.left ? `${options.side}:${hunkIndex}:${pair.left.index}` : null
        const rightKey = pair.right ? `${options.side}:${hunkIndex}:${pair.right.index}` : null
        const selected =
          !options.readOnly && ((leftKey && options.selection.has(leftKey)) || (rightKey && options.selection.has(rightKey)))

        // Word-level diff for a replacement pair (JetBrains' intra-line
        // highlight): mark only the words that actually changed.
        let leftMark = null
        let rightMark = null
        if (pair.left && pair.right && pair.left.line.text !== pair.right.line.text) {
          const ranges = wordDiffRanges(pair.left.line.text, pair.right.line.text)
          if (ranges.left.length > 0) leftMark = ranges.left
          if (ranges.right.length > 0) rightMark = ranges.right
        }

        const leftCells = []
        const rightCells = []
        for (const [slot, cell, bucket] of [
          ['left', pair.left, leftCells],
          ['right', pair.right, rightCells],
        ]) {
          if (!cell) {
            bucket.push(cellNumber(null, 'pad'))
            bucket.push(h('div', { key: `${pairIndex}-${slot}-bar`, className: 'gwb-dc bar pad' }))
            bucket.push(h('div', { key: `${pairIndex}-${slot}-code`, className: 'gwb-dc code pad' }))
            continue
          }
          const type = cell.line.type
          const number = type === 'del' ? cell.line.oldLine : type === 'add' ? cell.line.newLine : cell.line.newLine ?? cell.line.oldLine
          const selectable = !options.readOnly && type !== 'context'
          bucket.push(cellNumber(number))
          bucket.push(cellBar({ type, cellKey: slot === 'left' ? leftKey : rightKey, selectable, onToggle: options.onToggle, hint: options.stageHint }))
          bucket.push(
            cellCode(cell.line, {
              type,
              mark: slot === 'left' ? leftMark : rightMark,
              lang: options.lang,
              cellKey: slot === 'left' ? leftKey : rightKey,
              side: options.side,
              lineIndex: cell.index,
              fileIndex: options.fileIndex,
            }),
          )
        }
        // The centre gutter bridges the pair: green for an addition, red for a
        // deletion, a blend for a replacement, plain between context rows. It
        // is what makes the two panes read as one comparison.
        const pairKind = !pair.left ? 'add' : !pair.right ? 'del' : pair.left.line.type === 'del' && pair.right.line.type === 'add' ? 'mod' : ''
        const cells = [...leftCells, h('div', { key: `${pairIndex}-con`, className: `gwb-dc con${pairKind ? ` ${pairKind}` : ''}` }), ...rightCells]
        const kind = pair.left?.line?.type ?? pair.right?.line?.type
        const startsChange = Boolean(kind && kind !== 'context' && previousContext)
        previousContext = !kind || kind === 'context'
        const rowCls = `gwb-drow${selected ? ' selected' : ''}${kind === 'add' ? ' add-row' : kind === 'del' ? ' del-row' : ''}${startsChange ? ' gwb-change' : ''}`
        return h(
          'div',
          {
            key: `${leftKey ?? ''}|${rightKey ?? ''}|${pairIndex}`,
            className: rowCls,
            'data-mode': 'side',
            'data-hunk': hunkIndex,
            'data-line': pair.left?.index ?? pair.right?.index,
            'data-side': options.side,
            'data-file-index': options.fileIndex,
          },
          cells,
        )
      })
    }

    /**
     * Unchanged-line band between two hunks, like the IDE's `⋮ N 行` separator.
     * Derived from the hunk headers, so no extra git call is needed.
     */
    function hunkGap(previous, hunk) {
      if (!previous) return null
      const count = hunk.oldStart - (previous.oldStart + previous.oldLines)
      if (count <= 0) return null
      return h('div', { key: `gap${previous.oldStart}`, className: 'gwb-hunkgap' }, `⋮ ${tt('diff.unchanged', { count })}`)
    }

    /** Number of change blocks (not hunks) — the IDE's "N changes" counter. */
    function countChanges(hunks) {
      let total = 0
      for (const hunk of hunks ?? []) {
        let previousContext = true
        for (const line of hunk.lines) {
          if (line.type !== 'context' && previousContext) total += 1
          previousContext = line.type === 'context'
        }
      }
      return total
    }

    /** @returns {import('./types').Element[]} one hunk: header + rows */
    function hunkBlock(hunk, hunkIndex, options) {
      const range = hunk.header.replace(/^@@\s*/, '').replace(/\s*@@.*$/, '')
      const header = h(
        'div',
        { key: `h${hunkIndex}`, className: 'gwb-hunkhead', 'data-hunk': hunkIndex },
        h('span', { className: 'gwb-hunkmark' }, '⋮'),
        h('span', { className: 'gwb-hunkrange' }, range),
        hunk.section ? h('span', { className: 'gwb-hunksection' }, hunk.section) : null,
        options.hunkAction && !options.readOnly
          ? h('button', { className: 'gwb-btn sm ctl gwb-hunkbtn', onClick: () => options.hunkAction(hunkIndex) }, options.hunkLabel)
          : null,
      )
      const rows = [header]
      for (const segment of foldSegments(hunk.lines, hunkIndex, options)) {
        if (segment.type === 'fold') {
          rows.push(foldBand(segment, options))
          continue
        }
        rows.push(...(options.sideBySide ? sideRows(segment.items, hunkIndex, options) : unifiedRows(segment.items, hunkIndex, options)))
      }
      return rows
    }

    /** Version labels above the two panes, JetBrains-style. */
    function sideLabels(source, section, commitSha) {
      if (source === 'stash') return { left: tt('diff.versionStashBase'), right: tt('diff.versionStash') }
      if (source === 'commit') return { left: tt('diff.versionParent'), right: commitSha ? commitSha.slice(0, 8) : tt('diff.versionHead') }
      if (source === 'turn') return { left: tt('diff.versionTurnStart'), right: tt('diff.versionTurnEnd') }
      if (section === 'staged') return { left: tt('diff.versionHead'), right: tt('diff.versionIndex') }
      return { left: tt('diff.versionIndex'), right: tt('diff.versionWorking') }
    }

    function sideHeader(labels, key) {
      return h(
        'div',
        { key, className: 'gwb-diffside' },
        h('span', null),
        h('span', null),
        h('span', { className: 'gwb-diffside-left' }, labels.left),
        h('span', { className: 'gwb-diffside-con' }),
        h('span', null),
        h('span', null),
        h('span', { className: 'gwb-diffside-right' }, labels.right),
      )
    }

    function blameDate(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      return date.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
    }

    /** Path breadcrumb for the diff header (JetBrains shows `/` segments). */
    function breadcrumb(filePath) {
      const parts = String(filePath ?? '').split('/').filter(Boolean)
      const nodes = []
      parts.forEach((part, index) => {
        if (index > 0) nodes.push(h('span', { key: `sep${index}`, className: 'gwb-crumb-sep' }, '/'))
        nodes.push(h('span', { key: `part${index}`, className: index === parts.length - 1 ? 'gwb-crumb-name' : 'gwb-crumb-dir' }, part))
      })
      return nodes
    }

    /* ------------------------------------------------------- diff component */

    /**
     * The diff shortcuts (F7, Alt+↑↓, Ctrl+Alt+R, Esc) are bound to the pane
     * root, so the root has to own focus. The host keeps a mounted pane hidden
     * instead of unmounting it, and clicking its tab lands focus on the tab —
     * take the pane back each time it reappears.
     */
    function useFocusOnShow(ref) {
      useEffect(() => {
        const node = ref.current
        if (!node || typeof ResizeObserver !== 'function') return undefined
        let shown = node.getBoundingClientRect().width > 0
        const observer = new ResizeObserver((entries) => {
          const visible = (entries[0]?.contentRect?.width ?? 0) > 0
          if (visible && !shown) node.focus({ preventScroll: true })
          shown = visible
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [ref])
    }

    function DiffView({ target, canClose, onClose, sessionDir }) {
      const source = target?.source ?? 'working'
      // A stash previews exactly like a commit: one immutable revision, no
      // hunk actions, nothing to stage.
      const isRev = source === 'commit' || source === 'stash'
      const readOnly = source !== 'working' || config().readOnly === true
      const dir = target?.dir || sessionDir || ''

      const [entries, setEntries] = useState([])
      const [index, setIndex] = useState(0)
      const [payload, setPayload] = useState(null) // working: /file result
      // The payload above can be an intermediate commit view (hunk-only before
      // the whole-file fetch lands); landing on a change waits for this flag.
      const [payloadSettled, setPayloadSettled] = useState(false)
      const [commit, setCommit] = useState(null) // commit: /commit result
      const [turn, setTurn] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [selection, setSelection] = useState(() => new Set())
      const [blame, setBlame] = useState(null)
      const [sideBySide, setSideBySide] = useState(() => {
        const stored = localStorage.getItem('dsh-git.side')
        if (stored !== null) return stored !== '0'
        return config().diffSideBySide !== false
      })
      // Hunk indexes come from a whitespace-filtered diff, so nothing from this
      // mode may be staged or reverted: the host would re-read the unfiltered
      // diff and land on the wrong lines.
      const [ignoreWhitespace, setIgnoreWhitespace] = useState(() => localStorage.getItem('dsh-git.ws') === '1')
      const diffReadOnly = readOnly || ignoreWhitespace
      const [activeHunk, setActiveHunk] = useState(0)
      const [expandedFolds, setExpandedFolds] = useState(() => new Set())
      const [expandAll, setExpandAll] = useState(false)
      // A split diff needs roughly two readable columns; below that the
      // unified view wins regardless of the stored preference.
      const [wide, setWide] = useState(true)
      // Commit and turn diffs are immutable; a working-tree diff must follow
      // external git operations.
      useRepoChanges(dir, () => {
        // Same loader the manual refresh uses: one context policy, one payload.
        void reloadWorking()
      })
      const bodyRef = useRef(null)
      // Direction to land on after a change-navigation file switch: the next
      // file's first change, or the previous file's last change.
      const pendingLand = useRef(null)
      // Explicit review cursor (0-based, -1 before the first change). The
      // viewport alone cannot answer "which change is current" near the end
      // of a file: scrolling clamps, so the next change never reaches the
      // reading line. Jumps move this cursor; user scrolls re-sync it.
      const changeCursor = useRef(-1)
      // Scroll position a jump produced. While the scroller still sits
      // there, measurements must not rewind the cursor (a change near the
      // end of a file can never be aligned at the top).
      const jumpScroll = useRef(-1)

      const targetKey = JSON.stringify(target ?? null)
      const rootRef = useRef(null)
      const focusTurnRef = useRef(-1)
      const split = sideBySide && wide

      // The conversation view mounts this root in a page that also hosts the
      // sticky composer; a 100%-tall root then runs underneath the input. Own
      // the measured free height so the diff body scrolls, not the host page.
      useEffect(() => {
        const root = rootRef.current
        if (!root) return undefined
        let host = root.parentElement
        while (host) {
          if (/(auto|scroll|overlay)/.test(getComputedStyle(host).overflowY)) break
          host = host.parentElement
        }
        if (!host) return undefined
        const seat = host.querySelector('[class*="composerSeat"], [data-conversation-composer-overlay]')
        const fit = () => {
          const hostRect = host.getBoundingClientRect()
          const top = root.getBoundingClientRect().top - hostRect.top + host.scrollTop
          const seatRect = seat?.getBoundingClientRect()
          const seatPos = seat ? getComputedStyle(seat).position : 'static'
          const overlays = seatPos === 'sticky' || seatPos === 'fixed' || seatPos === 'absolute'
          const seatHeight = overlays && seatRect && seatRect.height > 0 ? seatRect.height : 0
          const available = Math.floor(host.clientHeight - top - seatHeight)
          if (available > 220) root.style.height = `${available}px`
        }
        fit()
        let observer = null
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(fit)
          observer.observe(host)
          if (seat) observer.observe(seat)
        }
        window.addEventListener('resize', fit)
        return () => {
          observer?.disconnect()
          window.removeEventListener('resize', fit)
          root.style.height = ''
        }
      }, [targetKey])

      /**
       * The element that really owns the scrollbar. In a standalone pane that
       * is the diff body; inside the conversation view the host pane scrolls
       * and the body grows to its full content height.
       */
      function scrollHost() {
        const body = bodyRef.current
        const chain = body ? [body] : []
        let node = rootRef.current?.parentElement ?? null
        while (node) {
          chain.push(node)
          node = node.parentElement
        }
        const doc = document.scrollingElement
        if (doc && !chain.includes(doc)) chain.push(doc)
        for (const el of chain) {
          const overflow = getComputedStyle(el).overflowY
          if (!/(auto|scroll|overlay)/.test(overflow)) continue
          if (el.scrollHeight > el.clientHeight + 1) return el
        }
        return null
      }

      function resetScroll() {
        if (bodyRef.current) bodyRef.current.scrollTop = 0
        const host = scrollHost()
        if (host) host.scrollTop = 0
      }

      function activeScroller() {
        return scrollHost() ?? bodyRef.current
      }

      /** The reading line: under the pinned header/toolbar when the host
       *  scrolls, or just below the toolbar when the body itself scrolls. */
      function readingTop() {
        const bodyTop = bodyRef.current?.getBoundingClientRect().top ?? 0
        const toolbar = rootRef.current?.querySelector('.gwb-difftoolbar')
        return Math.max(bodyTop, toolbar?.getBoundingClientRect().bottom ?? 0)
      }

      useEffect(() => {
        const node = rootRef.current
        if (!node) return undefined
        if (typeof ResizeObserver !== 'function') {
          setWide(window.innerWidth >= 820)
          return undefined
        }
        const observer = new ResizeObserver((entries) => {
          const width = entries[0]?.contentRect?.width ?? 0
          setWide(width >= 820)
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [targetKey])

      // Keyboard review (F7, Alt+↑↓, Ctrl+Alt+R, Esc) lives on this root, so it
      // must own focus when the diff opens.
      useEffect(() => {
        if (target) rootRef.current?.focus({ preventScroll: true })
      }, [targetKey])
      useFocusOnShow(rootRef)

      useEffect(() => {
        if (!target) return
        let alive = true
        void (async () => {
          setEntries([])
          setIndex(0)
          setSelection(new Set())
          setExpandedFolds(new Set())
          setExpandAll(false)
          setActiveHunk(0)
          setBlame(null)
          setCommit(null)
          setTurn(null)
          setPayload(null)
          setPayloadSettled(false)
          setError(null)
          focusTurnRef.current = -1
          pendingLand.current = null
          changeCursor.current = -1
          jumpScroll.current = -1
          resetScroll()
          try {
            if (isRev) {
              const loaded = source === 'stash'
                ? await Api.stashShow(dir, target.ref, ignoreWhitespace)
                : await Api.showCommit(dir, target.sha, ignoreWhitespace)
              if (!alive) return
              setCommit(loaded)
              setEntries(loaded.files.map((file) => ({ path: file.path, diff: file })))
              const at = loaded.files.findIndex((file) => file.path === target.file)
              setIndex(at >= 0 ? at : 0)
            } else if (source === 'turn') {
              const loaded = await Api.turn(dir, target.session, target.seq, target.index)
              if (!alive) return
              setTurn(loaded)
              const list = (loaded.files ?? []).map((file) => ({
                path: file.path,
                display: file.display || file.path,
                index: file.index,
                diff: file.diff,
                additions: file.additions,
                deletions: file.deletions,
              }))
              setEntries(list)
              // `focus` is the server's translation of the card's index into
              // this summary's file order; without it a delivery card would
              // open whichever file happens to share its number.
              const wanted = Number.isSafeInteger(loaded.focus) ? loaded.focus : Number(target.index)
              const at = Number.isSafeInteger(wanted) ? list.findIndex((entry) => entry.index === wanted) : -1
              setIndex(at >= 0 ? at : 0)
              if (at > 0) focusTurnRef.current = at
            } else {
              const status = await Api.status(dir)
              if (!alive) return
              const seen = new Set()
              const list = []
              for (const file of status.files) {
                if (seen.has(file.path)) continue
                seen.add(file.path)
                list.push({ path: file.path, kind: file.kind })
              }
              setEntries(list)
              const at = list.findIndex((entry) => entry.path === target.file)
              setIndex(at >= 0 ? at : 0)
            }
          } catch (cause) {
            if (alive) setError(cause)
          }
        })()
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [targetKey, ignoreWhitespace])

      // Turn diffs render every file in one scroll: land on the file the card
      // pointed at instead of leaving it below the fold.
      useEffect(() => {
        if (focusTurnRef.current < 0 || !turn) return
        const at = focusTurnRef.current
        focusTurnRef.current = -1
        requestAnimationFrame(() => {
          const node = rootRef.current?.querySelector(`[data-turn-index="${at}"]`)
          node?.scrollIntoView({ block: 'start' })
        })
      }, [turn])

      const entry = entries[index] ?? null
      const lang = langOf(entry?.display ?? entry?.path ?? '')

      // `git blame` reads the revision (HEAD) or, for a newly added path, the
      // index. An untracked, deleted or unmerged file has neither version to
      // read, and the command answers with a raw "no such path" / lstat error.
      // Withhold annotate for those states instead of showing git's text.
      const canAnnotate = () => {
        if (source !== 'working' || !entry?.path) return false
        const state = entry?.kind ?? payload?.entry?.kind
        return state !== 'untracked' && state !== 'deleted' && state !== 'conflicted'
      }

      /** Rows for one section: hunk gaps + hunk blocks, in IDE order. */
      function renderHunks(hunks, options) {
        const nodes = []
        hunks.forEach((hunk, hunkIndex) => {
          const gap = hunkGap(hunks[hunkIndex - 1], hunk)
          if (gap) nodes.push(gap)
          nodes.push(...hunkBlock(hunk, hunkIndex, options))
        })
        return nodes
      }

      // The per-file payload: the working tree needs a request; a commit already
      // carries its hunks; a turn carries the whole snapshot.
      useEffect(() => {
        if (source === 'turn') return
        // Never pair the new file header with the previous file's payload:
        // hunk buttons would target the wrong file until the fetch lands.
        setPayload(null)
        setPayloadSettled(false)
        if (!entry) {
          setPayloadSettled(true)
          return
        }
        let alive = true
        if (isRev) {
          // The rev payload carries hunks only; paint with those, then swap
          // in the whole-file diff for this one file.
          setPayload(entry.diff ?? null)
          const file = entry.path ?? target?.file
          const rev = source === 'stash' ? target?.ref : target?.sha
          if (file && rev) {
            const full = source === 'stash' ? Api.stashFile(dir, rev, file, true, ignoreWhitespace) : Api.commitFile(dir, rev, file, true, ignoreWhitespace)
            void full
              .then((loaded) => {
                if (alive) setPayload(loaded.unstaged ?? loaded.staged ?? entry.diff ?? null)
              })
              .catch(() => {})
              .finally(() => {
                if (alive) setPayloadSettled(true)
              })
          } else {
            setPayloadSettled(true)
          }
          return () => {
            alive = false
          }
        }
        void (async () => {
          try {
            const loaded = await Api.file(dir, entry.path, usesFullContext(), ignoreWhitespace)
            if (alive) setPayload(loaded)
          } catch (cause) {
            if (alive) reportError(cause)
          } finally {
            if (alive) setPayloadSettled(true)
          }
        })()
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [source, entry?.path, dir, targetKey, ignoreWhitespace])

      const hunkCount =
        source === 'working'
          ? countChanges(payload?.staged?.hunks) + countChanges(payload?.unstaged?.hunks)
          : isRev
            ? countChanges(payload?.hunks ?? entry?.diff?.hunks)
            : entries.reduce((sum, item) => sum + countChanges(item.diff?.hunks), 0)

      // The change counter follows the scroll position, like the IDE's
      // "1/38 个更改" indicator. The diff body scrolls in a standalone pane;
      // under the conversation view the host pane's scroller must be watched
      // too, or the counter freezes at 1/N.
      useEffect(() => {
        const view = bodyRef.current
        if (!view) return undefined
        const host = scrollHost()
        const targets = host && host !== view ? [view, host] : [view]
        const scroller = host ?? view
        let timer = 0
        const measure = () => {
          timer = 0
          // A jump owns the cursor until the user moves the scroller away
          // from the position the jump produced.
          if (jumpScroll.current >= 0) {
            if (Math.abs(scroller.scrollTop - jumpScroll.current) <= 1) return
            jumpScroll.current = -1
          }
          const heads = view.querySelectorAll('.gwb-change')
          if (heads.length === 0) {
            changeCursor.current = -1
            return
          }
          // Nothing to scroll — which is the normal case in the narrow sidebar,
          // where a small diff fits whole. Geometry cannot say which change is
          // being read then, so leave the cursor with the last explicit jump
          // instead of snapping it back to the first block.
          if (scroller.scrollHeight - scroller.clientHeight <= 0) {
            // A pane that has never been jumped to still has a first change.
            if (changeCursor.current < 0) {
              changeCursor.current = 0
              setActiveHunk(0)
            }
            return
          }
          const top = readingTop() + 8
          let current = -1
          heads.forEach((head, index) => {
            if (head.getBoundingClientRect().top <= top) current = index
          })
          // Scrolled to the end: the last change is the one being read even
          // though it cannot reach the top line.
          const max = scroller.scrollHeight - scroller.clientHeight
          if (max > 0 && max - scroller.scrollTop <= 1) current = heads.length - 1
          changeCursor.current = current
          setActiveHunk(current < 0 ? 0 : current)
        }
        const onScroll = () => {
          if (timer === 0) timer = window.setTimeout(measure, 16)
        }
        measure()
        for (const node of targets) node.addEventListener('scroll', onScroll, { passive: true })
        return () => {
          for (const node of targets) node.removeEventListener('scroll', onScroll)
          if (timer) window.clearTimeout(timer)
        }
      }, [payload, commit, turn, split])

      // After a change-navigation file switch, land on that file's first or
      // last change once the final payload is in place (a commit first paints
      // a hunk-only view, then swaps in the whole file).
      useEffect(() => {
        const mode = pendingLand.current
        if (!mode || !payloadSettled) return
        pendingLand.current = null
        const body = bodyRef.current
        const heads = body ? [...body.querySelectorAll('.gwb-change')] : []
        if (heads.length === 0) return
        const at = mode === 'last' ? heads.length - 1 : 0
        changeCursor.current = at
        setActiveHunk(at)
        const targetNode = heads[at]
        targetNode.scrollIntoView({ block: mode === 'last' ? 'center' : 'start', behavior: 'instant' })
        jumpScroll.current = activeScroller()?.scrollTop ?? -1
        targetNode.classList.add('gwb-flash')
        window.setTimeout(() => targetNode.classList.remove('gwb-flash'), 800)
      }, [payloadSettled, payload, index])

      async function reloadWorking() {
        if (source !== 'working' || !entry) return
        try {
          setPayload(await Api.file(dir, entry.path, usesFullContext(), ignoreWhitespace))
        } catch (cause) {
          reportError(cause)
        }
      }

      /**
       * The working-tree file set changes after every stage/revert. Keep the
       * reviewed file when it still has changes, otherwise land on its
       * neighbour; never leave the old file's payload under a new header.
       */
      async function refreshAfterMutation(keepPath) {
        if (source !== 'working') return
        let list = []
        try {
          const status = await Api.status(dir)
          const seen = new Set()
          for (const file of status.files) {
            if (seen.has(file.path)) continue
            seen.add(file.path)
            list.push({ path: file.path })
          }
        } catch (cause) {
          reportError(cause)
          return
        }
        setEntries(list)
        const at = list.findIndex((item) => item.path === keepPath)
        if (at >= 0) {
          if (at !== index) setIndex(at)
          try {
            setPayload(await Api.file(dir, keepPath, usesFullContext(), ignoreWhitespace))
          } catch (cause) {
            reportError(cause)
          }
          return
        }
        const next = Math.min(index, list.length - 1)
        if (next >= 0) setIndex(next)
        resetFileState()
      }

      async function stage(body) {
        if (diffReadOnly || busy) {
          if (diffReadOnly) showToast(tt(ignoreWhitespace ? 'diff.ignoreWsNote' : source === 'working' ? 'diff.readonlyModeNote' : 'diff.readonlyNote'), true)
          return
        }
        setBusy(true)
        try {
          // The host re-reads the diff to resolve hunk/line indexes; it has to
          // read it the same way the rows on screen were built.
          await Api.stage(dir, { full: usesFullContext(), ...body })
          await refreshAfterMutation(body.file)
        } catch (cause) {
          reportError(cause)
        } finally {
          setBusy(false)
        }
      }

      /** Rollback with the precision the selection asks for: hunk or single lines. */
      async function revertChanges(picks, confirmText, doneText) {
        if (diffReadOnly || busy || !entry) return
        if (!(await showConfirm(confirmText, { ok: tt('confirm.discard'), danger: true }))) return
        setBusy(true)
        try {
          const partial = picks.some((pick) => Array.isArray(pick.lines))
          await Api.revert(dir, { file: entry.path, mode: partial ? 'lines' : 'hunk', selection: picks, full: usesFullContext() })
          showToast(doneText)
          await refreshAfterMutation(entry.path)
        } catch (cause) {
          reportError(cause)
        } finally {
          setBusy(false)
        }
      }

      /** Hunks of the section a right-click landed in (turn: the right file). */
      function hunksForRow(row, side) {
        if (source === 'working') return side === 'staged' ? payload?.staged?.hunks : payload?.unstaged?.hunks
        if (isRev) return commitEntry?.hunks
        const fileIndex = Number(row?.dataset?.fileIndex ?? NaN)
        if (Number.isSafeInteger(fileIndex)) return entries.find((item) => item.index === fileIndex)?.diff?.hunks
        return null
      }

      /** Right-click on a diff row: the actions the IDE offers on a change. */
      function onRowContext(event) {
        event.preventDefault()
        const row = event.target.closest?.('.gwb-drow')
        const cell = event.target.closest?.('.gwb-dc.code')
        const side = cell?.dataset?.side || row?.dataset?.side || ''
        const hunkIndex = Number(row?.dataset?.hunk ?? -1)
        const lineIndex = Number(cell?.dataset?.line ?? NaN)
        const hunks = hunksForRow(row, side)
        const line = Number.isSafeInteger(lineIndex) && hunkIndex >= 0 ? hunks?.[hunkIndex]?.lines?.[lineIndex] : null
        const items = []
        // Reverting is only meaningful for the working tree's unstaged side.
        if (!diffReadOnly && source === 'working' && side === 'unstaged' && hunks?.[hunkIndex]) {
          const run = changeRunIndexes(hunks[hunkIndex], lineIndex)
          items.push({
            id: 'revert',
            iconSvg: iconMarkup('rollback', 13),
            label: tt('diff.revert'),
            hint: 'Ctrl+Alt+R',
            danger: true,
            onClick: () => void revertChanges([run ? { hunk: hunkIndex, lines: run } : { hunk: hunkIndex }], tt('diff.revertConfirm'), tt('diff.reverted')),
          })
        }
        if (line && line.type !== 'context' && side === 'unstaged' && source === 'working' && !diffReadOnly) {
          items.push({
            id: 'revert-line',
            iconSvg: iconMarkup('rollback', 13),
            label: tt('diff.revertLine'),
            danger: true,
            onClick: () =>
              void revertChanges(
                [{ hunk: hunkIndex, lines: [lineIndex] }],
                tt('diff.revertLineConfirm'),
                tt('diff.revertedLine'),
              ),
          })
        }
        if (line) {
          items.push({
            id: 'copy',
            iconSvg: iconMarkup('copy', 13),
            label: tt('diff.copyLine'),
            onClick: () => {
              void copyText(line.text ?? '')
            },
          })
        }
        if (items.length > 0) items.push({ sep: true })
        items.push({
          id: 'unfold',
          iconSvg: iconMarkup(expandAll ? 'chevUp' : 'chevDown', 13),
          label: expandAll ? tt('diff.collapse') : tt('diff.expandAll'),
          onClick: () => setExpandAll((value) => !value),
        })
        if (canAnnotate()) {
          items.push({
            id: 'blame',
            iconSvg: iconMarkup('history', 13),
            label: tt('diff.annotate'),
            onClick: () => void toggleAnnotate(),
          })
        }
        openContextMenu(event.clientX, event.clientY, items)
      }

      /** Expand one folded unchanged run. */
      function toggleFold(key) {
        setExpandedFolds((previous) => {
          const next = new Set(previous)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      function toggleLine(key) {
        if (diffReadOnly) return
        const side = key.split(':')[0]
        setSelection((previous) => {
          const next = new Set(previous)
          if (next.has(key)) {
            next.delete(key)
            return next
          }
          // One selection applies to one index side at a time; mixing staged
          // and unstaged lines would need two opposite patch operations.
          if ([...next].some((existing) => existing.split(':')[0] !== side)) next.clear()
          next.add(key)
          return next
        })
      }

      function selectionBySide(side) {
        const grouped = new Map()
        for (const key of selection) {
          const [keySide, hunk, line] = key.split(':')
          if (keySide !== side) continue
          const list = grouped.get(Number(hunk)) ?? []
          list.push(Number(line))
          grouped.set(Number(hunk), list)
        }
        return [...grouped.entries()].map(([hunk, lines]) => ({ hunk, lines }))
      }

      async function applySelection(direction) {
        const side = [...selection][0]?.split(':')[0]
        const picks = side ? selectionBySide(side) : []
        if (picks.length === 0) return
        setSelection(new Set())
        await stage({ file: entry?.path, direction, mode: 'lines', selection: picks })
      }

      /** Per-file UI state must not leak into the next file. */
      function resetFileState() {
        pendingLand.current = null
        changeCursor.current = -1
        jumpScroll.current = -1
        setSelection(new Set())
        setExpandedFolds(new Set())
        setBlame(null)
        setPayload(null)
        setPayloadSettled(false)
        setActiveHunk(0)
        resetScroll()
      }

      function selectFile(next) {
        if (next === index) return
        setIndex(next)
        resetFileState()
      }

      function toggleSideBySide() {
        setSideBySide((value) => {
          const next = !value
          localStorage.setItem('dsh-git.side', next ? '1' : '0')
          return next
        })
      }

      function toggleIgnoreWhitespace() {
        setIgnoreWhitespace((value) => {
          const next = !value
          localStorage.setItem('dsh-git.ws', next ? '1' : '0')
          return next
        })
      }

      /** Rows carry scroll-margin-top: 72px, so this is the landing line. */
      function changeAnchor() {
        return readingTop()
      }

      function changeHeads(side) {
        const node = bodyRef.current
        if (!node) return []
        return [...node.querySelectorAll(`.gwb-change${side ? `[data-side="${side}"]` : ''}`)]
      }

      function currentChange(side) {
        const heads = changeHeads(side)
        let current = null
        const anchor = changeAnchor() + 8
        for (const head of heads) {
          if (head.getBoundingClientRect().top > anchor) break
          current = head
        }
        return current ?? heads[0] ?? null
      }

      async function jumpHunk(delta) {
        if (state_isBlame()) return
        const heads = changeHeads()
        if (heads.length === 0) {
          // A binary/no-hunk file still participates in file navigation.
          if (source === 'turn') return
          const next = index + delta
          if (next < 0 || next >= entries.length) {
            showToast(tt(delta < 0 ? 'nav.first' : 'nav.last'))
            return
          }
          selectFile(next)
          pendingLand.current = delta > 0 ? 'first' : 'last'
          return
        }
        const at = changeCursor.current + delta
        // Past an edge change: continue into the neighbouring file. Going
        // backwards lands on that file's last change, matching the IDE.
        if (at < 0) {
          if (source === 'turn' || index <= 0) {
            showToast(tt('nav.firstChange'))
            return
          }
          selectFile(index - 1)
          pendingLand.current = 'last'
          return
        }
        if (at >= heads.length) {
          if (source === 'turn' || index >= entries.length - 1) {
            showToast(tt('nav.lastChange'))
            return
          }
          selectFile(index + 1)
          pendingLand.current = 'first'
          return
        }
        changeCursor.current = at
        setActiveHunk(at)
        const node = heads[at]
        node.scrollIntoView({ block: 'start', behavior: 'instant' })
        jumpScroll.current = activeScroller()?.scrollTop ?? -1
        node.classList.add('gwb-flash')
        window.setTimeout(() => node.classList.remove('gwb-flash'), 800)
      }

      /** Ctrl+Alt+R: revert the change nearest the reading position. */
      function revertAtViewport() {
        if (diffReadOnly || source !== 'working') return
        const node = currentChange('unstaged')
        const hunkIndex = Number(node?.dataset?.hunk ?? -1)
        const lineIndex = Number(node?.dataset?.line ?? NaN)
        if (hunkIndex < 0) return
        const hunks = hunksForRow(node, 'unstaged')
        const run = changeRunIndexes(hunks?.[hunkIndex], lineIndex)
        void revertChanges(
          [run ? { hunk: hunkIndex, lines: run } : { hunk: hunkIndex }],
          tt('diff.revertConfirm'),
          tt('diff.reverted'),
        )
      }

      function state_isBlame() {
        return blame !== null
      }

      async function toggleAnnotate() {
        if (blame) {
          setBlame(null)
          return
        }
        if (!canAnnotate()) return
        const file = entry.path
        try {
          setBlame(await Api.blame(dir, file))
        } catch (cause) {
          reportError(cause)
        }
      }

      async function navigate(delta) {
        if (source === 'turn') return
        const next = index + delta
        if (next < 0) {
          showToast(tt('nav.first'))
          return
        }
        if (next >= entries.length) {
          showToast(tt('nav.last'))
          return
        }
        selectFile(next)
      }

      const workingStaged = source === 'working' ? payload?.staged ?? null : null
      const workingUnstaged = source === 'working' ? payload?.unstaged ?? null : null
      const commitEntry = isRev ? payload ?? entry?.diff ?? null : null
      // What the pane is inspecting: a commit sha, or the stash ref it previews.
      const revLabel = source === 'stash' ? String(target?.ref ?? '') : String(commit?.hash ?? target?.sha ?? '')

      let stats = { additions: 0, deletions: 0 }
      if (source === 'working') stats = diffStatsOf(payload)
      else if (isRev) stats = { additions: commitEntry?.additions ?? 0, deletions: commitEntry?.deletions ?? 0 }

      const kind = source === 'working' ? payload?.entry?.kind : commitEntry?.status ?? entry?.diff?.status
      const badge = kind === 'untracked' ? 'U' : kind === 'added' ? 'A' : kind === 'deleted' ? 'D' : kind === 'renamed' ? 'R' : kind === 'conflicted' ? '!' : 'M'
      const badgeCls = badge === 'U' ? 'u' : badge === 'A' ? 'a' : badge === 'D' ? 'd' : badge === 'R' ? 'r' : badge === '!' ? 'c' : 'm'

      const selectedCount = selection.size
      const selectedSide = [...selection][0]?.split(':')[0] ?? ''
      const selectionDirection = selectedSide === 'staged' ? 'unstage' : 'stage'
      // Hiding an open blame view always works; opening one needs a file git
      // can actually annotate.
      const annotateAvailable = blame !== null || canAnnotate()
      const annotateHint = annotateAvailable ? undefined : tt('diff.annotateNone')

      const bodyChildren = blame
        ? [
            h(
              'div',
              { key: 'blame', className: 'gwb-blame' },
              blame.lines.map((line, position) => {
                const prev = blame.lines[position - 1]
                // One label per run of lines from the same commit: repeating
                // `5542ad4e Robin Chen 2026-10-12` on all 76 lines says nothing
                // and eats half of a sidebar-wide pane.
                const same = prev && prev.hash === line.hash && prev.author === line.author
                const fresh = /^0{8}/.test(String(line.hash))
                return h(
                  'div',
                  {
                    key: line.line,
                    className: `gwb-blamerow${same ? '' : ' run'}${fresh ? ' fresh' : ''}`,
                    title: same ? '' : `${String(line.hash).slice(0, 8)} ${line.author} · ${line.summary || ''}`,
                  },
                  h(
                    'span',
                    { className: 'gwb-blame-label' },
                    same ? null : h('span', { className: 'gwb-blame-who' }, fresh ? tt('blame.uncommitted') : `${String(line.hash).slice(0, 8)} ${line.author}`),
                    same || fresh ? null : h('span', { className: 'gwb-blame-day' }, blameDate(line.time)),
                  ),
                  h('span', { className: 'gwb-blame-ln' }, line.line),
                  h('span', { className: 'gwb-blame-code' }, tokenSpans(highlightTokens(line.text, lang), null, '')),
                )
              }),
            ),
          ]
        : source === 'turn'
          ? renderTurn()
          : isRev
            ? renderRevEntry()
            : renderWorking()

      function renderWorking() {
        if (!payload) return [h('div', { key: 'l', className: 'gwb-loading' }, tt('diff.reading'))]
        if (!payload.staged && !payload.unstaged) {
          // A conflicted file has no two-sided diff to show: both sides live in
          // the worktree markers, so point at the tool that can read them.
          if (payload.entry?.kind === 'conflicted') {
            return [
              h(
                'div',
                { key: 'c', className: 'gwb-empty' },
                tt('diff.conflictedHint'),
                h(
                  'button',
                  {
                    className: 'gwb-btn sm',
                    style: { marginLeft: 8 },
                    onClick: () => openDiff(kit.ctx, { ...target, mode: 'merge' }),
                  },
                  tt('merge.open'),
                ),
              ),
            ]
          }
          if (ignoreWhitespace) {
            return [
              h(
                'div',
                { key: 'e', className: 'gwb-empty' },
                tt('diff.ignoreWsEmpty'),
                h('button', { className: 'gwb-btn sm', style: { marginLeft: 8 }, onClick: toggleIgnoreWhitespace }, tt('diff.ignoreWsShowAll')),
              ),
            ]
          }
          return [h('div', { key: 'e', className: 'gwb-loading' }, tt('diff.none'))]
        }
        const options = { sideBySide: split, selection, readOnly: diffReadOnly, onToggle: toggleLine, lang, expandedFolds, onToggleFold: toggleFold, expandAll }
        return [
          payload.staged
            ? h('div', { key: 's' }, [
                // Each section compares its own two revisions: HEAD→index is
                // not the same pair as index→worktree.
                split ? sideHeader(sideLabels(source, 'staged', commit?.hash ?? target?.sha), 'sh-staged') : null,
                h('div', { key: 't', className: 'gwb-section' }, tt('group.staged')),
                ...renderHunks(payload.staged.hunks, {
                  ...options,
                  side: 'staged',
                  stageHint: tt('unstage.lines'),
                  hunkLabel: tt('unstage.hunk'),
                  hunkAction: (hunkIndex) => void stage({ file: entry.path, direction: 'unstage', mode: 'hunk', hunk: hunkIndex }),
                }),
              ])
            : null,
          payload.unstaged
            ? h('div', { key: 'u' }, [
                split ? sideHeader(sideLabels(source, 'unstaged', commit?.hash ?? target?.sha), 'sh-unstaged') : null,
                h('div', { key: 't', className: 'gwb-section' }, payload.entry?.kind === 'untracked' ? tt('group.untracked') : tt('group.unstaged')),
                ...renderHunks(payload.unstaged.hunks, {
                  ...options,
                  side: 'unstaged',
                  stageHint: tt('stage.lines'),
                  hunkLabel: tt('stage.hunk'),
                  hunkAction: (hunkIndex) => void stage({ file: entry.path, direction: 'stage', mode: 'hunk', hunk: hunkIndex }),
                }),
              ])
            : null,
        ]
      }

      function renderRevEntry() {
        if (!commitEntry || !commitEntry.hunks || commitEntry.hunks.length === 0) {
          if (commitEntry?.binary) return [h('div', { key: 'e', className: 'gwb-loading' }, tt('diff.binary'))]
          if (ignoreWhitespace) {
            return [
              h(
                'div',
                { key: 'e', className: 'gwb-empty' },
                tt('diff.ignoreWsEmpty'),
                h('button', { className: 'gwb-btn sm', style: { marginLeft: 8 }, onClick: toggleIgnoreWhitespace }, tt('diff.ignoreWsShowAll')),
              ),
            ]
          }
          return [h('div', { key: 'e', className: 'gwb-loading' }, tt('diff.noHunks'))]
        }
        return [
          split ? sideHeader(sideLabels(source, null, revLabel), 'sh-commit') : null,
          h('div', { key: 't', className: 'gwb-section' }, tt(source === 'stash' ? 'diff.stashDiff' : 'log.commitDiff')),
          ...renderHunks(commitEntry.hunks, { readOnly: true, sideBySide: split, onToggle: toggleLine, side: 'unstaged', lang, expandedFolds, onToggleFold: toggleFold, expandAll }),
        ]
      }

      function renderTurn() {
        if (entries.length === 0) return [h('div', { key: 'e', className: 'gwb-loading' }, tt('turn.none'))]
        const blocks = []
        for (const item of entries) {
          const hunks = item.diff?.hunks ?? []
          blocks.push(
            h(
              'div',
              { key: item.path, className: 'gwb-turnfile', 'data-turn-index': item.index },
              h(
                'div',
                { className: 'gwb-ovhead' },
                h(Badge, { kind: item.diff?.status ?? 'modified' }),
                h('span', { className: 'gwb-ovpath', title: item.display }, item.display),
                h('span', { className: 'gwb-file-stats', style: { marginLeft: 'auto', color: 'var(--gwb-faint)', fontSize: 11 } }, `+${item.additions ?? 0} −${item.deletions ?? 0}`),
              ),
              !item.diff || item.diff.binary
                ? h('div', { className: 'gwb-loading' }, tt('diff.binary'))
                : hunks.length === 0
                  ? h('div', { className: 'gwb-loading' }, tt('diff.noHunks'))
                  : [
                      split ? sideHeader(sideLabels('turn'), `sh-turn-${item.index}`) : null,
                      ...renderHunks(hunks, {
                        readOnly: true,
                        sideBySide: split,
                        onToggle: toggleLine,
                        side: 'unstaged',
                        fileIndex: item.index,
                        lang: langOf(item.path),
                        expandedFolds,
                        onToggleFold: toggleFold,
                        expandAll,
                      }),
                    ],
            ),
          )
        }
        return [
          h(
            'div',
            { key: 'banner', className: 'gwb-turnbar' },
            h('span', { className: 'gwb-turntag' }, tt('diff.turnTag')),
            h('span', null, tt('diff.turnNote')),
          ),
          ...blocks,
        ]
      }

      const filePicker = h(
        Menu,
        {
          align: 'down',
          title: tt('diff.files'),
          button: h('button', { className: 'gwb-navcount', title: tt('diff.files') }, `${index + 1} / ${entries.length}`),
        },
        entries.map((item, itemIndex) =>
          h(
            MenuRow,
            { key: item.path, current: itemIndex === index, onClick: () => selectFile(itemIndex) },
            h('span', { className: 'gwb-grow', style: { fontFamily: 'var(--gwb-mono)', fontSize: 11 } }, item.display ?? item.path),
          ),
        ),
      )

      return h(
        'div',
        {
          className: 'gwb',
          ref: rootRef,
          tabIndex: -1,
          'data-narrow': wide ? undefined : '1',
          'data-view': split ? 'split' : 'unified',
          onKeyDown: (event) => {
            if (event.key === 'F7') {
              event.preventDefault()
              void jumpHunk(event.shiftKey ? -1 : 1)
            } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
              event.preventDefault()
              void navigate(event.key === 'ArrowUp' ? -1 : 1)
            } else if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'r') {
              event.preventDefault()
              revertAtViewport()
            } else if (event.key === 'Escape') {
              if (canClose) onClose()
            } else if (event.key === 'F5' && source === 'working') {
              event.preventDefault()
              void reloadWorking()
            }
          },
        },
        h(
          'div',
          { className: 'gwb-diffhead' },
          h('span', { className: 'gwb-badge', style: { color: statusColor(kind) } }, badge),
          // The revision being inspected, so the pane labels below have context.
          isRev && revLabel
            ? h(
                'span',
                { className: 'gwb-sha', title: source === 'stash' ? String(commit?.subject ?? revLabel) : revLabel },
                source === 'stash' ? tt('diff.stashTag', { ref: revLabel }) : revLabel.slice(0, 8),
              )
            : null,
          // Row 1 carries file identity only.
          h(
            'div',
            { className: 'gwb-diffname', title: entry?.display ?? entry?.path ?? '' },
            breadcrumb(entry?.display ?? entry?.path ?? ''),
          ),
          h('span', { style: { flex: 1 } }),
          h(
            'div',
            { className: 'gwb-actions' },
            readOnly || ignoreWhitespace
              ? h(
                  'span',
                  { className: `gwb-readonly${ignoreWhitespace ? ' gwb-ws-lock' : ''}`, title: ignoreWhitespace ? tt('diff.ignoreWsNote') : undefined },
                  ignoreWhitespace ? tt(wide ? 'diff.ignoreWsReadonly' : 'diff.ignoreWsLocked') : tt(source === 'working' ? 'diff.readonlyMode' : source === 'stash' ? 'diff.readonlyStash' : 'diff.readonly'),
                )
              : null,
            source === 'working'
              ? h(
                  'button',
                  { className: 'gwb-btn sm ghost', disabled: !annotateAvailable, title: annotateHint, onClick: () => void toggleAnnotate() },
                  blame ? tt('blame.hide') : tt('diff.annotate'),
                )
              : null,
            canClose ? IconBtn({ title: tt('diff.close'), onClick: onClose }, h(GitIcons.close, { size: 13 })) : null,
          ),
        ),
        h(
          'div',
          { className: 'gwb-difftoolbar' },
          // Row 2 is the control strip, in review order: change navigation,
          // then the file switcher, then the change budget, then the view mode.
          h(
            'div',
            { className: 'gwb-hunknav', title: tt('nav.hunk') },
            IconBtn({ title: tt('nav.hunkPrev'), onClick: () => void jumpHunk(-1) }, h(GitIcons.chevUp, { size: 13 })),
            h(
              'span',
              { className: 'gwb-label', title: hunkCount > 0 ? tt('diff.hunkCounter', { current: Math.min(activeHunk + 1, hunkCount), total: hunkCount }) : tt('nav.hunk') },
              hunkCount > 0 ? `${Math.min(activeHunk + 1, hunkCount)}/${hunkCount}` : '—',
            ),
            IconBtn({ title: tt('nav.hunkNext'), onClick: () => void jumpHunk(1) }, h(GitIcons.chevDown, { size: 13 })),
          ),
          source !== 'turn' && entries.length > 1
            ? h(
                'div',
                { className: 'gwb-diffnav' },
                IconBtn({ title: tt('nav.prev'), onClick: () => void navigate(-1) }, h(GitIcons.chevLeft, { size: 13 })),
                filePicker,
                IconBtn({ title: tt('nav.next'), onClick: () => void navigate(1) }, h(GitIcons.chevRight, { size: 13 })),
              )
            : null,
          h(
            'span',
            { className: 'gwb-diffstats' },
            h('span', { className: 'gwb-plus' }, `+${stats.additions}`),
            h('span', { className: 'gwb-minus' }, `−${stats.deletions}`),
          ),
          source !== 'turn'
            ? h(
                'button',
                {
                  className: `gwb-btn sm ctl${ignoreWhitespace ? ' on' : ''}`,
                  title: tt('diff.ignoreWsHint'),
                  'aria-pressed': ignoreWhitespace,
                  onClick: toggleIgnoreWhitespace,
                },
                tt('diff.ignoreWs'),
              )
            : null,
          h(
            'button',
            {
              className: 'gwb-btn sm ctl',
              title: wide ? undefined : tt('diff.narrowAuto'),
              onClick: toggleSideBySide,
            },
            split ? tt('diff.side') : tt('diff.unified'),
          ),
          !diffReadOnly && selectedCount > 0
            ? [
                h('span', { key: 'c', className: 'gwb-chip-meta' }, tt('selection.count', { count: selectedCount })),
                h('button', { key: 'a', className: 'gwb-btn sm primary', onClick: () => void applySelection(selectionDirection) }, tt(selectionDirection === 'stage' ? 'stage.lines' : 'unstage.lines')),
                // Only the worktree side can be rolled back; staged lines are
                // moved out of the index instead.
                source === 'working' && selectedSide === 'unstaged'
                  ? h(
                      'button',
                      {
                        key: 'd',
                        className: 'gwb-btn sm danger',
                        onClick: () =>
                          void revertChanges(
                            selectionBySide('unstaged'),
                            tt('diff.revertLinesConfirm', { count: selectedCount }),
                            tt('diff.revertedLines'),
                          ),
                      },
                      tt('diff.revertLines'),
                    )
                  : null,
                h('button', { key: 'b', className: 'gwb-btn sm ghost', onClick: () => setSelection(new Set()) }, tt('selection.clear')),
              ]
            : null,
          !diffReadOnly
            ? [
                workingUnstaged ? h('button', { key: 'sf', className: 'gwb-btn sm ctl', style: { marginLeft: 'auto' }, onClick: () => void stage({ file: entry?.path, direction: 'stage', mode: 'file' }) }, tt('stage.file')) : null,
                workingStaged ? h('button', { key: 'uf', className: 'gwb-btn sm ctl', onClick: () => void stage({ file: entry?.path, direction: 'unstage', mode: 'file' }) }, tt('unstage.file')) : null,
              ]
            : null,
        ),
        h(
          'div',
          {
            className: `gwb-diffbody${config().diffWrap === false ? ' gwb-nowrap' : ''}`,
            ref: bodyRef,
            onContextMenu: onRowContext,
          },
          error
            ? h(
                'div',
                { className: 'gwb-error' },
                localizeError(error),
                // The turn snapshot is the one source a retry cannot fix: the
                // host drops it when the session closes. The working tree is
                // the same file's diff, and it is still there.
                source === 'turn'
                  ? h(
                      'button',
                      { className: 'gwb-btn sm', onClick: () => openTab(kit.ctx, COMMIT_KIND) },
                      tt('diff.openWorking'),
                    )
                  : null,
              )
            : bodyChildren,
        ),
      )
    }


    /* ------------------------------------------------- conflict (merge) view */

    /**
     * JetBrains' Merge tool in the same pane: the agreed lines stay in place
     * and every conflict block shows both sides next to each other, with the
     * ancestor available above. Decisions are per block, so a file settles
     * region by region instead of all-or-nothing — and the last block stages
     * the file by itself.
     */
    function MergeView({ target, sessionDir, canClose, onClose }) {
      const dir = target?.dir || sessionDir || ''
      const file = String(target?.file ?? '')
      const readOnly = config().readOnly === true
      const lang = langOf(file)
      const [view, setView] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [active, setActive] = useState(0)
      const [showBase, setShowBase] = useState(false)
      const [openRuns, setOpenRuns] = useState(() => new Set())
      // A block being hand-edited: { index, text }. Only one editor is open at
      // a time so the pane keeps a single place where typing lands.
      const [editing, setEditing] = useState(null)
      // Two readable columns need the same room the split diff asks for.
      const [wide, setWide] = useState(true)
      const rootRef = useRef(null)
      const regionRefs = useRef([])
      const closeTimer = useRef(0)
      const viewKey = `${dir}\n${file}`

      const read = useCallback(async () => {
        try {
          const next = await Api.conflictView(dir, file)
          setView(next)
          setError(null)
          return next
        } catch (err) {
          setError(err)
          return null
        }
      }, [dir, file])

      useEffect(() => {
        setView(null)
        setActive(0)
        setEditing(null)
        setOpenRuns(new Set())
        void read()
      }, [read])
      useEffect(() => () => clearTimeout(closeTimer.current), [])
      useRepoChanges(dir, () => { void read() })
      useEffect(() => {
        const node = rootRef.current
        if (!node || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver((entries) => setWide((entries[0]?.contentRect?.width ?? 0) >= 760))
        observer.observe(node)
        return () => observer.disconnect()
      }, [viewKey])
      useFocusOnShow(rootRef)

      const regions = useMemo(() => (view?.segments ?? []).filter((segment) => segment.kind === 'conflict'), [view])

      // Deciding the last block finishes the file, so the pane retires itself
      // the way the IDE's merge tool does and leaves the normal diff behind.
      // A view that never had a block stays open: it is a delete/modify
      // conflict, and the notice is the only answer we can give.
      function retire(next) {
        const had = (view?.segments ?? []).some((segment) => segment.kind === 'conflict')
        const left = (next?.segments ?? []).some((segment) => segment.kind === 'conflict')
        if (!canClose || !had || left) return
        closeTimer.current = setTimeout(() => onClose(), 900)
      }

      async function decide(region, strategy) {
        if (readOnly || busy) return
        setBusy(true)
        try {
          const result = await Api.resolveRegion(dir, { file, region, strategy })
          const next = await read()
          setEditing(null)
          setActive(result.remaining > 0 ? Math.min(region, result.remaining - 1) : 0)
          showToast(result.remaining === 0 ? tt('merge.resolved') : tt('merge.remaining', { count: result.remaining }))
          if (result.remaining === 0) retire(next)
        } catch (err) {
          setError(err)
        } finally {
          setBusy(false)
        }
      }

      // The merged result is free text: the two sides are only a starting
      // point, so a block can be finished the way the author wants instead of
      // picking a whole side.
      async function applyCustom(region) {
        if (readOnly || busy || !editing) return
        setBusy(true)
        try {
          const result = await Api.resolveRegion(dir, { file, region, strategy: 'custom', result: editing.text })
          const next = await read()
          setEditing(null)
          setActive(result.remaining > 0 ? Math.min(region, result.remaining - 1) : 0)
          showToast(result.remaining === 0 ? tt('merge.resolved') : tt('merge.remaining', { count: result.remaining }))
          if (result.remaining === 0) retire(next)
        } catch (err) {
          setError(err)
        } finally {
          setBusy(false)
        }
      }

      function startEdit(segment) {
        const lines = segment.ours.length > 0 ? segment.ours : segment.theirs
        setEditing({ index: segment.index, text: lines.join('\n') })
      }

      async function decideAll(strategy) {
        if (readOnly || busy || !view) return
        const action = tt(strategy === 'ours' ? 'merge.allOurs' : strategy === 'theirs' ? 'merge.allTheirs' : 'merge.allBoth')
        if (!(await showConfirm(tt('merge.allConfirm', { count: view.count, action }), { ok: action, danger: strategy !== 'both' }))) return
        setBusy(true)
        try {
          await Api.resolve(dir, { file, strategy })
          const next = await read()
          setEditing(null)
          showToast(tt('merge.resolved'))
          retire(next)
        } catch (err) {
          setError(err)
        } finally {
          setBusy(false)
        }
      }

      function goto(index) {
        if (regions.length === 0) return
        const next = Math.max(0, Math.min(index, regions.length - 1))
        setActive(next)
        regionRefs.current[next]?.scrollIntoView({ block: 'center' })
      }

      const mergeRow = (text, type, mark, key, number) =>
        h(
          'div',
          { key, className: `gwb-drow${type === 'add' ? ' add-row' : type === 'del' ? ' del-row' : ''}`, 'data-mode': 'merge' },
          cellNumber(number ?? null),
          cellBar({ type, cellKey: key, selectable: false }),
          cellCode({ text }, { type, mark, lang }),
        )

      const sideColumn = (segment, side, start) => {
        const lines = side === 'ours' ? segment.ours : segment.theirs
        const other = side === 'ours' ? segment.theirs : segment.ours
        // Index-wise pairing is what git's own side-by-side conflict view does;
        // word marks then point at the token that actually diverges.
        const marks = lines.map((text, i) => {
          if (other[i] === undefined || other[i] === text) return null
          const ranges = wordDiffRanges(side === 'ours' ? text : other[i], side === 'ours' ? other[i] : text)
          const picked = side === 'ours' ? ranges.left : ranges.right
          return picked.length > 0 ? picked : null
        })
        return h(
          'div',
          { key: `${segment.index}-${side}`, className: 'gwb-merge-col' },
          h(
            'div',
            { className: `gwb-merge-label ${side}` },
            h('span', null, tt(side === 'ours' ? 'merge.ours' : 'merge.theirs')),
            h('span', { className: 'gwb-grow' }),
            readOnly
              ? null
              : h(
                  'button',
                  { className: 'gwb-link', disabled: busy, onClick: () => void decide(segment.index, side === 'ours' ? 'ours' : 'theirs') },
                  tt(side === 'ours' ? 'merge.takeOurs' : 'merge.takeTheirs'),
                ),
          ),
          lines.map((text, i) => mergeRow(text, side === 'ours' ? 'add' : 'del', marks[i], `${segment.index}-${side}-${i}`, start + i)),
          lines.length === 0 ? h('div', { className: 'gwb-merge-agree' }, tt(side === 'ours' ? 'merge.oursEmpty' : 'merge.theirsEmpty')) : null,
        )
      }

      // Line numbers keep counting the file as it sits on disk, markers and all,
      // so a conflict row and the context above it read as one document.
      let cursor = 1
      const body = (view?.segments ?? []).map((segment) => {
        if (segment.kind === 'plain') {
          const startNumber = cursor
          const rows = segment.lines.map((text) => {
            const number = cursor
            cursor += 1
            return mergeRow(text, '', null, `p${number}`, number)
          })
          const trimmed = segment.lines.filter((line) => line.trim() !== '').length
          if (trimmed === 0) return null
          // Two conflicts in a long file used to be 1 800 pixels of untouched
          // code apart. Fold the run the same way the diff does, but keep three
          // lines of context on each side so the reader still knows where they
          // are in the file.
          const key = `plain-${startNumber}`
          const hidden = segment.lines.length - 6
          if (segment.lines.length > FOLD_MIN() && hidden > 0 && !openRuns.has(key)) {
            return h(
              'div',
              { key, className: 'gwb-merge-region' },
              rows.slice(0, 3),
              h(
                'div',
                { className: 'gwb-drow gwb-foldrow' },
                h(
                  'div',
                  {
                    className: 'gwb-foldspan',
                    title: tt('diff.expand'),
                    onClick: () => setOpenRuns((previous) => new Set(previous).add(key)),
                  },
                  h('span', { className: 'gwb-hunkmark' }, '⋯'),
                  h('span', null, tt('diff.foldedLines', { count: hidden })),
                ),
              ),
              rows.slice(-3),
            )
          }
          return h('div', { key, className: 'gwb-merge-region' }, rows)
        }
        const oursStart = cursor + 1
        const afterOurs = oursStart + segment.ours.length
        const baseStart = afterOurs + 1
        const theirsStart = segment.base.length > 0 ? baseStart + segment.base.length + 1 : afterOurs + 1
        cursor += segment.raw.length
        const index = segment.index
        return h(
          'div',
          { key: `r${segment.index}`, className: 'gwb-merge-region', ref: (node) => { regionRefs.current[index] = node } },
          h(
            'div',
            { className: 'gwb-merge-head' },
            h('span', { className: 'gwb-merge-n' }, String(segment.index + 1)),
            h('span', { className: 'gwb-faint' }, `L${segment.line}`),
            h('span', { style: { flex: 1 } }),
            readOnly
              ? null
              : [
                  h(
                    'button',
                    { key: 'edit', className: 'gwb-link', disabled: busy, onClick: () => (editing?.index === index ? setEditing(null) : startEdit(segment)) },
                    tt(editing?.index === index ? 'merge.closeEdit' : 'merge.edit'),
                  ),
                  h('button', { key: 'both', className: 'gwb-link', disabled: busy, onClick: () => void decide(segment.index, 'both') }, tt('merge.takeBoth')),
                ],
          ),
          h('div', { className: 'gwb-merge-cols' }, sideColumn(segment, 'ours', oursStart), sideColumn(segment, 'theirs', theirsStart)),
          editing?.index === index
            ? h(
                'div',
                { className: 'gwb-merge-edit' },
                h('div', { className: 'gwb-merge-label' }, h('span', null, tt('merge.result'))),
                h('textarea', {
                  className: 'gwb-merge-text',
                  autoFocus: true,
                  spellCheck: false,
                  value: editing.text,
                  onChange: (event) => setEditing({ index, text: event.target.value }),
                  onKeyDown: (event) => {
                    // The pane closes on Escape; inside the editor it cancels
                    // the edit only.
                    if (event.key === 'Escape') {
                      event.stopPropagation()
                      setEditing(null)
                    } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                      event.preventDefault()
                      void applyCustom(index)
                    }
                  },
                }),
                h(
                  'div',
                  { className: 'gwb-merge-editactions' },
                  h('span', { className: 'gwb-faint' }, tt('merge.editHint')),
                  h('button', { className: 'gwb-btn sm ghost', onClick: () => setEditing(null) }, tt('confirm.cancel')),
                  h('button', { className: 'gwb-btn sm', disabled: busy, onClick: () => void applyCustom(index) }, tt('merge.apply')),
                ),
              )
            : null,
          segment.base.length > 0
            ? h(
                'div',
                { className: 'gwb-merge-base' },
                h('div', { className: 'gwb-merge-label' }, h('span', null, tt('merge.base'))),
                segment.base.map((text, i) => mergeRow(text, '', null, `b${segment.index}-${i}`, baseStart + i)),
              )
            : null,
        )
      })

      return h(
        'div',
        { className: 'gwb gwb-merge', ref: rootRef, tabIndex: -1, 'aria-label': tt('merge.title'), 'data-narrow': wide ? undefined : '1', onKeyDown: (event) => { if (event.key === 'Escape' && canClose) onClose() } },
        h(
          'div',
          { className: 'gwb-diffhead' },
          h('span', { className: 'gwb-badge', style: { color: statusColor('conflicted') } }, '!'),
          h('div', { className: 'gwb-diffname', title: file }, file),
          h('span', { style: { flex: 1 } }),
          h('div', { className: 'gwb-actions' }, readOnly ? h('span', { className: 'gwb-readonly' }, tt('diff.readonlyMode')) : null, canClose ? IconBtn({ title: tt('diff.close'), onClick: onClose }, h(GitIcons.close, { size: 13 })) : null),
        ),
        h(
          'div',
          { className: 'gwb-mergebar' },
          view && regions.length > 0
            ? [
                IconBtn({ key: 'prev', title: tt('merge.prev'), onClick: () => goto(active - 1) }, h(GitIcons.chevUp, { size: 12 })),
                h(
                  'button',
                  { key: 'c', className: 'gwb-mcount', title: tt('merge.regions', { current: active + 1, total: regions.length }), onClick: () => goto(active) },
                  `${active + 1} / ${regions.length}`,
                ),
                IconBtn({ key: 'next', title: tt('merge.next'), onClick: () => goto(active + 1) }, h(GitIcons.chevDown, { size: 12 })),
              ]
            : null,
          h('span', { style: { flex: 1 } }),
          view && view.base !== null
            ? h('button', { className: `gwb-btn sm ctl${showBase ? ' on' : ''}`, onClick: () => setShowBase((value) => !value) }, showBase ? tt('merge.hideBase') : tt('merge.showBase'))
            : null,
          readOnly || !view || regions.length === 0
            ? null
            : h(
                'div',
                // One flex group: at sidebar width the bar wraps, and three
                // loose buttons used to split across the two lines one by one.
                { key: 'bulk', className: 'gwb-merge-bulk' },
                h('button', { key: 'o', className: 'gwb-btn sm ctl', disabled: busy, onClick: () => void decideAll('ours') }, tt('merge.allOurs')),
                h('button', { key: 't', className: 'gwb-btn sm ctl', disabled: busy, onClick: () => void decideAll('theirs') }, tt('merge.allTheirs')),
                h('button', { key: 'b', className: 'gwb-btn sm ctl', disabled: busy, onClick: () => void decideAll('both') }, tt('merge.allBoth')),
              ),
        ),
        showBase && view?.base
          ? h('div', { className: 'gwb-merge-base' }, h('div', { className: 'gwb-merge-label' }, h('span', null, tt('merge.base'))), view.base.split('\n').map((text, i) => mergeRow(text, '', null, `base-${i}`, i + 1)))
          : null,
        h(
          'div',
          { className: `gwb-diffbody${config().diffWrap === false ? ' gwb-nowrap' : ''}` },
          error ? h('div', { className: 'gwb-error' }, localizeError(error)) : null,
          !view && !error ? h('div', { className: 'gwb-loading' }, tt('merge.loading')) : null,
          view && regions.length === 0 ? h('div', { className: 'gwb-empty' }, tt('merge.empty')) : null,
          view && regions.length > 0 ? body : null,
          view && view.complete === false ? h('div', { className: 'gwb-empty' }, tt('merge.broken')) : null,
        ),
      )
    }

    /* --------------------------------------------------- conversation view */

    /**
     * The 差异 tab in the conversation's view ring. Its content follows the
     * published diff target; before the first file opens it explains where to
     * click.
     */
    function GitDiffViewBody(props) {
      const target = useSyncExternalStore(diffTargetStore.subscribe, diffTargetStore.snapshot, diffTargetStore.snapshot)
      // Turn cards identify a session explicitly; every other target belongs to
      // the conversation this view is mounted in.
      const sessionDir = useSessionDirectory(props, target?.session || '')
      if (!target) {
        return h(
          'div',
          { className: 'gwb' },
          h('div', { className: 'gwb-diffhead' }, h('span', { className: 'gwb-title' }, tt('tab.diff'))),
          h('div', { className: 'gwb-body' }, h('div', { className: 'gwb-loading' }, tt('diff.viewHint'))),
        )
      }
      if (!target.dir && !sessionDir) {
        return h(
          'div',
          { className: 'gwb' },
          h('div', { className: 'gwb-diffhead' }, h('span', { className: 'gwb-title' }, tt('tab.diff'))),
          h('div', { className: 'gwb-body' }, h('div', { className: 'gwb-empty' }, tt('repo.unbound'))),
        )
      }
      const Body = target.mode === 'merge' ? MergeView : DiffView
      return h(Safe, null, h(Body, { target, sessionDir, canClose: true, onClose: closeDiffView }))
    }
    return { diffStatsOf, highlightTokens, langOf, lineDiffSpans, wordDiffRanges, unifiedMarks, foldSegments, countChanges, unifiedRows, sideRows, hunkBlock, DiffView, MergeView, GitDiffViewBody }
  },
})
