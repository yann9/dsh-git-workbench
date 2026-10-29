# HTTP API

所有接口都挂在 `/dsh-git/api` 下。`dir` 参数指定仓库目录（绝对路径）：缺省用配置里的 `repoPath`，面板总是传当前会话的 cwd。接口本身与 UI 无关——任何客户端都可以直接复用；插件自带的浏览器组件只是它的一个消费者。

```
GET  /dsh-git/api/status?dir=<abs-path>
```

## 读接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/rev` | 仓库修订 token（HEAD + index/refs 元数据），所有 GET 的 ETag 来源 |
| GET | `/events` | SSE：仓库变化时推送新的 `rev`，客户端无需轮询 |
| GET | `/info` | 仓库根、gitDir、是否 unborn、remotes |
| GET | `/status` | 分支 / upstream / ahead-behind + 文件列表（含 conflicted 与进行中的操作） |
| GET | `/console` | 当前仓库最近 200 次 git 调用的 argv、退出码、耗时与截断后的输出 |
| GET | `/workspaces` | DSH 工作区注册表，并标注哪些是 Git 仓库 |
| GET | `/overview` | 整个工作区的改动，一次返回每个文件的 staged / unstaged 两侧 |
| GET | `/turn?session=&seq=` | 会话某一轮的只读快照（来自 `ctx.workspaceChanges`） |
| GET | `/commit-file?sha=&file=&ignoreWhitespace=` | 某次提交里单个文件的差异（`git diff <parent> <sha>`，只读来源） |
| GET | `/diff?file=&staged=&rev=&ignoreWhitespace=` | 结构化 diff（一侧） |
| GET | `/file?file=&ignoreWhitespace=` | 同一文件的 staged 与 unstaged 两侧 |
| GET | `/log?limit=&all=&ref=` | 提交 DAG，可按分支 / tag 限定 |
| GET | `/commit?sha=&ignoreWhitespace=` | 单个提交的元信息 + 全量 diff |
| GET | `/message?rev=` | 单条提交信息（Amend / Reword 预填） |
| GET | `/branches` | 本地 / 远程分支 + tags（含 upstream） |
| GET | `/remotes` | 远程仓库列表（名称 + fetch 地址） |
| GET | `/blame?file=&rev=` | 逐行 annotate |
| GET | `/stash` | 储藏列表 |
| GET | `/stash-show?ref=&ignoreWhitespace=` | 单条储藏的只读预览（文件列表，含未跟踪文件） |
| GET | `/stash-file?ref=&file=&ignoreWhitespace=` | 单条储藏里某个文件的 diff |
| GET | `/untracked` | 未跟踪文件内容（合成 diff） |
| GET | `/config` | 当前配置（默认值填充完整） |
| GET | `/checks` | 仓库 `package.json` 的可运行脚本与包管理器；`reason` 说明无脚本 / 无效文件的原因 |
| GET | `/compare?left=&right=&limit=` | 两个 ref 的 `ahead/behind` 与两侧各自独有的提交 |
| GET | `/rebase-plan?base=` | 预览 `base..HEAD` 的提交（旧→新，含 merge 标记）；工作区脏、base 不是 HEAD 祖先、含 merge 或超过 100 条时说明原因并拒绝 |

