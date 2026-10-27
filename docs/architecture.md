# 架构

```
src/
├── index.js              host 入口：注册路由、槽位、延迟注册工具
├── git/
│   ├── exec.js           所有 git 调用：argv 数组、无 shell、locale 固定、控制台记录
│   ├── repo.js           status(v2) / log / branches / blame / remotes 解析
│   ├── diff.js           unified diff → 带双行号的 hunk 模型
│   ├── patch.js          选区 → 裁剪 patch → apply --cached
│   ├── turns.js          会话某一轮的快照（ctx.workspaceChanges → FileDiff）
│   ├── workspaces.js     DSH 工作区注册表 → 可用的仓库列表
│   ├── revision.js       仓库修订 token（HEAD + index/refs）
│   ├── checks.js         package.json 脚本发现与非交互执行
│   ├── conflict.js       冲突分段、逐块解决
│   ├── rebase-editor.js  GIT_SEQUENCE_EDITOR 的 todo 改写器
│   ├── reword-editor.js  GIT_EDITOR 的提交信息改写器
│   └── service.js        唯一的状态变更入口，写操作串行化
├── llm/commit-message.js 提交信息起草（ctx.llm → 失败降级为本地规则）
├── http/routes.js        /dsh-git 前缀路由：JSON API + SSE 事件流
├── tools.js              给模型的 8 个结构化工具
├── tools-boot.js         工具依赖延迟加载（缺少 dsh-tools 也不影响 UI）
└── client/
    ├── browser.js        浏览器入口：按依赖顺序 materialise chunk、注册槽位
    ├── client.i18n.js    词条与错误本地化
    ├── client.styles.js  设计 token 样式表（注入一次，全部收在 .gwb 下）
    ├── client.core.js    API · stores · hooks · 共享 git 动作
    ├── client.ui.js      原子组件 + 菜单 / 弹层 / 确认
    ├── client.shell.js   会话头芯片 · 分支菜单 · 设置表单
    ├── client.panes.js   CommitPane · LogPane
    └── client.diff.js    DiffView（首次打开时懒加载）
```

host 与 client 都是可直接运行的 ESM，**没有构建步骤**：`dsh plugin add link:<dir>` 指向目录，改代码重启即生效，不需要 tsdown、不需要打包产物与源码同步。

## 两层各自负责什么

**host** 拥有唯一的数据真相：所有 git 调用、所有写操作、所有解析。它对外只暴露 `/dsh-git/api`（[见 api.md](api.md)）和 8 个模型工具，两者走同一层 `GitService`。

**client** 只负责呈现和手势：它 `fetch` API、维护本地视图状态（勾选、滚动、过滤、草稿、变更列表），不直接碰 git，也不保存任何仓库事实。

这条边界换来两件事：

1. **Agent 与面板一致**。模型调 `git_stage` 之后，面板下一次刷新看到的是同一套规则算出来的结果。
2. **UI 可替换**。界面可以重做（这个项目就从 iframe 重做过一次），API 契约不用动。

## 客户端 chunk 的划分理由

第一版把三个界面塞进一个文件，用 `mode`/`view`/`pane` 的组合分支切换。结果是同一个函数要同时服务"可写的工作区 diff"和"只读的历史 diff"，任何一个分支改坏都会影响三处。

现在的边界是：

- **commit** 是唯一知道"暂存 / 提交"这两个词的组件；
- **log** 不碰暂存区：它只读提交、切换/新建分支，没有任何 stage/commit 调用；
- **diff** 的可写性由 `source` 在装载时一次性决定：只读路径上，选区、hunk 动作、暂存按钮在渲染层根本不存在。

加第四个界面（比如冲突编辑器独立成页）= 加一个 chunk + 注册一个槽位，不碰现有组件。

## 为什么是原生组件而不是 iframe

第一版用 iframe 承载独立文档，代价很快显形：每个界面一份重复工具栏、主题要自己再实现一遍、快捷键被困在文档里、切页签丢状态——这些恰好都是"像不像 IDE"的分界线。

现在三个界面都是直接挂进宿主 React 树的组件：

- `require('react')` 用宿主实例；
- 样式注入一次（`.gwb` 作用域），颜色取宿主设计 token（`--dsw-alias-*`），明暗自动跟随宿主，没有自己的主题开关；
- 快捷键绑定在组件根节点上，不依赖文档边界；
- 列表点文件就是一次函数调用 `openDiff(ctx, …)`：写入一个小 store，再把会话视图切到「差异」。

HTTP 层保持不变，`/dsh-git/api` 仍是唯一数据源。

## 三个界面与 DSH 槽位

| 界面 | 落点 | 说明 |
|---|---|---|
| 提交 | 右侧栏页签 `sidebar.right.pane.tab` | 可拖到别的面板、拆分、浮动、全屏 |
| 历史 | 同上 | 另一个页签，与提交互不隶属 |
| 差异 | `conversation.view` 视图环（与「对话」「轨迹」并列） | 单例：第二次点文件只替换内容 |

