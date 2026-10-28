/**
 * Model-facing tools.
 *
 * The agent should never have to build `git` command lines: these tools take
 * structured arguments, return text that is already shaped for a model to
 * read, and run through the same approval pipeline as every other DSH tool.
 */

/**
 * @param {any} ctx
 * @param {import('./git/service.js').GitService} service
 * @param {any} defineTool
 */
export function registerTools(ctx, service, defineTool) {
  if (typeof ctx.tools?.register !== 'function') return
  const register = (tool) => ctx.tools.register(defineTool(tool))

  register({
    name: 'git_status',
    description:
      'Show the Git working-tree status of a repository: current branch, upstream ahead/behind, and every staged, modified, untracked or conflicted file. Call this before staging or committing so you know what actually changed.',
    parameters: {
      dir: { type: 'string', description: 'Repository path. Defaults to the current workspace.' },
    },
    output: textOutput(),
    async execute(args) {
      const status = await service.status(args.dir)
      return formatStatus(status)
    },
  })

  register({
    name: 'git_diff',
    description:
      'Show a unified diff with hunk boundaries. Use staged=true for index-vs-HEAD, omit it for worktree-vs-index. Pass file to limit the diff to one path.',
    parameters: {
      dir: { type: 'string', description: 'Repository path.' },
      file: { type: 'string', description: 'Single repo-relative path to diff.' },
      staged: { type: 'boolean', description: 'Diff the index against HEAD instead of the worktree.' },
      maxLines: { type: 'number', description: 'Cap the returned lines (default 400).' },
    },
    output: textOutput(),
    async execute(args) {
      const { files, root } = await service.diff({ dir: args.dir, file: args.file, staged: args.staged === true })
      if (files.length === 0) return 'No changes.'
      const maxLines = Number(args.maxLines) > 0 ? Number(args.maxLines) : 400
      const lines = [`Repository: ${root}`, '']
      for (const file of files) {
        lines.push(`${file.status.toUpperCase()} ${file.path} (+${file.additions} -${file.deletions})${file.binary ? ' [binary]' : ''}`)
        if (file.binary) continue
        for (const hunk of file.hunks) {
          lines.push(hunk.header)
          for (const line of hunk.lines) {
            const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
            lines.push(marker + line.text)
            if (lines.length >= maxLines) break
          }
          if (lines.length >= maxLines) break
        }
        if (lines.length >= maxLines) break
      }
      if (lines.length >= maxLines) lines.push(`… truncated at ${maxLines} lines`)
      return lines.join('\n')
    },
  })

  register({
    name: 'git_log',
    description: 'List recent commits across all refs (hash, author, date, subject, refs). Use it to find a commit before calling git_show.',
    parameters: {
      dir: { type: 'string', description: 'Repository path.' },
      limit: { type: 'number', description: 'Maximum commits (default 20).' },
    },
    output: textOutput(),
    async execute(args) {
      const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 200) : 20
      const entries = await service.log({ dir: args.dir, limit })
      if (entries.length === 0) return 'No commits yet.'
      return entries
        .map((entry) => {
          const refs = entry.refs.length > 0 ? ` (${entry.refs.join(', ')})` : ''
          return `${entry.hash.slice(0, 8)}  ${entry.date.slice(0, 10)}  ${entry.author}  ${entry.subject}${refs}`
        })
        .join('\n')
    },
  })

  register({
    name: 'git_show',
    description: 'Show one commit: metadata, message and its full diff.',
    parameters: {
      dir: { type: 'string', description: 'Repository path.' },
      sha: { type: 'string', required: true, description: 'Commit hash, tag or ref name.' },
    },
    output: textOutput(),
    async execute(args) {
      const commit = await service.showCommit({ dir: args.dir, sha: args.sha })
      const lines = [
        `commit ${commit.hash}`,
        `Author: ${commit.author} <${commit.email}>`,
        `Date:   ${commit.date}`,
        '',
        commit.message.trim(),
        '',
      ]
      for (const file of commit.files) {
        lines.push(`${file.status.toUpperCase()} ${file.path} (+${file.additions} -${file.deletions})`)
        for (const hunk of file.hunks) {
          lines.push(hunk.header)
          for (const line of hunk.lines) lines.push(`${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}${line.text}`)
        }
      }
      return lines.join('\n')
    },
  })

  register({
    name: 'git_stage',
    description:
      'Stage or unstage changes. mode=file moves the whole file, mode=hunk moves one hunk by index, mode=lines moves individual lines inside a hunk (0-based everywhere: the first hunk is 0, the first line of a hunk is 0).',
    parameters: {
      dir: { type: 'string', description: 'Repository path.' },
      file: { type: 'string', required: true, description: 'Repo-relative path.' },
      direction: { type: 'string', enum: ['stage', 'unstage'], required: true, description: 'Stage into the index, or unstage back out of it.' },
      mode: { type: 'string', enum: ['file', 'hunk', 'lines'], description: 'Granularity, default file.' },
      hunk: { type: 'number', description: '0-based hunk index for mode=hunk or mode=lines.' },
      lines: { type: 'array', description: '0-based line indexes inside the hunk for mode=lines.' },
    },
    output: textOutput(),
    async execute(args) {
      const result = await service.stage({
        dir: args.dir,
        file: args.file,
        direction: args.direction === 'unstage' ? 'unstage' : 'stage',
        mode: args.mode ?? 'file',
        hunk: args.hunk,
        lines: args.lines,
      })
      return `${result.applied === 'file' ? 'Whole file' : `Selected ${result.applied}`} ${args.direction === 'unstage' ? 'unstaged' : 'staged'}: ${args.file}`
    },
  })

  register({
    name: 'git_commit',
    description: 'Commit the staged index with a message. Use amend=true only when the user explicitly asks to rewrite the previous commit.',
    parameters: {
      dir: { type: 'string', description: 'Repository path.' },
      message: { type: 'string', required: true, description: 'Commit message. Follow the repository convention.' },
      amend: { type: 'boolean', description: 'Amend the previous commit instead of creating a new one.' },
    },
    output: textOutput(),
    async execute(args) {
      if (typeof args.message !== 'string' || args.message.trim() === '') throw new Error('message is required')
      const result = await service.commit({ dir: args.dir, message: args.message, amend: args.amend === true })
      return `Committed ${result.hash.slice(0, 8)}: ${args.message.split('\n')[0]}`
    },
  })

  register({
    name: 'git_branch',
    description: 'List branches/tags, or switch to an existing branch, or create one. Never forces a checkout over dirty changes.',
    parameters: {
      dir: { type: 'string', description: 'Repository path.' },
      action: { type: 'string', enum: ['list', 'switch', 'create'], description: 'Default list.' },
      branch: { type: 'string', description: 'Branch name for switch/create.' },
      from: { type: 'string', description: 'Start point for create.' },
    },
    output: textOutput(),
    async execute(args) {
      const action = args.action ?? 'list'
      if (action === 'list') {
        const branches = await service.branches(args.dir)
        const lines = branches.local.map((branch) => `${branch.current ? '*' : ' '} ${branch.name}  ${branch.subject}`)
        if (branches.remote.length > 0) {
          lines.push('', 'Remote:')
          for (const branch of branches.remote) lines.push(`  ${branch.name}`)
        }
        if (branches.tags.length > 0) lines.push('', `Tags: ${branches.tags.join(', ')}`)
        return lines.join('\n')
      }
      if (typeof args.branch !== 'string' || args.branch === '') throw new Error('branch is required')
      await service.checkout({ dir: args.dir, branch: args.branch, create: action === 'create', from: args.from })
      return `${action === 'create' ? 'Created and checked out' : 'Switched to'} ${args.branch}`
    },
  })

  register({
    name: 'git_blame',
    description: 'Annotate a file with the commit, author and date that last touched each line.',
    parameters: {
      dir: { type: 'string', description: 'Repository path.' },
      file: { type: 'string', required: true, description: 'Repo-relative path.' },
      rev: { type: 'string', description: 'Revision to annotate (default HEAD).' },
    },
    output: textOutput(),
    async execute(args) {
      const result = await service.blame({ dir: args.dir, file: args.file, rev: args.rev })
      return result.lines
        .map((line) => `${String(line.line).padStart(5)} ${line.hash.slice(0, 8)} ${line.author.slice(0, 14).padEnd(14)} ${line.text}`)
        .join('\n')
    },
  })
}

/** @param {import('./git/repo.js').RepoStatus} status */
function formatStatus(status) {
  const lines = []
  const head = status.repo.unborn ? 'no commits yet' : status.detached ? 'detached HEAD' : `on ${status.branch}`
  let tracking = ''
  if (status.upstream) tracking = ` → ${status.upstream} (+${status.ahead}/-${status.behind})`
  lines.push(`Repository: ${status.repo.root}`, `Branch: ${head}${tracking}`, '')
  const staged = status.files.filter((file) => file.staged)
  const unstaged = status.files.filter((file) => !file.staged || file.unstaged)
  if (staged.length > 0) {
    lines.push('Staged:')
    for (const file of staged) lines.push(`  ${file.index}  ${file.path}${file.origPath ? ` ← ${file.origPath}` : ''}`)
  }
  if (unstaged.length > 0) {
    lines.push('Unstaged:')
    for (const file of unstaged) {
      const code = file.kind === 'untracked' ? '?' : file.kind === 'conflicted' ? '!' : file.worktree || file.index
      lines.push(`  ${code}  ${file.path}${file.origPath ? ` ← ${file.origPath}` : ''}`)
    }
  }
  if (status.files.length === 0) lines.push('Working tree clean.')
  return lines.join('\n')
}

function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
}