## 写接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/config` | 合并保存配置；即使 `readOnly` 也允许 |
| POST | `/console/clear` | 清空当前仓库的控制台历史（不影响其他仓库） |
| POST | `/pull` `/push` `/fetch` | 网络操作：`pull --no-rebase`、`push`、`fetch --prune`，120 s 超时；`push` 支持 `force`（`--force-with-lease`）与 `remote`（没有 upstream 时 `-u <remote> HEAD`；不传则用 `origin`，没有 `origin` 时用第一个远程仓库） |
| POST | `/remote-add` `/remote-url` `/remote-remove` | `{name, url}` / `{name, url}` / `{name}`：管理远程仓库（`git remote add/set-url/remove`），名称与地址在宿主侧校验 |
| POST | `/merge` | `{branch}`，`git merge --no-edit <branch>` |
| POST | `/rebase-onto` | `{branch}`，`git rebase <branch>`：要求工作区干净且没有序列器在跑，目标不能是自己或未知 ref；冲突时返回 `{ok:false, paused:true, conflicts, output}` 并把 rebase 留在暂停态 |
| POST | `/stage` | `{file, direction, mode:file\|hunk\|lines, hunk, lines, selection}`，或 `{files:[...]}` 批量 |
| POST | `/revert` | 还原工作区中的 hunk / 行（只动 unstaged 侧） |
| POST | `/resolve` | `{file, strategy: mark\|ours\|theirs\|both}`，整文件解决并 `git add` |
| POST | `/conflict-view` | `{file}` → `{count, complete, base, segments[]}`；segments 按顺序分 `plain` / `conflict`，冲突段带 `ours\|theirs\|base\|line\|raw` |
| POST | `/resolve-region` | `{file, region, strategy: ours\|theirs\|both\|custom, result?}`，只回答一个冲突块；`custom` 用 `result`（多行文本，不含冲突标记）替换该块，最后一块自动 `git add`，返回 `{remaining}` |
| POST | `/rebase` | `{base, entries:[{hash, action: pick\|squash\|fixup\|drop}]}`；正常结束返回 `{ok, kept, folded, dropped}`，冲突或空重放时返回 `{ok:false, paused:true, conflicts, empty, output}` 并把序列器留在暂停态 |
| POST | `/reword` | `{sha, message}`：HEAD 用 `commit --amend`，较早提交用同序 todo 的 reword 重放；返回 `{ok, amended, sha}`，序列器意外暂停时返回 `{ok:false, paused:true, conflicts, empty}`；要求工作区干净 |
| POST | `/abort` | 中止进行中的操作：按 `.git` 标记选择 `merge` / `rebase` / `cherry-pick` / `revert` 的 `--abort`，没有操作时直接报错 |
| POST | `/ignore` | `{files:[...]}`，把路径追加进仓库根 `.gitignore`，已存在的规则不重复写 |
| POST | `/rollback` | `{files:[...]}`，撤销更改（恢复 / 取消暂存 / 删除未跟踪） |
| POST | `/tag` `/delete-tag` `/push-tag` | `{name, ref?, force?}` / `{name}` / `{name}` |
| POST | `/cherry-pick` `/revert-commit` | `{hashes\|sha}`；冲突时保留序列器状态供面板继续处理 |
| POST | `/reset` | `{mode: soft\|mixed\|hard, ref, confirm}`，hard 必须显式 `confirm` |
| POST | `/rename-branch` | `{branch, name}`，先校验名称与同名冲突，再 `git branch -m` |
| POST | `/set-upstream` `/unset-upstream` | `{branch, upstream}` / `{branch}`：把本地分支指向一个已存在的远程分支，或解除跟踪关系；两侧的 ref 必须存在，上游名按 `remote/branch` 两段校验 |
| POST | `/switch` | `{ref}`，`git switch --detach <ref>` 检出任意版本 |
| POST | `/commit` | `{message, amend}` |
| POST | `/commit-paths` | `{files:[...], message}`：只提交这几个文件里已暂存的内容（临时 index），其余暂存内容原样留在暂存区；重命名按新旧两个路径处理，不会被顺手带进提交 |
| POST | `/check` | `{script}`：非交互运行一个包脚本（120 s 超时、输出上限 120 k、超时杀进程树）；只读模式 403，脚本名严格白名单 |
| POST | `/commit-message` | `{language?, provider?, model?}`，用 `ctx.llm` 依据暂存区起草提交信息 |
| POST | `/checkout` | `{branch, create, from}`；远程分支自动建跟踪分支 |
| POST | `/checkout-commit` | `{sha}`，分离 HEAD |
| POST | `/delete-branch` | `{branch, force}` |
| POST | `/delete-remote-branch` | `{remote, branch}`：`git push <remote> --delete <branch>`；远程名与分支名分别校验，默认分支（main / master / HEAD）拒绝删除。推送成功后本地的 `refs/remotes/…` 也一并消失，列表不需要再获取一次 |
| POST | `/stash` | `{action: push\|pop\|apply\|drop, ref}` |

## 约定

**忽略空白**：`/diff`、`/file`、`/commit-file`、`/commit`、`/stash-show`、`/stash-file` 都接受 `ignoreWhitespace=1`，对应 `git diff -w`。该模式仅供查看：`-w` 的块索引与普通 diff 不同，`/stage` 与 `/revert` 会按未过滤的 diff 重新读取，因此客户端在过滤模式下禁用所有写操作。

**缓存**：GET 响应带 `x-git-rev` 头。内容完全由 revision 决定的端点支持 `?rev=` 协商返回 `304`，并按 revision 在服务端记忆化。工作区、diff、stash、blame、branches（上游住在 `.git/config`，不在 revision 里）等易变端点永不缓存。

**CSRF**：`Origin` 与 `Host` 不匹配的请求一律 `403`——随便打开一个网页不能替你提交代码。

**请求体**：上限 2 MB。所有写接口在 `readOnly: true` 时返回 `403`（`/config` 除外）。

**错误**：git 的拒绝会带原始输出返回，客户端经 `localizeError` 转成中文/英文句子；需要用户继续操作的失败（冲突、空重放）不是错误，而是 `{ok:false, paused:true, ...}`，序列器状态保留在仓库里。

**串行**：所有写操作经过同一把 `withWriteLock`，同一时刻只有一个 index 变更。两次重叠的 hunk 暂存如果并发，patch 的 pre-image 会互相失效。

## 给模型的工具

模型侧对应 8 个结构化工具，参数由 schema 约束，不让模型拼命令行：

| 工具 | 作用 |
|---|---|
| `git_status` | 分支、upstream、ahead/behind、文件列表 |
| `git_diff` | 工作区或暂存区差异（结构化 hunk） |
| `git_log` | 提交 DAG |
| `git_show` | 单个提交的元信息与差异 |
| `git_stage` | 暂存/取消暂存（文件、块、行） |
| `git_commit` | 提交暂存区 |
| `git_branch` | 列出 / 切换 / 新建分支 |
| `git_blame` | 逐行作者 |

它们与面板走同一层 `GitService`，所以不存在"Agent 看到的状态和面板不一致"。