页签类型注册时声明 `guide` 条目，右侧栏 `+` 的引导页就会列出「Git 提交与暂存」「Git 历史」。

**与 dsh-better-sidebar 的共存**：那个插件自有一套底部工作台，页签只来自它自己的 `ctx.betterSidebar.registerTab` 注册表，不会枚举宿主的右侧栏类型，所以「提交 / 历史 / 控制台」要再递给它一次。注册走 `ctx.get('betterSidebar')` 的软查询——服务名不进 `dsh.client.inject`，装了才注册，没装什么也不做——并带 `bottomOnly: true`：不加这个标记它会为每个注册另铸一个原生右侧栏类型，把上面那三个顶掉。它的页签组件只拿到 `{ sessionId, cwd }` 作用域而不是宿主的 store hook，而 `ctx.sessions` 是未声明就读取直接抛错的服务，所以仓库目录取自作用域本身。

**为什么差异不用资源（`dsh-resource://`）类型**：资源类型会按地址生成 contentId，等于每个文件一个 tab；我们要的恰恰是同一个 contentId。页面类型 + params 才是对的。

**把 diff 放主区域的代价**：DSH 的全局面板是独占的，`selectPanel` 生效后会话与右侧栏一起卸载，所以拿不到"编辑器 + 工具窗口并排"的完整版式。补偿手段放在 diff 自己的头部——`3 / 5` 打开当前文件集的完整列表、`‹ ›` / `Alt+↑/↓` 切文件、`F7` 切块、`Esc` / ✕ 回会话。接口层只依赖 `openDiff` 一处，宿主将来支持分栏时替换成本很低。

## DSH 里所有能看 diff 的位置

DSH Web 一共四个位置会呈现代码改动，它们是不同的 surface，不是一个组件：

| # | 位置 | 数据来源 | 我们的接入 |
|---|---|---|---|
| 1 | 聊天里的 `edit` / `write` 工具卡片（每次改动的内联 diff） | 工具调用参数 | **未替换**，见下 |
| 2 | 聊天里一轮结束的产出口卡片 | `present` 工具 + 文件 | `deliverables.file.actions` → `Git` 按钮，打开中间会话区的「差异」页签（见下） |
| 3 | 右侧栏「改动」评审页（逐文件列表） | `workspace/changes` | `deliverables.review.file.actions` → 同上的 `Git` 按钮 |
| 4 | 右侧栏「文件」页 | 工作区目录 | `sidebar.right.tab.files.actions` → 打开「提交」页签 |

**第 2、3 处的 `seq` 不是同一套编号**。宿主把会话事件按追加顺序统一编号，`ctx.workspaceChanges.summary(sessionId, seq)` 只认 `workspace/changes` 那一条事件；而交付卡片传给动作位的 `seq` 属于 `deliverables/presented` 事件。插件在服务端读会话日志把两者接上：用 `sessions` 服务拿到这一序号的交付事件，取它的 `turn`，再找同一轮最新的一条 `workspace/changes`，用那条的序号去要快照。`index` 也要翻译——卡片的序号数的是它自己的文件列表，快照数的是这一轮的文件列表，所以按交付事件里的 `path` 回到快照中同路径的文件。接不上时（快照只跟着**当前进程里打开的会话**存在，会话被释放或宿主重启后就没了）`/turn` 会抛出说明，diff 页把它翻译成人话并给出「在提交页查看工作区改动」的出口，而不是一句英文错误。

聊天里那张「已编辑 N 个文件」的改动卡片**没有第三方动作位**——宿主只给了它自己的「在侧边栏查看本轮改动」按钮，点进去才是第 3 行的评审页，`Git` 按钮在那里。

另有会话头部的分支芯片（`conversation.session.header.actions`）和新会话空状态的分支选择器（`conversation.hero.options`），它们是 Git 操作入口，不是 diff surface。

**为什么第 1 处不替换**：`tool.call.toolview` 是**按 key 替换**的槽位——注册 `key: "edit"` 会把官方那张内联 diff 卡片整张顶掉，包括它的折叠、行统计、可点击打开文件等行为。为了加一个按钮而重写这张卡片，收益不抵风险；而且这两张卡片没有声明任何子动作位，也无法"在旁边加"。

替代路径：每次 `edit` / `write` 都属于某一轮，第 2、3 处的入口已经覆盖"这一轮到底改了什么"。真要给工具卡片加按钮只能走 DOM 注入（`webserver/index-inject` + MutationObserver），代价是宿主改版就会失效。

## 状态同步

- **轮询**：5 秒一次 `/status`，用 `JSON.stringify(files)+branch+ahead+behind` 做指纹，没变就完全不重渲染（diff 正在被阅读时不会闪）。
- **选中即冻结**：用户已经开始逐行勾选时暂停轮询，否则一次刷新会把选择清空。
- **写入后全量刷新**：暂存 / 提交后不猜结果，直接重取 status 与当前文件 diff。git 的 index 状态没有便宜的增量接口，猜错一次比多一次请求贵得多。
- **写操作串行**：`GitService.withWriteLock` 把写操作排在一条 Promise 链上。
- **SSE**：`/events` 在仓库变化时推新的 `rev`，客户端据此决定是否重新拉取，避免空转。

