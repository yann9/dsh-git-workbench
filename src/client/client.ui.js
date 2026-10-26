// dsh-git-workbench — client chunk (native DSH module chunk).
// Registered as a chunk of the plugin's client entry; see browser.js.

window.__ModuleLoader__.load({
  id: '@yann9/dsh-git-workbench',
  chunk: 'client.ui.js',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React
    const kit = require('@yann9/dsh-git-workbench/client.core.js')
    const { service, statusColor } = kit
    const { localizeError, tt } = require('@yann9/dsh-git-workbench/client.i18n.js')

    /* ------------------------------------------------- context menu (right click) */

    const ctxMenuNode = { el: null, cleanup: null }

    /**
     * A floating menu at the cursor — SourceTree-style right-click actions.
     * @param {number} x
     * @param {number} y
     * @param {{ icon?: string, iconSvg?: string, label: string, hint?: string, title?: string, danger?: boolean, onClick?: () => void, sep?: boolean }[]} items
     * @param {{ align?: 'left' | 'right', width?: number }} [options] `right` treats `x` as the right edge; the menu flips above the anchor when it would leave the viewport.
     */
    function openContextMenu(x, y, items, options = {}) {
      closeContextMenu()
      const el = document.createElement('div')
      el.className = 'gwb-menu gwb-ctx'
      el.setAttribute('role', 'menu')
      // Icon-less menus (the pull/push variants) should not grow an empty
      // bullet column.
      const showIcons = items.some((item) => !item.sep && (item.icon || item.iconSvg))
      for (const item of items) {
        if (item.sep) {
          el.appendChild(Object.assign(document.createElement('div'), { className: 'gwb-menu-sep', role: 'separator' }))
          continue
        }
        const row = document.createElement('div')
        row.className = `gwb-menu-row${item.danger ? ' danger' : ''}`
        row.setAttribute('role', 'menuitem')
        row.tabIndex = -1
        // A truncated hint (a url) stays reachable through the tooltip.
        if (item.title) row.title = item.title
        const label = document.createElement('span')
        label.className = 'gwb-grow'
        label.textContent = item.label
        if (showIcons) {
          const icon = document.createElement('span')
          // Every glyph in a menu shares one treatment: a per-item colour would
          // make the column look half-finished. Destructive rows are marked by
          // the `.danger` label instead.
          icon.className = 'gwb-rowicon'
          if (item.iconSvg) icon.innerHTML = item.iconSvg
          else icon.textContent = item.icon ?? '·'
          row.append(icon)
        }
        row.append(label)
        if (item.hint) {
          const hint = document.createElement('span')
          hint.className = 'gwb-meta'
          hint.textContent = item.hint
          row.append(hint)
        }
        row.addEventListener('click', () => {
          closeContextMenu()
          if (item.onClick) item.onClick()
        })
        el.appendChild(row)
      }
      if (options.width) {
        el.style.width = `${options.width}px`
        el.style.minWidth = `${options.width}px`
      }
      // A short variant list sizes to its longest label: the fixed 168px cut
      // 「强制推送（覆盖远程）」 down to 「强制推送（覆盖…」.
      if (options.fit) el.style.width = 'auto'
      el.style.visibility = 'hidden'
      document.body.appendChild(el)
      const width = el.offsetWidth
      const height = el.offsetHeight
      // Anchor dropdowns to the trigger's edge; a cursor menu keeps its point.
      const left = options.align === 'right' ? x - width : x
      // Open upwards instead of sliding over the trigger when there is no room
      // below (the commit bar sits at the bottom of the pane).
      const top = y + height > window.innerHeight - 8 ? y - height : y
      el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`
      el.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`
      el.style.visibility = 'visible'
      const rows = [...el.querySelectorAll('[role="menuitem"]')]
      rows[0]?.focus()
      const onKey = (event) => {
        if (event.key === 'Escape') {
          // The menu owns this Escape: stop it here so an open diff view
          // underneath does not close as well.
          event.preventDefault()
          event.stopPropagation()
          closeContextMenu()
          return
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        if (rows.length === 0) return
        event.preventDefault()
        const at = rows.indexOf(document.activeElement)
        const next = event.key === 'ArrowDown' ? (at + 1) % rows.length : at <= 0 ? rows.length - 1 : at - 1
        rows[next]?.focus()
      }
      el.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && event.target !== el) {
          const row = event.target.closest?.('[role="menuitem"]')
          if (row) {
            event.preventDefault()
            row.click()
          }
        }
      })
      const onOther = () => closeContextMenu()
      // A menu opened from inside another popup (a row ⋯, the pull/push caret)
      // owns the next press that lands on that popup: closing it must not also
      // dismiss the list underneath or run the row under the cursor. A click
      // meant to dismiss the branch actions used to check out whichever branch
      // it landed on, and a click on empty space closed the whole popup.
      const inMenu = (target) => !!target?.closest?.('.gwb-menu')
      // Another menu's trigger replaces this menu in one click; a field only
      // needs this menu gone, so it focuses right away.
      const isTrigger = (target) => !!target?.closest?.('.gwb-rowmore, .gwb-action-caret')
      const isField = (target) => !!target?.closest?.('input, textarea')
      const onOtherPress = (event) => {
        if (el.contains(event.target) || isTrigger(event.target)) return
        if (!inMenu(event.target) || isField(event.target)) {
          closeContextMenu()
          return
        }
        event.preventDefault()
        event.stopPropagation()
      }
      const onOtherClick = (event) => {
        if (el.contains(event.target) || isTrigger(event.target)) return
        if (!inMenu(event.target) || isField(event.target)) {
          closeContextMenu()
          return
        }
        event.preventDefault()
        event.stopPropagation()
        closeContextMenu()
      }
      window.setTimeout(() => {
        // A menu opened in the meantime replaced this one: its listeners would
        // close the newcomer on the next click.
        if (ctxMenuNode.el !== el) return
        document.addEventListener('mousedown', onOtherPress, { capture: true })
        document.addEventListener('click', onOtherClick, { capture: true })
        document.addEventListener('contextmenu', onOther, { capture: true, once: true })
        // Capture phase: React's own Escape handling (e.g. the diff view
        // closing) fires in bubble at the root and must not see this key.
        document.addEventListener('keydown', onKey, { capture: true })
        window.addEventListener('resize', onOther, { once: true })
      })
      ctxMenuNode.el = el
      ctxMenuNode.cleanup = () => {
        el.remove()
        document.removeEventListener('keydown', onKey, { capture: true })
        // The outside-click listener is `once`, but it survives the menu that
        // installed it: left in place it would close the *next* menu.
        document.removeEventListener('mousedown', onOtherPress, { capture: true })
        document.removeEventListener('click', onOtherClick, { capture: true })
        document.removeEventListener('contextmenu', onOther, { capture: true })
        window.removeEventListener('resize', onOther)
      }
    }

    function closeContextMenu() {
      ctxMenuNode.cleanup?.()
      ctxMenuNode.el = null
      ctxMenuNode.cleanup = null
    }

    /** Inline name prompt rendered as a floating menu (创建分支/重命名). */
    function openNamePrompt(x, y, title, placeholder, onSubmit, initialValue = '', okLabel = '') {
      closeContextMenu()
      openContextMenu(x, y, [])
      const el = ctxMenuNode.el
      if (!el) return
      el.innerHTML = ''
      const titleEl = document.createElement('div')
      titleEl.className = 'gwb-menu-title'
      titleEl.textContent = title
      const wrap = document.createElement('div')
      wrap.className = 'gwb-prompt'
      const input = document.createElement('input')
      input.placeholder = placeholder
      input.spellcheck = false
      // A suggested name goes in the field, not in the placeholder: grey hint
      // text cannot be accepted, edited or submitted, so the suggestion was
      // something the user had to retype from memory.
      input.value = initialValue
      const hint = document.createElement('div')
      hint.className = 'gwb-prompt-hint'
      const defaultHint = tt('prompt.hint')
      hint.textContent = defaultHint
      const submit = () => {
        const value = input.value.trim()
        if (!value) {
          // Silent rejection reads as "the button is broken"; say what is wrong.
          hint.textContent = tt('prompt.empty')
          hint.classList.add('error')
          input.classList.add('invalid')
          return
        }
        closeContextMenu()
        onSubmit(value)
      }
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        submit()
      })
      input.addEventListener('input', () => {
        hint.textContent = defaultHint
        hint.classList.remove('error')
        input.classList.remove('invalid')
      })
      const actions = document.createElement('div')
      actions.className = 'gwb-prompt-row'
      const cancel = document.createElement('button')
      cancel.className = 'gwb-btn ghost'
      cancel.textContent = tt('confirm.cancel')
      cancel.addEventListener('click', () => closeContextMenu())
      const ok = document.createElement('button')
      ok.className = 'gwb-btn primary'
      ok.textContent = String(okLabel).trim() || tt('prompt.ok')
      ok.addEventListener('click', submit)
      actions.append(cancel, ok)
      wrap.append(input, hint, actions)
      el.append(titleEl, wrap)
      window.setTimeout(() => {
        input.focus()
        // Pre-filled (a rename, or a generated branch name): selected, so the
        // first keystroke replaces it instead of appending to it.
        if (initialValue !== '') input.select()
      }, 30)
    }

    const toastNode = { el: null, msg: null, x: null, timer: 0 }
    function hideToast() {
      window.clearTimeout(toastNode.timer)
      toastNode.timer = 0
      if (toastNode.el) toastNode.el.style.display = 'none'
    }
    function showToast(message, error = false) {
      if (!toastNode.el) {
        toastNode.el = document.createElement('div')
        toastNode.el.className = 'gwb-toast'
        toastNode.msg = document.createElement('span')
        toastNode.msg.className = 'gwb-toast-msg'
        toastNode.x = document.createElement('button')
        toastNode.x.type = 'button'
        toastNode.x.className = 'gwb-toast-x'
        toastNode.x.setAttribute('aria-label', tt('toast.dismiss'))
        toastNode.x.textContent = '✕'
        toastNode.x.addEventListener('click', hideToast)
        toastNode.el.append(toastNode.msg, toastNode.x)
        document.body.appendChild(toastNode.el)
      }
      toastNode.msg.textContent = message
      toastNode.el.classList.toggle('error', error)
      toastNode.el.setAttribute('role', error ? 'alert' : 'status')
      toastNode.el.setAttribute('aria-live', error ? 'assertive' : 'polite')
      toastNode.x.style.display = error ? 'block' : 'none'
      toastNode.el.style.display = 'block'
      window.clearTimeout(toastNode.timer)
      // A success only has to be seen once; an error that disappears before it
      // can be read is not an error report. The next toast replaces it either way.
      if (!error) toastNode.timer = window.setTimeout(hideToast, 2600)
    }

    function reportError(error) {
      // A folder without a repository is rendered calmly by every pane; a toast
      // would repeat it and expose the raw git command that failed. Background
      // panes (a hidden History tab, for instance) must stay silent about it.
      if (/not a git repository/i.test(String(error?.message ?? error))) return
      showToast(localizeError(error), true)
    }

    /**
     * The server speaks English in its error strings (one language on the
     * wire); the panel shows the operator their own. Match the known contracts
     * — anything unrecognised is shown as-is so new errors are never hidden.
     */

    /**
     * In-theme confirm dialog (the host chrome has no modal service we can
     * rely on). Rendered on a dimmed backdrop — without it the card floats
     * over the app with no visual anchor. Resolves true on the confirm button,
     * false on cancel/Escape/backdrop click.
     * @param {string} message
     * @param {{ ok?: string, danger?: boolean }} [options] `ok` names the verb
     *   the user is agreeing to ("丢弃改动" beats "确定"); `danger` marks an
     *   irreversible one, which gets the error colour and keeps focus on 取消
     *   so Enter can never fire it by reflex.
     * @returns {Promise<boolean>}
     */
    function showConfirm(message, options = {}) {
      const okLabel = String(options.ok ?? '').trim() || tt('confirm.ok')
      const danger = options.danger === true
      return new Promise((resolve) => {
        const backdrop = document.createElement('div')
        backdrop.className = 'gwb-confirm-backdrop'
        const overlay = document.createElement('div')
        overlay.className = 'gwb-confirm'
        overlay.setAttribute('role', 'dialog')
        overlay.setAttribute('aria-modal', 'true')
        const msg = document.createElement('div')
        msg.className = 'gwb-confirm-msg'
        msg.id = `gwb-confirm-${Date.now()}`
        msg.textContent = message
        overlay.setAttribute('aria-labelledby', msg.id)
        const row = document.createElement('div')
        row.className = 'gwb-confirm-row'
        const cancel = document.createElement('button')
        cancel.className = 'gwb-btn ghost'
        cancel.textContent = tt('confirm.cancel')
        const ok = document.createElement('button')
        ok.className = `gwb-btn ${danger ? 'danger' : 'primary'}`
        ok.textContent = okLabel
        row.append(cancel, ok)
        overlay.append(msg, row)
        backdrop.appendChild(overlay)
        document.body.appendChild(backdrop)
        const settle = (value) => {
          backdrop.remove()
          document.removeEventListener('keydown', onKey, true)
          resolve(value)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            settle(false)
          }
        }
        backdrop.addEventListener('mousedown', (event) => {
          if (event.target === backdrop) settle(false)
        })
        cancel.addEventListener('click', () => settle(false))
        ok.addEventListener('click', () => settle(true))
        document.addEventListener('keydown', onKey, true)
        window.setTimeout(() => (danger ? cancel : ok).focus(), 30)
      })
    }

    /**
     * A failing pre-commit check, with its output. This is deliberately richer
     * than showConfirm: a one-line message cannot tell the user *why* the test
     * failed, and "commit anyway" must never be the button Enter reaches first.
     * Resolves true only when the explicit override was clicked.
     * @param {{ result: any, results?: any[], title?: string, okLabel?: string, danger?: boolean }} options
     * @returns {Promise<boolean>}
     */
    function showCheckFailure(options = {}) {
      const result = options.result ?? {}
      const results = Array.isArray(options.results) ? options.results : [result]
      const output = String(result.output ?? '')
      const okLabel = String(options.okLabel ?? '').trim()
      const danger = options.danger === true
      const seconds = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`)
      return new Promise((resolve) => {
        const id = `gwb-check-${Date.now()}`
        const backdrop = document.createElement('div')
        backdrop.className = 'gwb-confirm-backdrop'
        const dialog = document.createElement('div')
        dialog.className = 'gwb-confirm gwb-check-dialog'
        dialog.setAttribute('role', 'dialog')
        dialog.setAttribute('aria-modal', 'true')
        dialog.setAttribute('aria-labelledby', id)

        const head = document.createElement('div')
        head.className = 'gwb-check-head'
        const icon = document.createElement('span')
        icon.className = 'gwb-check-ico'
        icon.innerHTML = iconMarkup('close', 12)
        const headText = document.createElement('div')
        headText.className = 'gwb-check-headtext'
        const title = document.createElement('div')
        title.className = 'gwb-check-title'
        title.id = id
        title.textContent = options.title || tt('checks.failTitle', { script: result.script ?? '' })
        const meta = document.createElement('div')
        meta.className = 'gwb-check-meta'
        meta.textContent = [
          result.command,
          result.timedOut ? tt('checks.timedOut') : tt('checks.exit', { code: result.code ?? '?' }),
          Number.isFinite(result.ms) ? seconds(result.ms) : '',
        ].filter(Boolean).join(' · ')
        headText.append(title, meta)
        const copy = document.createElement('button')
        copy.className = 'gwb-btn sm ghost gwb-check-copy'
        copy.textContent = tt('checks.copy')
        head.append(icon, headText, copy)

        const chips = document.createElement('div')
        chips.className = 'gwb-check-chips'
        for (const item of results) {
          const chip = document.createElement('span')
          chip.className = `gwb-check-chip ${item?.ok ? 'pass' : 'fail'}`
          chip.textContent = `${item?.ok ? '✓' : '✗'} ${item?.script ?? ''}`
          chips.appendChild(chip)
        }

        const pre = document.createElement('pre')
        pre.className = 'gwb-check-output'
        pre.tabIndex = 0
        pre.textContent = output.trim() === '' ? tt('checks.noOutput') : output

        const actions = document.createElement('div')
        actions.className = 'gwb-confirm-row'
        const close = document.createElement('button')
        close.className = 'gwb-btn ghost'
        close.textContent = okLabel ? tt('confirm.cancel') : tt('checks.close')
        actions.appendChild(close)
        let ok = null
        if (okLabel) {
          ok = document.createElement('button')
          ok.className = `gwb-btn ${danger ? 'danger' : 'primary'}`
          ok.textContent = okLabel
          actions.appendChild(ok)
        }

        dialog.append(head, chips, pre, actions)
        backdrop.appendChild(dialog)
        document.body.appendChild(backdrop)

        const settle = (value) => {
          backdrop.remove()
          document.removeEventListener('keydown', onKey, true)
          resolve(value)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            settle(false)
          }
        }
        backdrop.addEventListener('mousedown', (event) => {
          if (event.target === backdrop) settle(false)
        })
        copy.addEventListener('click', () => {
          copy.textContent = tt('checks.copied')
          window.setTimeout(() => { copy.textContent = tt('checks.copy') }, 1400)
          try {
            const written = navigator.clipboard?.writeText(output)
            if (written && typeof written.catch === 'function') written.catch(() => {})
          } catch {
            /* clipboard unavailable */
          }
        })
        close.addEventListener('click', () => settle(false))
        ok?.addEventListener('click', () => settle(true))
        document.addEventListener('keydown', onKey, true)
        ;(danger ? close : ok ?? close).focus()
      })
    }

    /**
     * Stash dialog. `git stash push` can shelve a subset, but the menu used to
     * run it blind with a generated name — there was no way to say what the
     * stash is for, or to leave the rest of the changes in the worktree.
     * Resolves `{ message, paths }` (an empty message means git's own name),
     * or null when dismissed.
     * @param {{ files: { path: string, kind: string, origPath?: string | null }[], message?: string }} options
     * @returns {Promise<{ message: string, paths: string[] } | null>}
     */
    function showStashDialog(options = {}) {
      const files = Array.isArray(options.files) ? options.files : []
      return new Promise((resolve) => {
        const id = `gwb-stash-${Date.now()}`
        const letter = (kind) => (kind === 'untracked' ? 'U' : kind === 'added' ? 'A' : kind === 'deleted' ? 'D' : kind === 'renamed' ? 'R' : kind === 'conflicted' ? '!' : 'M')

        const backdrop = document.createElement('div')
        backdrop.className = 'gwb-confirm-backdrop'
        const dialog = document.createElement('div')
        dialog.className = 'gwb-confirm gwb-stash-dialog'
        dialog.setAttribute('role', 'dialog')
        dialog.setAttribute('aria-modal', 'true')
        const title = document.createElement('div')
        title.className = 'gwb-stash-title'
        title.id = id
        title.textContent = tt('stash.title')
        dialog.setAttribute('aria-labelledby', id)

        const label = document.createElement('label')
        label.className = 'gwb-stash-label'
        label.textContent = tt('stash.message')
        label.setAttribute('for', `${id}-msg`)
        const input = document.createElement('input')
        input.className = 'gwb-stash-input'
        input.id = `${id}-msg`
        input.type = 'text'
        input.spellcheck = false
        input.value = String(options.message ?? '')
        input.placeholder = tt('stash.messagePlaceholder')
        const hint = document.createElement('div')
        hint.className = 'gwb-stash-hint'
        hint.textContent = tt('stash.messageHint')

        const head = document.createElement('div')
        head.className = 'gwb-stash-files-head'
        const headLabel = document.createElement('span')
        headLabel.className = 'gwb-stash-label'
        headLabel.textContent = tt('stash.files')
        const allBtn = document.createElement('button')
        allBtn.type = 'button'
        allBtn.className = 'gwb-btn ghost sm'
        head.append(headLabel, allBtn)

        const list = document.createElement('div')
        list.className = 'gwb-stash-list'
        list.setAttribute('role', 'group')
        list.setAttribute('aria-label', tt('stash.files'))
        const boxes = files.map((file) => {
          const row = document.createElement('label')
          row.className = 'gwb-stash-file'
          row.title = file.origPath ? `${file.origPath} → ${file.path}` : file.path
          const box = document.createElement('input')
          box.type = 'checkbox'
          box.checked = true
          const badge = document.createElement('span')
          badge.className = 'gwb-badge'
          badge.style.color = statusColor(file.kind)
          badge.textContent = letter(file.kind)
          const pathEl = document.createElement('span')
          pathEl.className = 'gwb-stash-path'
          const cut = file.path.lastIndexOf('/')
          if (cut > 0) {
            const dir = document.createElement('span')
            dir.className = 'gwb-stash-dir'
            dir.textContent = file.path.slice(0, cut + 1)
            const name = document.createElement('span')
            name.textContent = file.path.slice(cut + 1)
            pathEl.append(dir, name)
          } else {
            pathEl.textContent = file.path
          }
          row.append(box, badge, pathEl)
          list.append(row)
          return { box, path: file.path, alt: file.origPath ?? null }
        })

        const row = document.createElement('div')
        row.className = 'gwb-stash-row'
        const countEl = document.createElement('span')
        countEl.className = 'gwb-stash-count'
        const cancel = document.createElement('button')
        cancel.className = 'gwb-btn ghost'
        cancel.textContent = tt('confirm.cancel')
        const ok = document.createElement('button')
        ok.className = 'gwb-btn primary'
        ok.textContent = tt('stash.ok')
        row.append(countEl, cancel, ok)
        dialog.append(title, label, input, hint, head, list, row)
        backdrop.appendChild(dialog)
        document.body.appendChild(backdrop)

        const selected = () => boxes.filter((entry) => entry.box.checked)
        const picked = () => {
          // A rename is two paths; selecting its row has to carry both or the
          // shelf restores half of it and leaves the deletion staged.
          const out = new Set()
          for (const entry of selected()) {
            out.add(entry.path)
            if (entry.alt) out.add(entry.alt)
          }
          return [...out]
        }
        const sync = () => {
          const count = selected().length
          const all = count === boxes.length
          ok.disabled = count === 0
          countEl.textContent = count === 0 ? tt('stash.none') : tt('stash.selected', { count, total: boxes.length })
          countEl.classList.toggle('error', count === 0)
          allBtn.textContent = all ? tt('stash.selectNone') : tt('stash.selectAll')
        }
        const settle = (value) => {
          backdrop.remove()
          document.removeEventListener('keydown', onKey, true)
          resolve(value)
        }
        const submit = () => {
          const rows = selected()
          if (rows.length === 0) {
            sync()
            input.focus()
            return
          }
          settle({
            message: input.value.trim(),
            // Everything ticked is an ordinary whole-worktree stash: no pathspec
            // means git keeps its own rename/staging handling unchanged.
            paths: rows.length === boxes.length ? [] : picked(),
            count: rows.length,
          })
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            settle(null)
          }
        }

        for (const entry of boxes) entry.box.addEventListener('change', sync)
        allBtn.addEventListener('click', () => {
          const all = selected().length === boxes.length
          for (const entry of boxes) entry.box.checked = !all
          sync()
        })
        input.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          submit()
        })
        backdrop.addEventListener('mousedown', (event) => {
          if (event.target === backdrop) settle(null)
        })
        cancel.addEventListener('click', () => settle(null))
        ok.addEventListener('click', submit)
        document.addEventListener('keydown', onKey, true)
        sync()
        window.setTimeout(() => {
          input.focus()
          input.select()
        }, 30)
      })
    }

    /**
     * Git refuses a commit it cannot attribute. The dialog collects the two
     * values it asks for and hands them back; the caller writes them and
     * retries, so this stays a form and never talks to the API itself.
     * @param {{ name?: string, email?: string, scope?: 'local' | 'global' }} options
     * @returns {Promise<{ name: string, email: string, global: boolean } | null>}
     */
    function showIdentityDialog(options = {}) {
      return new Promise((resolve) => {
        const id = `gwb-identity-${Date.now()}`
        const backdrop = document.createElement('div')
        backdrop.className = 'gwb-confirm-backdrop'
        const dialog = document.createElement('div')
        dialog.className = 'gwb-confirm gwb-stash-dialog gwb-identity'
        dialog.setAttribute('role', 'dialog')
        dialog.setAttribute('aria-modal', 'true')
        const title = document.createElement('div')
        title.className = 'gwb-stash-title'
        title.id = id
        title.textContent = tt('identity.title')
        dialog.setAttribute('aria-labelledby', id)
        const hint = document.createElement('div')
        hint.className = 'gwb-stash-hint'
        hint.textContent = tt('identity.hint')
        dialog.append(title, hint)

        const field = (labelKey, placeholder, value, type = 'text') => {
          const label = document.createElement('label')
          label.className = 'gwb-stash-label'
          label.textContent = tt(labelKey)
          const input = document.createElement('input')
          input.className = 'gwb-stash-input'
          input.type = type
          input.spellcheck = false
          input.autocomplete = 'off'
          input.value = value
          input.placeholder = placeholder
          input.id = `${id}-${labelKey.replace('.', '-')}`
          label.setAttribute('for', input.id)
          dialog.append(label, input)
          return input
        }
        const nameInput = field('identity.name', tt('identity.namePlaceholder'), String(options.name ?? ''))
        const emailInput = field('identity.email', tt('identity.emailPlaceholder'), String(options.email ?? ''), 'email')

        // Repository-local by default: a global write changes who the user is
        // in every other repository, which one dialog should not decide.
        const onlyHere = document.createElement('label')
        onlyHere.className = 'gwb-identity-scope'
        const scopeBox = document.createElement('input')
        scopeBox.type = 'checkbox'
        scopeBox.checked = options.scope !== 'global'
        const scopeText = document.createElement('span')
        scopeText.textContent = tt('identity.onlyHere')
        onlyHere.append(scopeBox, scopeText)

        const row = document.createElement('div')
        row.className = 'gwb-stash-row'
        const error = document.createElement('span')
        error.className = 'gwb-stash-count'
        const cancel = document.createElement('button')
        cancel.className = 'gwb-btn ghost'
        cancel.textContent = tt('confirm.cancel')
        const ok = document.createElement('button')
        ok.className = 'gwb-btn primary'
        ok.textContent = tt('identity.ok')
        row.append(error, cancel, ok)
        dialog.append(onlyHere, row)
        backdrop.appendChild(dialog)
        document.body.appendChild(backdrop)

        const valid = () => /^[^\s@]+@[^\s@]+$/.test(emailInput.value.trim()) && nameInput.value.trim() !== ''
        const sync = () => {
          ok.disabled = !valid()
        }
        const settle = (value) => {
          backdrop.remove()
          document.removeEventListener('keydown', onKey, true)
          resolve(value)
        }
        const submit = () => {
          if (!valid()) {
            error.textContent = tt('identity.invalid')
            error.classList.add('error')
            ;(nameInput.value.trim() === '' ? nameInput : emailInput).focus()
            return
          }
          settle({
            name: nameInput.value.trim(),
            email: emailInput.value.trim(),
            global: !scopeBox.checked,
          })
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            settle(null)
          }
        }

        nameInput.addEventListener('input', sync)
        emailInput.addEventListener('input', sync)
        for (const input of [nameInput, emailInput]) {
          input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            submit()
          })
        }
        backdrop.addEventListener('mousedown', (event) => {
          if (event.target === backdrop) settle(null)
        })
        cancel.addEventListener('click', () => settle(null))
        ok.addEventListener('click', submit)
        document.addEventListener('keydown', onKey, true)
        sync()
        window.setTimeout(() => nameInput.focus(), 30)
      })
    }

    /**
     * Remote manager (the IDE's "Manage Remotes"). Every configured remote
     * with its URL, plus a form to add one and buttons to edit or drop it.
     * The dialog owns no git state: it asks the host and re-renders whatever
     * the host reports, so the list can never drift from `.git/config`.
     * @param {{ load: () => Promise<{name: string, url: string, pushUrl?: string}[]>,
     *           add: (name: string, url: string) => Promise<void>,
     *           edit: (name: string, url: string) => Promise<void>,
     *           remove: (name: string) => Promise<void>,
     *           onClose?: () => void }} options
     */
    function showRemotesDialog(options = {}) {
      const load = options.load ?? (async () => [])
      const add = options.add ?? (async () => {})
      const edit = options.edit ?? (async () => {})
      const remove = options.remove ?? (async () => {})

      const backdrop = document.createElement('div')
      backdrop.className = 'gwb-confirm-backdrop'
      const dialog = document.createElement('div')
      dialog.className = 'gwb-remotes'
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')

      const title = document.createElement('div')
      title.className = 'gwb-remotes-title'
      title.textContent = tt('remote.title')

      const list = document.createElement('div')
      list.className = 'gwb-remotes-list'

      const empty = document.createElement('div')
      empty.className = 'gwb-remotes-empty'
      empty.textContent = tt('remote.empty')

      const error = document.createElement('div')
      error.className = 'gwb-remotes-error'

      const form = document.createElement('div')
      form.className = 'gwb-remote-form'
      // The manager opens on the list; the form only appears on add/edit.
      form.hidden = true
      const nameLabel = document.createElement('label')
      nameLabel.className = 'gwb-remote-label'
      nameLabel.textContent = tt('remote.name')
      const nameInput = document.createElement('input')
      nameInput.className = 'gwb-remote-input'
      nameInput.type = 'text'
      nameInput.spellcheck = false
      nameInput.placeholder = 'origin'
      const urlLabel = document.createElement('label')
      urlLabel.className = 'gwb-remote-label'
      urlLabel.textContent = tt('remote.url')
      const urlInput = document.createElement('input')
      urlInput.className = 'gwb-remote-input'
      urlInput.type = 'text'
      urlInput.spellcheck = false
      urlInput.placeholder = 'https://github.com/owner/repo.git'
      const hint = document.createElement('div')
      hint.className = 'gwb-prompt-hint'
      hint.textContent = tt('prompt.hint')
      const formRow = document.createElement('div')
      formRow.className = 'gwb-prompt-row'
      const formCancel = document.createElement('button')
      formCancel.className = 'gwb-btn ghost'
      formCancel.textContent = tt('confirm.cancel')
      const formOk = document.createElement('button')
      formOk.className = 'gwb-btn primary'
      formOk.textContent = tt('remote.add')
      form.append(nameLabel, nameInput, urlLabel, urlInput, hint, formRow)
      formRow.append(formCancel, formOk)

      const foot = document.createElement('div')
      foot.className = 'gwb-remotes-foot'
      const close = document.createElement('button')
      close.className = 'gwb-btn ghost'
      close.textContent = tt('confirm.close')
      const addBtn = document.createElement('button')
      addBtn.className = 'gwb-btn primary'
      addBtn.textContent = tt('remote.addTitle')
      foot.append(close, addBtn)

      dialog.append(title, list, empty, error, form, foot)
      backdrop.appendChild(dialog)
      document.body.appendChild(backdrop)

      /** @type {{name: string, url: string, pushUrl?: string}[]} */
      let remotes = []
      /** 'list' shows the remotes, 'form' shows the add/edit fields. */
      let mode = 'list'
      /** The remote being edited, or null while adding. */
      let editing = null
      let busy = false

      const setError = (message) => {
        error.textContent = message ?? ''
        error.classList.toggle('visible', Boolean(message))
      }

      const renderList = () => {
        list.innerHTML = ''
        remotes.forEach((remote) => {
          const row = document.createElement('div')
          row.className = 'gwb-remote'
          const name = document.createElement('span')
          name.className = 'gwb-remote-name'
          name.textContent = remote.name
          const url = document.createElement('span')
          url.className = 'gwb-remote-url'
          url.textContent = remote.url
          url.title = remote.url
          const actions = document.createElement('span')
          actions.className = 'gwb-remote-actions'
          const editBtn = document.createElement('button')
          editBtn.type = 'button'
          editBtn.className = 'gwb-btn ghost sm'
          editBtn.textContent = tt('remote.edit')
          editBtn.addEventListener('click', () => {
            editing = remote
            nameInput.value = remote.name
            urlInput.value = remote.url
            mode = 'form'
            formOk.textContent = tt('remote.save')
            form.hidden = false
            list.hidden = true
            empty.hidden = true
            foot.hidden = true
            setError('')
            nameInput.focus()
            nameInput.select()
          })
          const removeBtn = document.createElement('button')
          removeBtn.type = 'button'
          removeBtn.className = 'gwb-btn ghost sm danger'
          removeBtn.textContent = tt('remote.remove')
          removeBtn.addEventListener('click', async () => {
            if (busy) return
            const ok = await showConfirm(tt('remote.removeConfirm', { name: remote.name }), {
              ok: tt('remote.remove'),
              danger: true,
            })
            if (!ok) return
            busy = true
            removeBtn.disabled = true
            try {
              await remove(remote.name)
              await refresh()
            } catch (cause) {
              setError(localizeError(cause))
            } finally {
              busy = false
              removeBtn.disabled = false
            }
          })
          actions.append(editBtn, removeBtn)
          row.append(name, url, actions)
          list.appendChild(row)
        })
        list.hidden = remotes.length === 0
        empty.hidden = remotes.length > 0
      }

      const showForm = (remote) => {
        editing = remote ?? null
        nameInput.value = remote?.name ?? ''
        urlInput.value = remote?.url ?? ''
        formOk.textContent = remote ? tt('remote.save') : tt('remote.add')
        mode = 'form'
        form.hidden = false
        list.hidden = true
        empty.hidden = true
        foot.hidden = true
        setError('')
        nameInput.focus()
        nameInput.select()
      }

      const showList = () => {
        mode = 'list'
        editing = null
        form.hidden = true
        foot.hidden = false
        setError('')
        renderList()
      }

      const refresh = async () => {
        const next = await load()
        remotes = Array.isArray(next) ? next : []
        renderList()
      }

      const submit = async () => {
        if (busy) return
        const name = nameInput.value.trim()
        const url = urlInput.value.trim()
        if (!name) {
          setError(tt('remote.nameRequired'))
          nameInput.focus()
          return
        }
        if (!url) {
          setError(tt('remote.urlRequired'))
          urlInput.focus()
          return
        }
        busy = true
        formOk.disabled = true
        try {
          if (editing) await edit(editing.name, url)
          else await add(name, url)
          await refresh()
          showList()
        } catch (cause) {
          setError(localizeError(cause))
        } finally {
          busy = false
          formOk.disabled = false
        }
      }

      const onKey = (event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        // A confirmation opened on top of this dialog owns the Escape key:
        // both listen on the document in the capture phase, so stopping the
        // propagation does not keep this one from running.
        const onTop = [...document.querySelectorAll('.gwb-confirm-backdrop')]
          .some((node) => node !== backdrop && node.offsetWidth > 0)
        if (onTop) return
        if (mode === 'form') showList()
        else settle()
      }

      const settle = () => {
        backdrop.remove()
        document.removeEventListener('keydown', onKey, true)
        options.onClose?.()
      }

      nameInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        submit()
      })
      urlInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        submit()
      })
      nameInput.addEventListener('input', () => setError(''))
      urlInput.addEventListener('input', () => setError(''))
      formCancel.addEventListener('click', showList)
      formOk.addEventListener('click', submit)
      addBtn.addEventListener('click', () => showForm(null))
      close.addEventListener('click', settle)
      backdrop.addEventListener('mousedown', (event) => {
        if (event.target === backdrop) settle()
      })
      document.addEventListener('keydown', onKey, true)

      void refresh()
      window.setTimeout(() => close.focus(), 30)
      return { close: settle }
    }

    /**
     * Message editor for Reword. Only the text changes: the host amends HEAD
     * or replays the same commits with a `reword` line, so the tree never
     * moves. Resolves the trimmed message, or null when dismissed.
     * @param {{ message?: string }} options
     * @returns {Promise<string | null>}
     */
    function showRewordDialog(options = {}) {
      return new Promise((resolve) => {
        const id = `gwb-reword-${Date.now()}`
        const backdrop = document.createElement('div')
        backdrop.className = 'gwb-confirm-backdrop'
        const dialog = document.createElement('div')
        dialog.className = 'gwb-confirm gwb-stash-dialog gwb-reword-dialog'
        dialog.setAttribute('role', 'dialog')
        dialog.setAttribute('aria-modal', 'true')
        const title = document.createElement('div')
        title.className = 'gwb-stash-title'
        title.id = id
        title.textContent = tt('reword.title')
        dialog.setAttribute('aria-labelledby', id)
        const hint = document.createElement('div')
        hint.className = 'gwb-stash-hint'
        hint.textContent = tt('reword.hint')
        const input = document.createElement('textarea')
        input.className = 'gwb-stash-input gwb-reword-input'
        input.spellcheck = false
        input.value = String(options.message ?? '')
        input.setAttribute('aria-label', tt('reword.title'))
        const error = document.createElement('div')
        error.className = 'gwb-reword-error'
        const keys = document.createElement('span')
        keys.className = 'gwb-stash-hint'
        keys.style.marginRight = 'auto'
        keys.textContent = tt('reword.keys')
        const cancel = document.createElement('button')
        cancel.className = 'gwb-btn ghost'
        cancel.textContent = tt('confirm.cancel')
        const ok = document.createElement('button')
        ok.className = 'gwb-btn primary'
        ok.textContent = tt('reword.save')
        const row = document.createElement('div')
        row.className = 'gwb-stash-row'
        row.append(keys, cancel, ok)
        dialog.append(title, hint, input, error, row)
        backdrop.appendChild(dialog)
        document.body.appendChild(backdrop)
        const settle = (value) => {
          backdrop.remove()
          document.removeEventListener('keydown', onKey, true)
          resolve(value)
        }
        const submit = () => {
          const value = input.value.trim()
          if (!value) {
            error.textContent = tt('reword.empty')
            input.classList.add('is-invalid')
            input.focus()
            return
          }
          settle(value)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            settle(null)
            return
          }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            event.stopPropagation()
            submit()
          }
        }
        input.addEventListener('input', () => {
          error.textContent = ''
          input.classList.remove('is-invalid')
        })
        // Multi-line messages: plain Enter inserts a newline; only the shortcut
        // submits, so the body of the message stays editable.

        backdrop.addEventListener('mousedown', (event) => {
          if (event.target === backdrop) settle(null)
        })
        cancel.addEventListener('click', () => settle(null))
        ok.addEventListener('click', submit)
        document.addEventListener('keydown', onKey, true)
        window.setTimeout(() => {
          input.focus()
          input.setSelectionRange(input.value.length, input.value.length)
          input.scrollTop = input.scrollHeight
        }, 30)
      })
    }

    /**
     * Interactive rebase plan. `git rebase -i` runs with exactly the list left
     * here, oldest first — the same order git prints in its todo. The host
     * rejects a squash on the first kept commit, so that check lives here too
     * and the button stays disabled instead of failing after a round-trip.
     * Resolves `{ entries }`, or null when dismissed.
     * @param {{ base: string, commits: { hash: string, short?: string, subject?: string }[] }} options
     * @returns {Promise<{ entries: { hash: string, action: string }[] } | null>}
     */
    function showRebaseDialog(options = {}) {
      const base = String(options.base ?? '')
      const source = Array.isArray(options.commits) ? options.commits : []
      return new Promise((resolve) => {
        const id = `gwb-rebase-${Date.now()}`
        const rows = source.map((commit) => ({
          hash: String(commit.hash ?? ''),
          short: String(commit.short ?? '').trim() || String(commit.hash ?? '').slice(0, 7),
          subject: String(commit.subject ?? ''),
          action: 'pick',
        }))
        const backdrop = document.createElement('div')
        backdrop.className = 'gwb-confirm-backdrop'
        const dialog = document.createElement('div')
        dialog.className = 'gwb-confirm gwb-rebase-dialog'
        dialog.setAttribute('role', 'dialog')
        dialog.setAttribute('aria-modal', 'true')
        const title = document.createElement('div')
        title.className = 'gwb-rebase-title'
        title.id = id
        title.textContent = tt('rebase.title')
        dialog.setAttribute('aria-labelledby', id)
        const shortBase = /^[0-9a-f]{7,40}$/i.test(base) ? base.slice(0, 7) : base
        const sub = document.createElement('div')
        sub.className = 'gwb-rebase-sub'
        sub.textContent = tt('rebase.sub', { base: shortBase, count: rows.length })

        const list = document.createElement('div')
        list.className = 'gwb-rebase-list'
        list.setAttribute('role', 'group')
        list.setAttribute('aria-label', tt('rebase.title'))

        const actions = ['pick', 'squash', 'fixup', 'drop']
        for (const row of rows) {
          const view = {}
          const el = document.createElement('div')
          el.className = 'gwb-rebase-row'
          view.el = el
          view.index = document.createElement('span')
          view.index.className = 'gwb-rebase-index'
          view.select = document.createElement('select')
          view.select.className = 'gwb-rebase-action'
          view.select.setAttribute('aria-label', tt('rebase.actionFor', { sha: row.short }))
          for (const action of actions) {
            const option = document.createElement('option')
            option.value = action
            option.textContent = tt(`rebase.${action}`)
            view.select.append(option)
          }
          const hash = document.createElement('span')
          hash.className = 'gwb-rebase-hash'
          hash.textContent = row.short
          hash.title = row.hash
          const subject = document.createElement('span')
          subject.className = 'gwb-rebase-subject'
          subject.textContent = row.subject || tt('log.noMessage')
          subject.title = row.subject
          const moves = document.createElement('span')
          moves.className = 'gwb-rebase-moves'
          const makeMove = (icon, label) => {
            const button = document.createElement('button')
            button.type = 'button'
            button.className = 'gwb-rebase-move'
            button.title = label
            button.setAttribute('aria-label', label)
            button.innerHTML = iconMarkup(icon, 12)
            moves.append(button)
            return button
          }
          view.up = makeMove('chevUp', tt('rebase.moveUp'))
          view.down = makeMove('chevDown', tt('rebase.moveDown'))
          el.append(view.index, view.select, hash, subject, moves)
          row.view = view
          list.append(el)
        }

        const hint = document.createElement('div')
        hint.className = 'gwb-rebase-hint'
        hint.textContent = tt('rebase.hint')
        const errorEl = document.createElement('div')
        errorEl.className = 'gwb-rebase-error'
        errorEl.setAttribute('role', 'alert')
        const foot = document.createElement('div')
        foot.className = 'gwb-rebase-foot'
        const countEl = document.createElement('span')
        countEl.className = 'gwb-rebase-keep'
        const cancel = document.createElement('button')
        cancel.className = 'gwb-btn ghost'
        cancel.textContent = tt('confirm.cancel')
        const ok = document.createElement('button')
        ok.className = 'gwb-btn primary'
        ok.textContent = tt('rebase.ok')
        foot.append(countEl, cancel, ok)
        dialog.append(title, sub, list, hint, errorEl, foot)
        backdrop.appendChild(dialog)
        document.body.appendChild(backdrop)

        const validate = () => {
          const kept = rows.filter((row) => row.action !== 'drop')
          // git has nothing to fold the first kept commit into, and a plan of
          // nothing but drops is a no-op it refuses.
          if (kept.length === 0) return tt('rebase.allDropped')
          if (kept[0].action !== 'pick') return tt('rebase.firstSquash')
          return ''
        }
        const paint = () => {
          rows.forEach((row, index) => {
            const { el, index: number, select, up, down } = row.view
            el.className = `gwb-rebase-row${row.action === 'drop' ? ' is-drop' : row.action === 'pick' ? '' : ' is-fold'}`
            number.textContent = String(index + 1)
            select.value = row.action
            up.disabled = index === 0
            down.disabled = index === rows.length - 1
          })
          const message = validate()
          errorEl.textContent = message
          ok.disabled = message !== ''
          const kept = rows.filter((row) => row.action !== 'drop').length
          const result = rows.filter((row) => row.action === 'pick').length
          countEl.textContent = tt('rebase.keep', { kept, total: rows.length, result })
          countEl.classList.toggle('error', message !== '')
        }
        const move = (index, delta) => {
          const next = index + delta
          if (next < 0 || next >= rows.length) return
          const [row] = rows.splice(index, 1)
          rows.splice(next, 0, row)
          list.replaceChildren(...rows.map((entry) => entry.view.el))
          paint()
          // Re-parenting a node drops focus; keep it on the arrow the user is
          // holding, or on its sibling once the row reaches the end.
          const wanted = delta < 0 ? row.view.up : row.view.down
          const fallback = delta < 0 ? row.view.down : row.view.up
          ;(wanted.disabled ? fallback : wanted).focus()
        }
        for (const row of rows) {
          row.view.select.addEventListener('change', () => {
            row.action = row.view.select.value
            paint()
          })
          row.view.up.addEventListener('click', () => move(rows.indexOf(row), -1))
          row.view.down.addEventListener('click', () => move(rows.indexOf(row), 1))
        }
        const settle = (value) => {
          backdrop.remove()
          document.removeEventListener('keydown', onKey, true)
          resolve(value)
        }
        const submit = () => {
          if (validate() !== '') {
            paint()
            return
          }
          settle({ entries: rows.map((row) => ({ hash: row.hash, action: row.action })) })
        }
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            settle(null)
          }
        }

        backdrop.addEventListener('mousedown', (event) => {
          if (event.target === backdrop) settle(null)
        })
        cancel.addEventListener('click', () => settle(null))
        ok.addEventListener('click', submit)
        document.addEventListener('keydown', onKey, true)
        paint()
        window.setTimeout(() => rows[0]?.view.select.focus(), 30)
      })
    }

    /** Best-effort clipboard write; the host may deny permission. */
    function copyText(text) {      try {
        const written = navigator.clipboard?.writeText(text)
        if (written && typeof written.catch === 'function') written.catch(() => {})
      } catch {
        /* clipboard unavailable */
      }
    }

    function FolderIcon() {
      return h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, 'aria-hidden': 'true', style: { flex: 'none' } },
        h('path', { d: 'M1.5 4.5c0-.8.7-1.5 1.5-1.5h3l1.5 1.5h6c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5H3c-.8 0-1.5-.7-1.5-1.5v-6.5z' }),
      )
    }

    function Badge({ kind }) {
      const badge = kind === 'untracked' ? 'U' : kind === 'added' ? 'A' : kind === 'deleted' ? 'D' : kind === 'renamed' ? 'R' : kind === 'conflicted' ? '!' : 'M'
      return h('span', { className: 'gwb-badge', style: { color: statusColor(kind) } }, badge)
    }

    /**
     * Icon button. Children may arrive as the second argument — every call
     * site passes them that way — so accept both shapes; taking them only from
     * props rendered these buttons empty (invisible ‹ › ↑ ↓ ✕ ⟳).
     */
    function IconBtn({ title, onClick, children, ...rest }, childArg) {
      return h('button', { className: 'gwb-iconbtn', title, 'aria-label': title, onClick, ...rest }, children ?? childArg)
    }

    /**
     * A dropdown anchored to its trigger. Rows are plain elements; any click
     * inside closes the menu, so handlers run before the close.
     */
    function Menu({ button, align = 'down', title, width, onOpen, anchorClass, children }) {
      const [open, setOpen] = useState(false)
      const ref = useRef(null)
      const triggerRef = useRef(null)
      const popupRef = useRef(null)
      useEffect(() => {
        if (!open) return
        const onDoc = (event) => {
          // A floating context menu or name prompt lives outside this anchor;
          // acting on it must not dismiss the popup behind it, so that a new
          // tag or an applied stash stays visible in the list it came from.
          if (event.target?.closest?.('.gwb-ctx')) return
          if (!ref.current?.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', onDoc)
        return () => document.removeEventListener('mousedown', onDoc)
      }, [open])
      // Escape closes without leaking to the view underneath; arrows walk the
      // rows and Enter/Space activate them, so the menus are keyboard-operable.
      useEffect(() => {
        if (!open) return
        const onKey = (event) => {
          if (event.key === 'Escape') {
            // A cursor menu opened on top of this popup owns the Escape: it
            // must close the context menu alone, so the branch list stays open
            // for the next right click.
            if (document.querySelector('.gwb-ctx')) return
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
            triggerRef.current?.querySelector('button')?.focus()
            return
          }
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          if (event.target?.tagName === 'INPUT') return
          const rows = [...(popupRef.current?.querySelectorAll('[role="menuitem"]') ?? [])]
          if (rows.length === 0) return
          event.preventDefault()
          const at = rows.indexOf(document.activeElement)
          const next = event.key === 'ArrowDown' ? (at + 1) % rows.length : at <= 0 ? rows.length - 1 : at - 1
          rows[next]?.focus()
        }
        document.addEventListener('keydown', onKey, true)
        requestAnimationFrame(() => {
          const input = popupRef.current?.querySelector('input')
          if (input) input.focus()
          else popupRef.current?.querySelector('[role="menuitem"]')?.focus()
        })
        return () => document.removeEventListener('keydown', onKey, true)
      }, [open])
      // Placement is fixed to the viewport rather than absolute inside the
      // anchor: a popup that stays in the host's subtree adds scrollable
      // overflow to whichever container wraps it, and the focus() below then
      // scrolls that container — the whole page slid sideways.
      useEffect(() => {
        if (!open || !popupRef.current || !ref.current) return
        const popup = popupRef.current
        const place = () => {
          if (!ref.current) return
          const anchor = ref.current.getBoundingClientRect()
          const gap = 4
          const edge = 8
          const height = () => popup.getBoundingClientRect().height
          const room = (up) => (up ? anchor.top - gap - edge : window.innerHeight - anchor.bottom - gap - edge)
          popup.style.maxHeight = ''
          let up = align === 'up'
          if (!up && height() > room(false) && room(true) > room(false)) up = true
          const limit = room(up)
          if (height() > limit) popup.style.maxHeight = `${Math.max(160, Math.round(limit))}px`
          popup.style.top = `${Math.round(up ? anchor.top - gap - height() : anchor.bottom + gap)}px`
          const width = popup.getBoundingClientRect().width
          popup.style.left = `${Math.round(Math.max(edge, Math.min(anchor.left, window.innerWidth - width - edge)))}px`
        }
        place()
        // Fixed placement means the popup no longer travels with its trigger,
        // so any scroll in the host tree has to re-run the maths. Capture phase:
        // the scroller is the host's, not ours.
        window.addEventListener('scroll', place, { capture: true, passive: true })
        window.addEventListener('resize', place, { passive: true })
        return () => {
          window.removeEventListener('scroll', place, { capture: true })
          window.removeEventListener('resize', place)
        }
      }, [open])
      return h(
        'div',
        { className: `gwb-menu-anchor${anchorClass ? ` ${anchorClass}` : ''}`, ref },
        h('span', {
          className: 'gwb-menu-trigger',
          ref: triggerRef,
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () =>
            setOpen((value) => {
              if (!value && onOpen) onOpen()
              return !value
            }),
        }, button),
        open &&
          h(
            'div',
            {
              className: 'gwb-menu',
              ref: popupRef,
              role: 'menu',
              // `width`, not `min-width`: an inline min-width outranks the
              // stylesheet's max-width and would spill off a narrow viewport.
              style: width ? { width } : undefined,
              // Clicking the search field must not dismiss the popup it filters;
              // checkbox rows opt out via .gwb-menu-stay so several checks can
              // be picked in one visit.
              onClick: (event) => {
                if (event.target?.closest?.('.gwb-menu-search, .gwb-menu-stay, input, textarea')) return
                setOpen(false)
              },
              onKeyDown: (event) => {
                if (event.target?.tagName === 'INPUT') return
                if (event.key !== 'Enter' && event.key !== ' ') return
                const row = event.target.closest?.('[role="menuitem"]')
                if (!row) return
                event.preventDefault()
                row.click()
              },
            },
            title ? h('div', { className: 'gwb-menu-title' }, title) : null,
            children,
          ),
      )
    }

    function MenuRow({ current, onClick, children }) {
      // A row with no handler still highlighted and still showed a pointer
      // cursor: read-only mode and the current branch both render those.
      const inert = onClick ? '' : ' gwb-noclick'
      return h('div', { className: `gwb-menu-row${current ? ' current' : ''}${inert}`, role: 'menuitem', tabIndex: -1, onClick }, children)
    }

    /**
     * JetBrains order: the file name carries the information, the directory is
     * the suffix. In tree mode the folders already give the path, so the suffix
     * is dropped.
     */
    function FilePath({ path, hideDir, from, color }) {
      const slash = path.lastIndexOf('/')
      const dirPart = slash > 0 ? path.slice(0, slash) : ''
      const name = slash > 0 ? path.slice(slash + 1) : path
      return h(
        'span',
        { className: 'gwb-path' },
        h('span', { className: 'gwb-name', style: color ? { color } : undefined }, name),
        !hideDir && dirPart ? h('span', { className: 'gwb-dir' }, dirPart) : null,
        from ? h('span', { className: 'gwb-from' }, `← ${String(from).split('/').pop()}`) : null,
      )
    }

    /* ---------------------------------------------------------- commit graph */


    class Safe extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error) {
        console.error('[git-workbench] pane crashed:', error)
      }
      render() {
        if (this.state.error) {
          return h('div', { className: 'gwb gwb-error' }, String(this.state.error && this.state.error.stack || this.state.error))
        }
        return this.props.children
      }
    }

    function GitIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { flex: 'none' },
        },
        h('circle', { cx: 4.5, cy: 3.5, r: 1.9 }),
        h('circle', { cx: 4.5, cy: 12.5, r: 1.9 }),
        h('circle', { cx: 11.5, cy: 6.5, r: 1.9 }),
        h('path', { d: 'M4.5 5.4v5.2' }),
        h('path', { d: 'M11.5 8.4c0 2.2-1.6 2.9-3.4 3.4' }),
      )
    }

    /**
     * Menu/row glyphs. Unicode arrows looked like debris in the popup, so the
     * plugin draws its own 12px line icons — currentColor, no asset files.
     * A shape is ['path', d] or ['circle', cx, cy, r]. The same table feeds the
     * React icons and the markup string used by the imperative context menu.
     */
    const ICON_SHAPES = {
      pull: [['path', 'M8 2v9'], ['path', 'M4.6 7.6 8 11l3.4-3.4'], ['path', 'M2.6 13.6h10.8']],
      push: [['path', 'M8 13V4'], ['path', 'M4.6 7.4 8 4l3.4 3.4'], ['path', 'M2.6 13.6h10.8']],
      fetch: [['path', 'M8 2.2v8'], ['path', 'M5.2 7.4 8 10.2l2.8-2.8'], ['path', 'M3 13.6h10']],
      branch: [
        ['circle', 5, 12.4, 1.5],
        ['circle', 11, 3.6, 1.5],
        ['path', 'M5 10.9V7.4A3.4 3.4 0 0 1 8.4 4h1.1'],
      ],
      tag: [['path', 'M2.9 2.9h4.5l5.7 5.7-4.5 4.5-5.7-5.7z'], ['circle', 5.6, 5.6, 0.9]],
      remote: [['circle', 8, 8, 5.6], ['path', 'M2.6 8h10.8'], ['path', 'M8 2.4c1.6 1.6 2.5 3.5 2.5 5.6S9.6 12 8 13.6C6.4 12 5.5 10.1 5.5 8S6.4 4 8 2.4']],
      stash: [['path', 'M2.8 6.6h10.4v6.6H2.8z'], ['path', 'M2.2 4h11.6v2.6H2.2z'], ['path', 'M8 8.2v3.2'], ['path', 'M6.5 10 8 11.4 9.5 10']],
      plus: [['path', 'M8 3.4v9.2'], ['path', 'M3.4 8h9.2']],
      commit: [['circle', 8, 8, 2.4], ['path', 'M2 8h3.6'], ['path', 'M10.4 8H14']],
      merge: [['path', 'M5 3.4v9.2'], ['path', 'M5 8h4a2.6 2.6 0 0 0 2.6-2.6V4.2']],
      compare: [
        ['path', 'M2.8 3.6v8.8'],
        ['path', 'M13.2 3.6v8.8'],
        ['path', 'M4.8 6.2h6.2'],
        ['path', 'M9.4 4.7 11.2 6.2 9.4 7.7'],
        ['path', 'M11.2 9.8H5'],
        ['path', 'M6.6 8.3 4.8 9.8 6.6 11.3'],
      ],
      rename: [['path', 'M2.8 12.6h6.4'], ['path', 'M11.2 3.2 12.8 4.8 7 10.6l-2.6.6.6-2.6z']],
      tab: [['path', 'M2.6 3.4h10.8v9.2H2.6z'], ['path', 'M6 3.4v9.2']],
      check: [['path', 'M3.2 8.4 6.4 11.6 12.8 4.8']],
      repo: [['path', 'M2.8 3.6h10.4v9.2H2.8z'], ['path', 'M2.8 6.6h10.4']],
      head: [['circle', 8, 8, 3], ['path', 'M2 8h3'], ['path', 'M11 8h3']],
      chevUp: [['path', 'M4.4 10.2 8 6.6l3.6 3.6']],
      chevDown: [['path', 'M4.4 5.8 8 9.4l3.6-3.6']],
      chevLeft: [['path', 'M10.2 4.4 6.6 8l3.6 3.6']],
      chevRight: [['path', 'M5.8 4.4 9.4 8l-3.6 3.6']],
      close: [['path', 'M4.2 4.2 11.8 11.8'], ['path', 'M11.8 4.2 4.2 11.8']],
      diff: [['path', 'M3.4 2.6h5v9.4h-5z'], ['path', 'M7.6 4.2h5v9.4h-5z']],
      reload: [['path', 'M13.2 8a5.2 5.2 0 1 1-1.7-3.85'], ['path', 'M13.4 2.4v2.6h-2.6']],
      copy: [['path', 'M5.6 2.6h6.2a1.6 1.6 0 0 1 1.6 1.6v6.2'], ['path', 'M2.6 5.6h6.2a1.6 1.6 0 0 1 1.6 1.6v4.6a1.6 1.6 0 0 1-1.6 1.6H4.2a1.6 1.6 0 0 1-1.6-1.6V7.2a1.6 1.6 0 0 1 1.6-1.6z']],
      hash: [['path', 'M6.2 2.6 4.6 13.4'], ['path', 'M11.4 2.6 9.8 13.4'], ['path', 'M2.8 5.8h10.4'], ['path', 'M2.8 10.2h10.4']],
      trash: [['path', 'M3 4.6h10'], ['path', 'M6.4 4.6V3.1h3.2v1.5'], ['path', 'M4.5 4.6 5.1 13.3h5.8l.6-8.7'], ['path', 'M6.9 7.1v3.6'], ['path', 'M9.1 7.1v3.6']],
      history: [['circle', 8, 8.4, 5.2], ['path', 'M8 5.6v3l2.1 1.4'], ['path', 'M2.8 6.4 4.6 4.6 6.4 6.4']],
      rollback: [
        ['path', 'M5.2 5.6h4.6a3.6 3.6 0 1 1 0 7.2H7.6'],
        ['path', 'M7.5 3.3 5.1 5.6l2.4 2.3'],
      ],
      ignore: [['path', 'M3 4.6h10v7.4H3z'], ['path', 'M5.3 7.1l5.4 2.4'], ['path', 'M10.7 7.1 5.3 9.5']],
      changelist: [['path', 'M3.2 3.8h9.6'], ['path', 'M3.2 8h9.6'], ['path', 'M3.2 12.2h5.8']],
      // The plain list glyph sits next to the flat/tree switch and reads as
      // "list view"; the plus says "a new list".
      changelistNew: [['path', 'M2.6 3.4h7'], ['path', 'M2.6 7h7'], ['path', 'M2.6 10.6h3.6'], ['path', 'M11.6 9v5'], ['path', 'M9.1 11.5h5']],
      more: [['circle', 3.6, 8, 0.95], ['circle', 8, 8, 0.95], ['circle', 12.4, 8, 0.95]],
      // The magnifier marks the search field; the handle points down-right so
      // it does not collide with the field's own trailing caret.
      search: [['circle', 6.9, 6.9, 4.3], ['path', 'M10.2 10.2 13.6 13.6']],
      // The two glyphs the log's "Group by" menu needs: who wrote it, and
      // when. Both are drawn here so no menu row shows a foreign symbol.
      user: [['circle', 8, 5.6, 2.8], ['path', 'M3.4 13.4c.7-2.5 2.4-3.8 4.6-3.8s3.9 1.3 4.6 3.8']],
      calendar: [['path', 'M3.2 4.4h9.6v9.2H3.2z'], ['path', 'M5.6 2.6v3.4'], ['path', 'M10.4 2.6v3.4'], ['path', 'M3.2 7.4h9.6']],
    }

    function iconOf(shapes) {
      return function Icon(props) {
        const size = props?.size ?? 12
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            style: { flex: 'none' },
          },
          ...shapes.map((shape, index) =>
            shape[0] === 'circle'
              ? h('circle', { key: index, cx: shape[1], cy: shape[2], r: shape[3] })
              : h('path', { key: index, d: shape[1] }),
          ),
        )
      }
    }

    const GitIcons = Object.fromEntries(Object.entries(ICON_SHAPES).map(([name, shapes]) => [name, iconOf(shapes)]))

    /** The same glyph as markup, for menus built outside React. */
    function iconMarkup(name, size = 12) {
      const shapes = ICON_SHAPES[name]
      if (!shapes) return ''
      const body = shapes
        .map((shape) =>
          shape[0] === 'circle'
            ? `<circle cx="${shape[1]}" cy="${shape[2]}" r="${shape[3]}"></circle>`
            : `<path d="${shape[1]}"></path>`,
        )
        .join('')
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:0 0 auto">${body}</svg>`
    }

    function Chip({ title, onClick, children }) {
      return h('button', { className: 'gwb-chipbtn', title, 'aria-label': title, onClick }, h(GitIcon), h('span', null, children))
    }

    return { showToast, reportError, showConfirm, showCheckFailure, showStashDialog, showIdentityDialog, showRemotesDialog, showRewordDialog, showRebaseDialog, copyText, openContextMenu, closeContextMenu, openNamePrompt, FolderIcon, GitIcon, GitIcons, iconMarkup, Chip, Badge, IconBtn, Menu, MenuRow, FilePath, Safe }
  },
})
