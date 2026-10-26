// dsh-git-workbench — client chunk (native DSH module chunk).
// Registered as a chunk of the plugin's client entry; see browser.js.

window.__ModuleLoader__.load({
  id: '@yann9/dsh-git-workbench',
  chunk: 'client.shell.js',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } = React
    const kit = require('@yann9/dsh-git-workbench/client.core.js')
    const { Api, COMMIT_KIND, LOG_KIND, baseName, compareStore, config, openDiff, openTab, runNetOp, switchBranch, useRepoChanges, useSessionDirectory } = kit
    const { Chip, GitIcon, GitIcons, Menu, MenuRow, copyText, iconMarkup, openContextMenu, openNamePrompt, reportError, showConfirm, showRemotesDialog, showStashDialog, showToast } = require('@yann9/dsh-git-workbench/client.ui.js')
    const { tt } = require('@yann9/dsh-git-workbench/client.i18n.js')

    /**
     * Branch name for a session. The pattern is configuration
     * (`branchPattern`, e.g. `feat/{date}-{repo}`); placeholders {date},
     * {time}, {datetime} and {repo} are substituted.
     */
    let branchPattern = 'session/{date}-{time}'

    function loadBranchPattern() {
      void kit.pluginConfig().then((config) => {
        if (typeof config?.branchPattern === 'string' && config.branchPattern.trim() !== '') branchPattern = config.branchPattern.trim()
      })
    }

    function sessionBranchName(repoName = '') {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      const time = `${pad(now.getHours())}${pad(now.getMinutes())}`
      return branchPattern
        .replaceAll('{date}', date)
        .replaceAll('{time}', time)
        .replaceAll('{datetime}', `${date}-${time}`)
        .replaceAll('{repo}', repoName)
        .replace(/\/+$/, '')
    }

    // Browser-only: the test harness materialises this chunk without fetch.
    if (typeof fetch === 'function') loadBranchPattern()

    /* ------------------------------------------------ shared git operations */

    /**
     * `git stash list` prefixes every subject with "On <branch>: ". The branch
     * is already the popup's own header, and the prefix is what pushes the real
     * message past the ellipsis, so the row reads the message only.
     */
    function stashLabel(subject, ref) {
      const text = String(subject ?? '').trim()
      const stripped = text.replace(/^(?:On|WIP on|index on)\s[^\n]*?:\s/, '').trim()
      return stripped || text || String(ref ?? '')
    }

    /**
     * The branch widget's menu: network operations, merge, branch switching.
     * Shared by the Commit pane header and the session header, so the same
     * actions are reachable whether or not the pane is open.
     */
    // The popup closes the moment an action starts, so the only place left to
    // say "still working" is the trigger the menu is mounted on.
    const NET_BUSY_LABEL = {
      pull: 'net.pullBusy',
      push: 'net.pushBusy',
      pushTag: 'net.pushBusy',
      fetch: 'net.fetchBusy',
      merge: 'net.mergeBusy',
      rebaseOnto: 'net.rebaseBusy',
      switchTo: 'net.switchBusy',
    }
    function busyLabel(kind) {
      return tt(NET_BUSY_LABEL[kind] ?? 'net.busy')
    }

    function GitOperationsMenu({ dir, button, onDone }) {
      const [state, setState] = useState({ status: null, branches: { local: [], remote: [] }, stashes: [], remotes: [] })
      const [busy, setBusy] = useState(null)
      // Two git commands at once on the same repo race over index.lock. Every
      // popup action is reachable after the menu has closed, so each one
      // has to answer a second click instead of firing anyway.
      const busyBlocked = () => {
        if (!busy) return false
        showToast(tt('net.busyToast'), true)
        return true
      }
      const [query, setQuery] = useState('')
      // config() is a snapshot that lands after the first paint; keep the
      // read-only flag in state so the menu re-renders when it arrives.
      const [readOnly, setReadOnly] = useState(config().readOnly === true)

      useEffect(() => {
        let alive = true
        void kit.pluginConfig().then((value) => {
          if (alive) setReadOnly(value?.readOnly === true)
        })
        return () => {
          alive = false
        }
      }, [])

      const load = useCallback(async () => {
        if (!dir) return
        try {
          const [status, branches, stashes, remotes] = await Promise.all([
            Api.status(dir),
            Api.branches(dir),
            // refs/stash 的就地更新不改变 revision token，`/stash` 不参与记忆化。
            Api.stashList(dir).catch(() => []),
            Api.remotes(dir).then((list) => list?.remotes ?? []).catch(() => []),
          ])
          setState({ status, branches, stashes: Array.isArray(stashes) ? stashes : [], remotes })
        } catch (cause) {
          reportError(cause)
        }
      }, [dir])

      useEffect(() => {
        void load()
      }, [load])
      useRepoChanges(dir, load)

      const blocked = () => {
        showToast(tt('readonly.blocked'), true)
      }

      const run = async (kind, branch, options) => {
        if (readOnly) {
          blocked()
          return
        }
        if (busyBlocked()) return
        // Two git commands at once on the same repo just race over index.lock.
        // The menu is closed by now, so the click that arrives here has to be
        // answered — silently dropping it reads as a dead button.
        if (busy) {
          showToast(tt('net.busyToast'), true)
          return
        }
        setBusy(kind)
        try {
          showToast(await runNetOp(dir, kind, branch, options))
          await load()
          if (onDone) onDone()
        } catch (cause) {
          reportError(cause)
        } finally {
          setBusy(null)
        }
      }

      const forcePush = async () => {
        if (!(await showConfirm(tt('git.forceConfirm'), { ok: tt('confirm.forcePush'), danger: true }))) return
        await run('push', undefined, { force: true })
      }

      /**
       * A first push has to name its target: `origin` is a convention, not a
       * fact. With an upstream, git already knows where to go; with one
       * remote, use it; with several, let the user pick.
       */
      const pushWithTarget = async (event, options = {}) => {
        const remotes = state.remotes ?? []
        if (state.status?.upstream) {
          await run('push', undefined, options)
          return
        }
        if (remotes.length === 0) {
          showToast(tt('remote.none'), true)
          return
        }
        if (remotes.length === 1) {
          await run('push', undefined, { ...options, remote: remotes[0].name })
          return
        }
        openContextMenu(
          event?.clientX ?? 0,
          event?.clientY ?? 0,
          remotes.map((remote) => ({
            iconSvg: iconMarkup('remote', 13),
            label: remote.name,
            hint: remote.url,
            title: remote.url,
            onClick: () => void run('push', undefined, { ...options, remote: remote.name }),
          })),
          // Wide enough for the urls: two remotes that differ only in their
          // path must be tellable apart here.
          { width: 440 },
        )
      }

      /** The IDE's "Manage Remotes": add, edit and drop remote repositories. */
      const openRemotesManager = () => {
        if (readOnly) {
          blocked()
          return
        }
        if (busyBlocked()) return
        showRemotesDialog({
          load: async () => (await Api.remotes(dir)).remotes ?? [],
          add: async (name, url) => {
            await Api.addRemote(dir, name, url)
            showToast(tt('remote.added', { name }))
          },
          edit: async (name, url) => {
            await Api.setRemoteUrl(dir, name, url)
            showToast(tt('remote.updated', { name }))
          },
          remove: async (name) => {
            await Api.removeRemote(dir, name)
            showToast(tt('remote.removed', { name }))
          },
          onClose: () => {
            void load()
            if (onDone) onDone()
          },
        })
      }

      const rebaseOntoBranch = async (branch) => {
        if (readOnly) {
          blocked()
          return
        }
        if (busyBlocked()) return
        const confirmed = await showConfirm(tt('git.rebaseOntoConfirm', { branch }), {
          ok: tt('git.rebaseOntoOk'),
          danger: true,
        })
        if (!confirmed) return
        await run('rebaseOnto', branch)
      }

      const checkout = async (branch, create, from) => {
        if (readOnly) {
          blocked()
          return
        }
        if (busy) {
          showToast(tt('net.busyToast'), true)
          return
        }
        if (!create && !(await confirmDirtySwitch(tt('confirm.switch')))) return
        // A checkout rewrites the whole worktree, which is slow enough that the
        // trigger has to say so — this is the same op run('switchTo') covers.
        setBusy('switchTo')
        try {
          await switchBranch(dir, branch, create, from)
          showToast(tt(create ? 'toast.created' : 'toast.switched', { branch }))
          await load()
          if (onDone) onDone()
        } catch (cause) {
          reportError(cause)
        } finally {
          setBusy(null)
        }
      }

      // Any ref switch rewrites the worktree, so a dirty tree has to be asked
      // about once per gesture — a tag detach included, not just a branch.
      const confirmDirtySwitch = async (okLabel) => {
        if (config().confirmDirtySwitch === false) return true
        const files = status?.files ?? []
        if (!files.length) return true
        const count = new Set(files.map((file) => file.path)).size
        return showConfirm(tt('branch.dirty', { count }), { ok: okLabel, danger: true })
      }

      const switchToTag = async (name) => {
        if (readOnly) {
          blocked()
          return
        }
        if (busy) {
          showToast(tt('net.busyToast'), true)
          return
        }
        if (!(await confirmDirtySwitch(tt('ctx.checkoutTag')))) return
        await run('switchTo', name)
      }

      const stashPush = async () => {
        if (readOnly) {
          blocked()
          return
        }
        if (busyBlocked()) return
        const files = state.status?.files ?? []
        if (files.length === 0) return
        const now = new Date()
        const time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
        const picked = await showStashDialog({ files, message: tt('git.stashAuto', { time }) })
        if (!picked) return
        try {
          await Api.stash(dir, 'push', undefined, picked.message || undefined, picked.paths)
          showToast(picked.count < files.length ? tt('toast.stashPushedCount', { count: picked.count }) : tt('toast.stashPushed'))
          await load()
          if (onDone) onDone()
        } catch (cause) {
          reportError(cause)
        }
      }

      const stashPop = async (ref) => {
        if (readOnly) {
          blocked()
          return
        }
        if (busyBlocked()) return
        try {
          await Api.stash(dir, 'pop', ref)
          showToast(tt('toast.stashPopped', { ref }))
          await load()
          if (onDone) onDone()
        } catch (cause) {
          reportError(cause)
        }
      }

      const stashApply = async (ref) => {
        if (readOnly) {
          blocked()
          return
        }
        if (busyBlocked()) return
        try {
          await Api.stash(dir, 'apply', ref)
          showToast(tt('toast.stashApplied', { ref }))
          await load()
        } catch (cause) {
          reportError(cause)
        }
      }

      const stashDrop = async (ref) => {
        if (readOnly) {
          blocked()
          return
        }
        if (busyBlocked()) return
        if (!(await showConfirm(tt('git.stashDropConfirm', { ref }), { ok: tt('confirm.stashDrop'), danger: true }))) return
        try {
          await Api.stash(dir, 'drop', ref)
          showToast(tt('toast.stashDropped', { ref }))
          await load()
        } catch (cause) {
          reportError(cause)
        }
      }

      // Stash rows share their action list between right-click and the row's ⋯.
      const stashMenu = (stash, point, options) =>
        openContextMenu(
          point.x,
          point.y,
          [
            { iconSvg: iconMarkup('diff', 13), label: tt('git.stashShow'), hint: stash.ref, onClick: () => void openDiff(kit.ctx, { dir, file: null, source: 'stash', ref: stash.ref }) },
            { iconSvg: iconMarkup('stash', 13), label: tt('git.stashApply'), onClick: () => void stashApply(stash.ref) },
            { iconSvg: iconMarkup('pull', 13), label: tt('git.stashPopOne'), onClick: () => void stashPop(stash.ref) },
            {
              iconSvg: iconMarkup('copy', 13),
              label: tt('ctx.copyRef'),
              onClick: () => {
                copyText(stash.ref)
                showToast(tt('ctx.copied'))
              },
            },
            { sep: true },
            { iconSvg: iconMarkup('close', 13), danger: true, label: tt('git.stashDrop'), onClick: () => void stashDrop(stash.ref) },
          ],
          options,
        )

      // 标签右键：检出是分离头指针，「基于标签新建分支」才回到可提交状态。
      const tagActions = (x, y, name, options) =>
        openContextMenu(x, y, [
          { iconSvg: iconMarkup('tag', 13), label: tt('ctx.checkoutTag'), onClick: () => void switchToTag(name) },
          {
            iconSvg: iconMarkup('branch', 13),
            label: tt('ctx.branchFromTag', { name }),
            onClick: () =>
              openNamePrompt(x, y, tt('ctx.branchFromTag', { name }), tt('ctx.branchName'), (branch) => void checkout(branch, true, name), sessionBranchName(baseName(dir ?? '')), tt('prompt.create')),
          },
          { iconSvg: iconMarkup('push', 13), label: tt('ctx.pushTag'), onClick: () => void run('pushTag', name) },
          {
            iconSvg: iconMarkup('copy', 13),
            label: tt('ctx.copyRef'),
            onClick: () => {
              copyText(name)
              showToast(tt('ctx.copied'))
            },
          },
          { sep: true },
          {
            iconSvg: iconMarkup('close', 13),
            danger: true,
            label: tt('ctx.deleteTag'),
            onClick: async () => {
              if (!(await showConfirm(tt('ctx.deleteTagConfirm', { name }), { ok: tt('ctx.deleteTag'), danger: true }))) return
              await run('deleteTag', name)
            },
          },
        ], options)

      // `git branch -d` 拒绝删除未合并分支；用户确认后再 `-D`。
      const deleteBranchFlow = async (branch) => {
        if (readOnly) {
          blocked()
          return
        }
        if (busyBlocked()) return
        // -d is safe, but it still drops the only name for those commits,
        // so it confirms like every other destructive row does.
        if (!(await showConfirm(tt('ctx.deleteBranchConfirm', { branch }), { ok: tt('confirm.deleteBranch'), danger: true }))) return
        const attempt = async (force) => {
          try {
            await Api.deleteBranch(dir, branch, force)
            showToast(tt('toast.branchDeleted', { branch }))
            await load()
            if (onDone) onDone()
            return true
          } catch (cause) {
            const message = String(cause?.message ?? cause)
            if (!force && /not fully merged/i.test(message)) {
              const confirmed = await showConfirm(tt('ctx.forceDelete', { branch }), { ok: tt('confirm.forceDelete'), danger: true })
              return confirmed ? attempt(true) : false
            }
            reportError(cause)
            return false
          }
        }
        await attempt(false)
      }

      // JetBrains renames from the branch popup and prefills the old name. The
      // prompt doubles as the confirmation, so an unchanged name is a no-op.
      const renameBranchFlow = (branch, point) => {
        if (readOnly) {
          blocked()
          return
        }
        if (busyBlocked()) return
        openNamePrompt(
          point.x,
          point.y,
          tt('branch.renameTitle', { branch: branch.name }),
          branch.name,
          async (name) => {
            if (name === branch.name) return
            try {
              const result = await Api.renameBranch(dir, branch.name, name)
              showToast(
                result.upstream
                  ? tt('toast.branchRenamedUpstream', { from: branch.name, to: name, upstream: result.upstream })
                  : tt('toast.branchRenamed', { from: branch.name, to: name }),
              )
              await load()
              if (onDone) onDone()
            } catch (cause) {
              reportError(cause)
            }
          },
          branch.name,
          tt('prompt.rename'),
        )
      }

      /**
       * JetBrains' "Set Upstream to...": a local branch tracks a
       * remote-tracking branch, so pull and push know where to go. The
       * candidates are the branches that have been fetched; the manual entry
       * covers one that has not.
       */
      const setUpstreamFlow = (branch, point) => {
        if (readOnly) {
          blocked()
          return
        }
        if (busyBlocked()) return
        const remotes = state.remotes ?? []
        const candidates = (state.branches.remote ?? []).filter((entry) => entry.name.includes('/'))
        // The address only tells the rows apart when there is more than one
        // remote; three rows with the same url is noise.
        const remoteNames = new Set(candidates.map((entry) => entry.name.split('/')[0]))
        const showUrl = remoteNames.size > 1
        const urlOf = (name) => (showUrl ? remotes.find((entry) => entry.name === name.split('/')[0])?.url ?? '' : '')
        const apply = async (upstream) => {
          try {
            await Api.setUpstream(dir, branch.name, upstream)
            showToast(tt('toast.upstreamSet', { branch: branch.name, upstream }))
            await load()
            if (onDone) onDone()
          } catch (cause) {
            reportError(cause)
          }
        }
        const ask = () =>
          openNamePrompt(point.x, point.y, tt('ctx.upstreamTitle'), tt('ctx.upstreamName'), (value) => void apply(value), '', tt('prompt.create'))
        if (candidates.length === 0) {
          ask()
          return
        }
        openContextMenu(
          point.x,
          point.y,
          [
            ...candidates.map((entry) => ({
              iconSvg: iconMarkup('remote', 13),
              label: entry.name,
              hint: urlOf(entry.name),
              title: urlOf(entry.name),
              onClick: () => void apply(entry.name),
            })),
            { sep: true },
            { iconSvg: iconMarkup('rename', 13), label: tt('ctx.upstreamManual'), onClick: ask },
          ],
          // Wide enough for a remote url: two remotes that differ only in
          // their path must be tellable apart here.
          { width: showUrl ? 440 : 280 },
        )
      }

      /**
       * Drop the tracking relationship. Nothing is lost — the branch and its
       * commits stay — so this one needs no confirmation.
       */
      const unsetUpstreamFlow = async (branch) => {
        if (readOnly) {
          blocked()
          return
        }
        if (busyBlocked()) return
        try {
          await Api.unsetUpstream(dir, branch.name)
          showToast(tt('toast.upstreamUnset', { branch: branch.name }))
          await load()
          if (onDone) onDone()
        } catch (cause) {
          reportError(cause)
        }
      }

      // History 的比较视图：左端固定为当前分支，右端是选中的分支。
      const compareWith = (branch) => {
        compareStore.set({ left: status?.detached ? 'HEAD' : (status?.branch ?? 'HEAD'), right: branch.name })
        openTab(kit.ctx, LOG_KIND)
      }

      // One list of branch actions, shared by right-click and the row's ⋯
      // button: two menus drifting apart would make the same branch offer
      // different things depending on how it was opened.
      const branchMenu = (branch, point, options) => {
        openContextMenu(
          point.x,
          point.y,
          [
            ...(readOnly || branch.current
              ? []
              : [
                  { iconSvg: iconMarkup('check', 13), label: tt('ctx.checkout'), onClick: () => void checkout(branch.name, false) },
                  { iconSvg: iconMarkup('merge', 13), label: tt('git.mergeInto'), onClick: () => void run('merge', branch.name) },
                  { iconSvg: iconMarkup('branch', 13), label: tt('git.rebaseOnto'), onClick: () => void rebaseOntoBranch(branch.name) },
                ]),
            ...(!branch.current
              ? [{ iconSvg: iconMarkup('compare', 13), label: tt('ctx.compareWithCurrent'), onClick: () => compareWith(branch) }]
              : []),
            // The IDE offers the upstream on the current branch:
            // that is the one pull and push act on.
            ...(branch.current && !readOnly
              ? [
                  {
                    iconSvg: iconMarkup('remote', 13),
                    label: branch.upstream ? tt('ctx.changeUpstream') : tt('ctx.setUpstream'),
                    onClick: () => setUpstreamFlow(branch, point),
                  },
                  ...(branch.upstream
                    ? [{ iconSvg: iconMarkup('close', 13), label: tt('ctx.unsetUpstream'), onClick: () => void unsetUpstreamFlow(branch) }]
                    : []),
                ]
              : []),
            {
              iconSvg: iconMarkup('copy', 13),
              label: tt('ctx.copyName'),
              onClick: () => {
                copyText(branch.name)
                showToast(tt('ctx.copied'))
              },
            },
            ...(readOnly
              ? []
              : [
                  {
                    iconSvg: iconMarkup('rename', 13),
                    label: tt('ctx.renameBranch'),
                    onClick: () => renameBranchFlow(branch, point),
                  },
                  { sep: true },
                  {
                    iconSvg: iconMarkup('close', 13),
                    label: tt('ctx.deleteBranch'),
                    danger: true,
                    onClick: () => void deleteBranchFlow(branch.name),
                  },
                ]),
          ],
          options,
        )
      }

      const needle = query.trim().toLowerCase()
      const match = (value) => needle === '' || value.toLowerCase().includes(needle)
      const status = state.status
      const local = [...(state.branches.local ?? [])].sort((a, b) => {
        if (a.current !== b.current) return a.current ? -1 : 1
        return (b.date ?? 0) - (a.date ?? 0)
      })
      const actions = [
        {
          icon: GitIcons.pull,
          kind: 'pull',
          label: tt('git.pull'),
          run: () => run('pull', undefined, { rebase: false }),
          variants: [
            { iconSvg: iconMarkup('pull', 13), label: tt('git.pullMerge'), run: () => run('pull', undefined, { rebase: false }) },
            { iconSvg: iconMarkup('merge', 13), label: tt('git.pullRebase'), run: () => run('pull', undefined, { rebase: true }) },
          ],
        },
        {
          icon: GitIcons.push,
          kind: 'push',
          label: tt('git.push'),
          run: (event) => void pushWithTarget(event),
          variants: [
            { iconSvg: iconMarkup('push', 13), label: tt('git.push'), run: (event) => void pushWithTarget(event) },
            { iconSvg: iconMarkup('push', 13), label: tt('git.pushForce'), danger: true, run: () => void forcePush() },
          ],
        },
        { icon: GitIcons.fetch, kind: 'fetch', label: tt('git.fetch'), run: () => run('fetch') },
      ].filter((action) => !readOnly && match(action.label))
      const branches = local.filter((branch) => match(branch.name))
      const remoteRows = (state.branches.remote ?? []).filter((branch) => branch.name.includes('/') && match(branch.name))
      const tags = (state.branches.tags ?? []).filter(match).slice(0, 8)
      const branchLabel = status?.detached ? tt('branch.detached') : status?.branch ?? '—'
      const newBranchLabel = tt('menu.newBranch')

      return h(
        Menu,
        {
          align: 'down',
          button: typeof button === 'function' ? button(branchLabel, status, busy) : button,
          onOpen: !status ? () => void load() : undefined,
          width: 360,
        },
        // Search and repo operations stay pinned while the branch list scrolls.
        h(
          'div',
          { className: 'gwb-menu-sticky' },
          // The search leads the popup, exactly like the IDE: it filters both
          // the actions and the branches while typing.
          h(
            'div',
            { className: 'gwb-menu-search' },
            h('input', {
              autoFocus: true,
              placeholder: tt('menu.search'),
              value: query,
              spellCheck: false,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Escape') event.stopPropagation()
              },
            }),
          ),
          h(
            'div',
            { className: 'gwb-menu-actions' },
            readOnly ? h('div', { className: 'gwb-menu-row gwb-muted' }, tt('readonly.menu')) : null,
            actions.map((action) =>
              h(
                'div',
                { key: action.label, className: `gwb-action-cell${busy === action.kind ? ' busy' : ''}` },
                h(
                  MenuRow,
                  { onClick: action.run },
                  h('span', { className: 'gwb-rowicon' }, h(action.icon, { size: 16 })),
                  h(
                    'span',
                    { className: 'gwb-action-line' },
                    h('span', { className: 'gwb-action-label' }, action.label),
                    // Label and caret are centred as one unit under the icon:
                    // the caret used to be absolutely positioned past the
                    // label, outside the cell, where overflow clipped it.
                    action.variants
                      ? h(
                          'button',
                          {
                            className: 'gwb-action-caret',
                            title: tt('menu.more'),
                            'aria-label': tt('menu.more'),
                            'aria-haspopup': 'menu',
                            onClick: (event) => {
                              event.stopPropagation()
                              const cell = event.currentTarget.closest('.gwb-action-cell') ?? event.currentTarget
                              const rect = cell.getBoundingClientRect()
                              openContextMenu(
                                rect.left,
                                rect.bottom + 2,
                                action.variants.map((variant) => ({
                                  iconSvg: variant.iconSvg,
                                  label: variant.label,
                                  onClick: variant.run,
                                })),
                                { fit: true },
                              )
                            },
                          },
                          '▾',
                        )
                      : null,
                  ),
                ),
              ),
            ),
            !readOnly && match(newBranchLabel)
              ? h(
                  'div',
                  { key: 'new', className: 'gwb-action-cell' },
                  h(
                    MenuRow,
                    {
                      onClick: (event) => {
                        // Keep the popup open: the new branch has to appear in it.
                        event.stopPropagation()
                        // 弹出输入框而不是内联表单：与「为此会话新建分支」一致。
                        const rect = event.currentTarget.getBoundingClientRect()
                        openNamePrompt(rect.left, rect.bottom + 4, tt('menu.newBranch'), tt('ctx.branchName'), (name) =>
                          void checkout(name, true),
                          sessionBranchName(baseName(dir ?? '')), tt('prompt.create'),
                        )
                      },
                    },
                    h('span', { className: 'gwb-rowicon' }, h(GitIcons.plus)),
                    h('span', { className: 'gwb-action-label' }, tt('menu.newBranch')),
                  ),
                )
              : null,
            !readOnly && match(tt('menu.newTag'))
              ? h(
                  'div',
                  { key: 'newtag', className: 'gwb-action-cell' },
                  h(
                    MenuRow,
                    {
                      onClick: (event) => {
                        event.stopPropagation()
                        const rect = event.currentTarget.getBoundingClientRect()
                        openNamePrompt(rect.left, rect.bottom + 4, tt('menu.newTag'), tt('ctx.tagName'), (name) => void run('createTag', name, { ref: 'HEAD' }), 'v0.3.0', tt('prompt.create'))
                      },
                    },
                    h('span', { className: 'gwb-rowicon' }, h(GitIcons.tag)),
                    h('span', { className: 'gwb-action-label' }, tt('menu.newTag')),
                  ),
                )
              : null,
          ),
        ),
        // 全局 git 操作：不依赖任何页签打开，直接从会话头的分支芯片进来。
        h(MenuRow, { key: 'open-commit', onClick: () => openTab(kit.ctx, COMMIT_KIND) }, h('span', { className: 'gwb-rowicon' }, h(GitIcons.tab)), tt('git.stashOpen')),
        h(MenuRow, { key: 'open-log', onClick: () => openTab(kit.ctx, LOG_KIND) }, h('span', { className: 'gwb-rowicon' }, h(GitIcons.history)), tt('git.logOpen')),
        readOnly
          ? null
          : h(
              MenuRow,
              {
                onClick: (event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  openNamePrompt(rect.left, rect.bottom + 4, tt('branch.sessionTitle'), tt('ctx.branchName'), (name) => void checkout(name, true), sessionBranchName(baseName(dir ?? '')), tt('prompt.create'))
                },
              },
              h('span', { className: 'gwb-rowicon' }, h(GitIcons.branch)),
              tt('branch.session'),
            ),
        !readOnly && status && status.files.length > 0
          ? h(MenuRow, { onClick: () => void stashPush() }, h('span', { className: 'gwb-rowicon' }, h(GitIcons.stash)), tt('git.stashPush'))
          : null,
        branches.length > 0
          ? [
              h('div', { className: 'gwb-menu-title' }, tt('menu.recent')),
              ...branches.slice(0, 8).map((branch) =>
                h(
                  'div',
                  {
                    key: branch.name,
                    className: `gwb-menu-row gwb-branchrow${branch.current ? ' current' : ''}${branch.current || readOnly ? ' gwb-noclick' : ''}`,
                    onClick: branch.current || readOnly ? undefined : () => void checkout(branch.name, false),
                    onContextMenu: (event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      // React clears `currentTarget` when the handler returns, and the
                      // rename prompt opens later from a menu item — keep the point now.
                      branchMenu(branch, { x: event.clientX, y: event.clientY })
                    },
                  },
                  h('span', { className: 'gwb-rowicon' }, h(branch.current ? GitIcons.check : GitIcons.branch)),
                  h('span', { className: 'gwb-grow', title: branch.name }, branch.name),
                  h('span', { className: 'gwb-meta', title: branch.upstream ?? '' }, branch.upstream ?? ''),
                  h('button', {
                    className: 'gwb-rowmore',
                    title: tt('menu.branchOps'),
                    'aria-label': tt('menu.branchOps'),
                    'aria-haspopup': 'menu',
                    onClick: (event) => {
                      event.stopPropagation()
                      const rect = event.currentTarget.getBoundingClientRect()
                      branchMenu(branch, { x: rect.right, y: rect.bottom + 2 }, { align: 'right' })
                    },
                    onDoubleClick: (event) => event.stopPropagation(),
                  }, h(GitIcons.more, { size: 14 })),
                ),
              ),
            ]
          : needle
            ? h('div', { className: 'gwb-menu-row gwb-muted gwb-noclick', key: 'branch-no-match' }, tt('menu.noMatch'))
            : null,
        tags.length > 0
          ? [
              h('div', { className: 'gwb-menu-title', key: 'tag-title' }, tt('menu.tags')),
              ...tags.map((name) =>
                h(
                  'div',
                  {
                    key: 'tag:' + name,
                    className: `gwb-menu-row${readOnly ? ' gwb-noclick' : ''}`,
                    onClick: readOnly ? undefined : () => void switchToTag(name),
                    onContextMenu: (event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      tagActions(event.clientX, event.clientY, name)
                    },
                  },
                  h('span', { className: 'gwb-rowicon' }, h(GitIcons.tag)),
                  h('span', { className: 'gwb-grow', title: name }, name),
                  h('button', {
                    className: 'gwb-rowmore',
                    title: tt('menu.tagOps'),
                    'aria-label': tt('menu.tagOps'),
                    'aria-haspopup': 'menu',
                    onClick: (event) => {
                      event.stopPropagation()
                      const rect = event.currentTarget.getBoundingClientRect()
                      tagActions(rect.right, rect.bottom + 2, name, { align: 'right' })
                    },
                    onDoubleClick: (event) => event.stopPropagation(),
                  }, h(GitIcons.more, { size: 14 })),
                ),
              ),
              (state.branches.tags ?? []).length > tags.length
                ? h('div', { className: 'gwb-menu-row gwb-muted', key: 'tag-more' }, tt('menu.moreTags', { count: (state.branches.tags ?? []).length - tags.length }))
                : null,
            ]
          : null,
        remoteRows.length > 0 ? h('div', { className: 'gwb-menu-title' }, tt('menu.remotes')) : null,
        remoteRows.slice(0, 6).map((branch) =>
          h(
            MenuRow,
            { key: branch.name, onClick: readOnly ? undefined : () => void checkout(branch.name, false) },
            h('span', { className: 'gwb-rowicon' }, h(GitIcons.remote)),
            h('span', { className: 'gwb-grow', title: branch.name }, branch.name),
          ),
        ),
        // The remote list is not the same thing as the remote repositories:
        // this is where one is added, edited or dropped.
        h(
          'div',
          {
            key: 'manage-remotes',
            className: 'gwb-menu-row',
            onClick: () => void openRemotesManager(),
          },
          h('span', { className: 'gwb-rowicon' }, h(GitIcons.remote)),
          h('span', { className: 'gwb-grow' }, tt('remote.manage')),
        ),
        state.stashes.length > 0
          ? [
              h('div', { className: 'gwb-menu-title', key: 'stash-title' }, tt('git.stashTitle')),
              ...state.stashes.slice(0, 5).map((stash) =>
                h(
                  'div',
                  {
                    key: stash.ref,
                    className: 'gwb-menu-row',
                    // The full subject keeps the branch the stash came from —
                    // the row label drops it, the tooltip still answers.
                    title: stash.subject || stash.ref,
                    // Popping rewrites the worktree, so it never happens as a
                    // side effect of looking at a row: click reads it, the
                    // right menu decides what to do with it.
                    onClick: readOnly ? undefined : () => void openDiff(kit.ctx, { dir, file: null, source: 'stash', ref: stash.ref }),
                    onContextMenu: (event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      stashMenu(stash, { x: event.clientX, y: event.clientY })
                    },
                  },
                  h('span', { className: 'gwb-rowicon' }, h(GitIcons.stash)),
                  h('span', { className: 'gwb-grow', title: stashLabel(stash.subject, stash.ref) }, stashLabel(stash.subject, stash.ref)),
                  h('span', { className: 'gwb-meta' }, `${stash.ref} · ${stash.date}`),
                  h('button', {
                    className: 'gwb-rowmore',
                    title: tt('menu.stashOps'),
                    'aria-label': tt('menu.stashOps'),
                    'aria-haspopup': 'menu',
                    onClick: (event) => {
                      event.stopPropagation()
                      const rect = event.currentTarget.getBoundingClientRect()
                      stashMenu(stash, { x: rect.right, y: rect.bottom + 2 }, { align: 'right' })
                    },
                    onDoubleClick: (event) => event.stopPropagation(),
                  }, h(GitIcons.more, { size: 14 })),
                ),
              ),
              state.stashes.length > 5
                ? h('div', { className: 'gwb-menu-row gwb-muted' }, tt('git.stashMore', { count: state.stashes.length }))
                : null,
            ]
          : null,
      )
    }

    /**
     * Session-header entry: git stays reachable from anywhere in the session,
     * not only while the Commit pane is open.
     */
    function GitHeaderWidget(props) {
      // A brand-new session has no cwd yet: useSessionDirectory falls back to
      // its owning workspace, so the chip works before the first message.
      const dir = useSessionDirectory(props)
      if (!dir) return null
      return h(GitOperationsMenu, {
        dir,
        button: (branchLabel, _status, busy) =>
          h(
            'button',
            {
              className: 'gwb-chipbtn',
              'aria-busy': busy ? '1' : undefined,
              title: `${baseName(dir)} · ${busy ? busyLabel(busy) : tt('menu.branches')}`,
            },
            h(GitIcon),
            h('span', { className: 'gwb-chipbtn-label' }, busy ? busyLabel(busy) : branchLabel),
          ),
      })
    }

    function CardAction(props) {
      return h(Chip, {
        title: tt('card.title'),
        onClick: () => {
          try {
            const params = new URL(props.actionUrl, 'http://dsh.local').searchParams
            const session = params.get('sessionId') ?? params.get('session') ?? ''
            const seq = params.get('seq') ?? ''
            if (session && seq !== '') {
              openDiff(kit.ctx, { session, seq, index: params.get('index') ?? '', source: 'turn' })
              return
            }
          } catch (error) {
            console.warn('[git-workbench] could not read the card coordinates', error)
          }
          openTab(kit.ctx, COMMIT_KIND)
        },
      }, 'Git')
    }

    function makeEntry() {
      return function Entry() {
        return h(Chip, {
          title: tt('dock.workspace'),
          onClick: () => openTab(kit.ctx, COMMIT_KIND),
        }, 'Git')
      }
    }


    /**
     * Branch picker for a *new* session. It sits in the hero's option row
     * (`conversation.hero.options`), which the host only renders while the
     * session is still empty — so it never shows up inside an ongoing
     * conversation, where the header chip is the right place.
     */
    function GitHeroBranch(props) {
      const [state, setState] = useState(null)
      const dir = useSessionDirectory(props)

      const load = useCallback(async () => {
        if (!dir) {
          setState(null)
          return
        }
        try {
          const status = await Api.status(dir)
          const files = new Set(status.files.map((file) => file.path)).size
          setState({ files, staged: status.counts.staged, branch: status.branch ?? '', detached: status.detached })
        } catch {
          setState(null)
        }
      }, [dir])

      useEffect(() => {
        void load()
      }, [load])
      useRepoChanges(dir, load)

      if (!state) return null
      const label = state.detached ? 'HEAD' : state.branch
      return h(GitOperationsMenu, {
        dir,
        align: 'down',
        button: (branchLabel, _status, busy) =>
          h(
            'button',
            {
              className: 'gwb-hero-chip',
              'aria-busy': busy ? '1' : undefined,
              title: `${busy ? `${busyLabel(busy)} · ` : ''}${tt('menu.branches')} · ${state.detached ? label : branchLabel}`,
              'aria-label': tt('menu.branches'),
            },
            h(GitIcons.branch, { size: 16 }),
            h('span', { className: 'gwb-hero-chip-label' }, busy ? busyLabel(busy) : state.detached ? label : branchLabel),
            h('span', { className: 'gwb-hero-chip-chevron' }, '▾'),
          ),
        onDone: () => void load(),
      })
    }

    /**
     * Settings → 插件 → Git 工作台. Same knobs `/config` exposes; saving writes
     * them back through the plugin loader, so they survive a reload.
     */
    function GitSettingsTab({ page } = {}) {
      const [values, setValues] = useState(null)
      const [note, setNote] = useState('')
      const [saving, setSaving] = useState(false)

      useEffect(() => {
        let alive = true
        void Api.config()
          .then((value) => {
            if (alive) setValues(value)
          })
          .catch(() => {
            if (alive) setNote(tt('settings.loadFailed'))
          })
        return () => {
          alive = false
        }
      }, [])

      if (!values) {
        return h('div', { className: 'gwb-settings' }, h('p', { className: 'gwb-settings-hint' }, note || tt('settings.loading')))
      }

      const patch = (key, value) => setValues((previous) => ({ ...previous, [key]: value }))
      const row = (key, label, control, hint) =>
        h(
          'div',
          { className: 'gwb-settings-row', key },
          h(
            'div',
            { className: 'gwb-settings-text' },
            h('span', { className: 'gwb-settings-label' }, label),
            hint ? h('span', { className: 'gwb-settings-hint' }, hint) : null,
          ),
          h('div', { className: 'gwb-settings-control' }, control),
        )
      // DSH renders every boolean setting as its 36×20 switch, not a checkbox.
      const toggle = (key) =>
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            className: 'gwb-switch',
            'aria-checked': values[key] === true,
            onClick: () => patch(key, values[key] !== true),
          },
          h('span', { className: 'gwb-switch-thumb' }),
        )
      const group = (key, title, rows) =>
        h(
          'div',
          { className: 'gwb-settings-group', key },
          h('h4', { className: 'gwb-settings-group-title' }, title),
          rows,
        )

      const save = async () => {
        setSaving(true)
        setNote('')
        try {
          const saved = await Api.saveConfig(values)
          if (saved?.config) setValues(saved.config)
          kit.applyConfig(saved?.config ?? values)
          setNote(tt('settings.saved'))
        } catch (error) {
          setNote(String(error?.message ?? error))
        } finally {
          setSaving(false)
        }
      }

      return h(
        'div',
        { className: page ? 'gwb-settings gwb-settings--page' : 'gwb-settings' },
        h('p', { className: 'gwb-settings-hint' }, tt('settings.intro')),
        group('commit', tt('settings.groupCommit'), [
          row(
            'branchPattern',
            tt('settings.branchPattern'),
            h('input', {
              type: 'text',
              value: values.branchPattern ?? '',
              onChange: (event) => patch('branchPattern', event.target.value),
            }),
            tt('settings.branchPatternHint'),
          ),
          row(
            'listMode',
            tt('settings.listMode'),
            h(
              'select',
              { value: values.listMode ?? 'last', onChange: (event) => patch('listMode', event.target.value) },
              h('option', { value: 'last' }, tt('settings.listModeLast')),
              h('option', { value: 'tree' }, tt('settings.listModeTree')),
              h('option', { value: 'flat' }, tt('settings.listModeFlat')),
            ),
          ),
          row(
            'commitLanguage',
            tt('settings.commitLanguage'),
            h(
              'select',
              { value: values.commitLanguage ?? 'auto', onChange: (event) => patch('commitLanguage', event.target.value) },
              h('option', { value: 'auto' }, tt('settings.commitLanguageAuto')),
              h('option', { value: 'zh' }, tt('settings.commitLanguageZh')),
              h('option', { value: 'en' }, tt('settings.commitLanguageEn')),
            ),
            tt('settings.commitLanguageHint'),
          ),
        ]),
        group('diff', tt('settings.groupDiff'), [
          row('diffFullFile', tt('settings.diffFullFile'), toggle('diffFullFile'), tt('settings.diffFullFileHint')),
          row('diffWrap', tt('settings.diffWrap'), toggle('diffWrap')),
          row(
            'diffFoldThreshold',
            tt('settings.diffFoldThreshold'),
            h('input', {
              type: 'number',
              min: 2,
              max: 500,
              value: values.diffFoldThreshold ?? 8,
              onChange: (event) => patch('diffFoldThreshold', Number(event.target.value)),
            }),
          ),
          row('diffSideBySide', tt('settings.diffSideBySide'), toggle('diffSideBySide')),
          row(
            'maxLog',
            tt('settings.maxLog'),
            h('input', {
              type: 'number',
              min: 1,
              max: 5000,
              value: values.maxLog ?? 400,
              onChange: (event) => patch('maxLog', Number(event.target.value)),
            }),
            tt('settings.maxLogHint'),
          ),
        ]),
        group('model', tt('settings.groupModel'), [
          row(
            'llmProvider',
            tt('settings.llmProvider'),
            h('input', {
              type: 'text',
              value: values.llmProvider ?? '',
              placeholder: 'auto',
              onChange: (event) => patch('llmProvider', event.target.value),
            }),
            tt('settings.llmProviderHint'),
          ),
          row(
            'llmModel',
            tt('settings.llmModel'),
            h('input', {
              type: 'text',
              value: values.llmModel ?? '',
              placeholder: 'auto',
              onChange: (event) => patch('llmModel', event.target.value),
            }),
            tt('settings.llmModelHint'),
          ),
        ]),
        group('safety', tt('settings.groupSafety'), [
          row('confirmDirtySwitch', tt('settings.confirmDirtySwitch'), toggle('confirmDirtySwitch')),
          row('readOnly', tt('settings.readOnly'), toggle('readOnly'), tt('settings.readOnlyHint')),
        ]),
        h(
          'div',
          { className: 'gwb-settings-footer' },
          h('button', { className: 'gwb-settings-save', disabled: saving, onClick: () => void save() }, saving ? tt('settings.saving') : tt('settings.save')),
          note ? h('span', { className: 'gwb-settings-hint' }, note) : null,
        ),
      )
    }

    /**
     * The same settings form, mounted on the plugin's own detail page in the
     * plugin manager (插件 → @yann9/dsh-git-workbench). The bundle slot only
     * renders entries keyed by this package, so no subject filtering is needed.
     */
    function GitPluginSection() {
      return h(
        'div',
        { className: 'gwb-settings-section' },
        h('h4', { className: 'gwb-settings-title' }, tt('settings.sectionTitle')),
        h(GitSettingsTab, { page: true }),
      )
    }

    return { GitOperationsMenu, GitHeaderWidget, GitHeroBranch, GitSettingsTab, GitPluginSection, CardAction, makeEntry, sessionBranchName, busyLabel }
  },
})