## 提交以 index 为准

勾选框只是"暂存 / 取消暂存"的快捷方式；提交永远提交暂存区，不会把未暂存的部分顺手带进去。逐 Hunk / 逐行走的是同一条路：从结构化 diff 取出选区 → 裁剪成合法 patch（补上正确的 hunk 头与计数，`--recount` 兜底）→ `git apply --cached`。反向（取消暂存）用 `git apply --cached --reverse`，行级取消同样精确。

变更列表的"只提交此列表"用临时 index：以 HEAD 为底，只保留目标列表的条目，提交后刷新真实 index——别的列表的暂存内容原样留在暂存区。部分储藏用同样的技巧，避免 `git stash push -- <paths>` 把整个 index 卷进储藏的第二个父提交。

## 多语言

界面语言跟随 DSH 的语言偏好（设置 → 通用），没有偏好时回退浏览器语言；提交信息语言跟随同一判定（可用 `commitLanguage` 固定）。

- 词条在 `src/client/client.i18n.js` 的 `STRINGS` 表里（语义化 key，两侧 key 必须一致，缺失回退中文、再回退键名），不会白屏。
- client apply 把词典注册进 DSH 的 locale registry（命名空间 `gitWorkbench`），并订阅 `ctx.locale` 的活动语言：宿主切换语言时，面板内容实时重渲染，不需要重启或重新装插件。唯一例外是右侧边栏的标签页标题——宿主在创建标签页时留存标题文字（DSH 自带的「开始」标签页也一样），已打开的标签页会保持旧语言，关掉重开或重启后更新。`locale/<lang>.json` 仍只放插件元数据（`meta.title` / `meta.description`），那是插件管理器的约定，DSH 不从那里读运行时文案。
- 覆盖全部按钮、标签页、空状态、提示、错误、右键/弹层菜单、轮次快照、提交面板、冲突解决、设置。
- 不覆盖 git 自己的输出（路径、分支名、提交信息）和给模型用的工具描述（保持英文）。
- git 的拒绝经 `localizeError` 映射（`a branch named … already exists`、`nothing to commit`、非快进推送、`CONFLICT (` 等），并剥掉 `fatal:` / `error:` 前缀和 `hint:` 样板——中文界面里不出现原始英文报错墙。

## 样式与设计 token

样式是一次注入的 `<style>`，全部选择器收在 `.gwb` 作用域内；颜色只取宿主的 `--dsw-alias-*` token，因此明暗主题、宿主的品牌色变化都会自动跟随。

几条自我约束（新增 UI 时请遵守）：

- **色相可以作面，不能作小字**。文字用 `--gwb-*-ink`（向正文色混合过的墨色），彩色底上的文字用 `--gwb-on-hue`，不写死 `#fff`。
- **菜单图标单色、同尺寸**；破坏性行只用红色文字标记，不用彩色图标。
- **按钮要看得出来是按钮**：工具条上的次要控件带边框，行内动作是蓝色文字链接，只读读数保持中性灰。
- **破坏性操作的按钮写明动词并染红，焦点默认在「取消」**。
- 字号阶梯 10.5 / 11 / 12 / 13，不用半像素以外的碎值。

## 安全模型

这是能在真实仓库上放心用的前提：

- **没有 shell**：每次调用都是 `spawn('git', argv)`，路径里的 `"`、`$(...)`、`%PATH%`、换行都只是普通字符。
- **固定输出格式**：`--no-pager`、`core.quotepath=false`、`color.ui=false`、`LC_ALL=C`，用户的 pager / 别名 / 颜色配置不会改变解析结果。
- **读取与写入分离**：写操作全部经过 `withWriteLock`，同一时刻只有一个 index 变更。
- **路径与版本号校验**：拒绝 `..` 逃逸、拒绝以 `-` 开头的参数注入、commit/ref 只接受合法 revision；远程名、分支名、上游名、脚本名各有白名单。
- **CSRF 拒绝**：`Origin` 与 `Host` 不匹配的请求一律 403。
- **前缀下只有 API**：`/dsh-git/` 不映射任何静态目录；请求体上限 2 MB，读请求按 revision 记忆化。
- **只读开关**：`readOnly: true` 时除 `/config` 外的所有 POST 返回 403，面板同时不渲染写入入口。
- **不收集凭据**：网络操作禁用终端凭据交互（`GIT_TERMINAL_PROMPT=0`）并设 120 s 超时，失败时把 git 的输出交回来，绝不挂起等待输入。
- **不执行用户输入**：模型工具与 HTTP 接口都不接受命令字符串；提交前检查只认 `package.json` 里已存在的脚本名。
