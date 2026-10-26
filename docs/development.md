# 开发与发布

## 环境

- Node `^22.19.0 || >=24.0.0`
- `git` 在 PATH 上（测试会在临时目录里真的建仓库、真的暂存）
- `pnpm`（只用 `dsh plugin` 时需要；跑测试不需要任何依赖，`npm install` 不是必需步骤）
- DSH `0.2.1-rc.2` 以上

## 开发循环

```bash
# 建符号链接而不是复制，改代码重启即生效
dsh plugin --profile web add link:<仓库目录的绝对路径>

dsh web
```

bundle 层只在启动时读取，所以改完 host 代码要重启 `dsh web`；改 client chunk 同样需要重启（chunk 在启动时按顺序 materialise）。

如果 profile 没有自动登记 bundle，在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里加 `"@yann9/dsh-git-workbench"`。

只调 API 时可以完全不装插件：

```bash
node scripts/dev-server.js <仓库路径> 5178
# → http://127.0.0.1:5178/dsh-git/api/status
```

## 测试

```bash
npm test
```

104 个用例，全部使用真实 git 仓库，覆盖：

| 文件 | 内容 |
|---|---|
| `test/git-engine.test.js` | status v2 解析、hunk / 行级暂存与反向取消暂存、重命名、stash 部分入架、rebase / reword 计划、初始化仓库 |
| `test/http-api.test.js` | 每个端点、只读 403、CSRF、`ignoreWhitespace`、按变更列表提交、远程仓库校验、控制台隔离 |
| `test/client-pure.test.js` | 纯函数（diff 切片、日志筛选与归类、标签折叠、i18n 回退）与样式契约（无行首 `//`、花括号配平、`statusColor` 只用 ink token） |
| `test/turn-and-message.test.js` | 轮次快照与 AI 提交信息的降级链路 |

约定：

- 测试只碰临时目录或注入的 fixture，**不碰开发者日常使用的 DSH 数据目录**。
- 需要造破坏性状态的用例要自己备份、自己还原，收尾核对 `git status` 与 stash 列表，而不是只相信退出码。
- Windows 与 Linux 都要能跑：路径分隔符、CRLF、盘符大小写都别假设。

## 截图约定

文档里的图来自真实的 DSH 实例（隔离的数据目录，不要指向日常使用的 `~/.dsh`）：

- 视口 **1600 × 900**，`deviceScaleFactor: 2`；右侧工作台面板钉在 **约 560px**（拖 `.BynINW_handle` 分隔条，宿主会记住宽度，脚本每次显式拖一次），左侧保留会话列，页面比例才像 IDE 而不是一条窄带。差异与冲突要占满主区域（关闭右侧栏），否则会自动退回统一视图。
- 每个界面出**浅色 + 深色**两张，命名 `docs/assets/<surface>-<theme>.png`：
  `commit-pane`、`diff`、`history`、`conflict`、`stash-dialog`。
- 英文界面另出一套，文件名加 `-en` 中缀：`docs/assets/<surface>-en-<theme>.png`。
  切换宿主语言在 **更多 → 设置 → 语言**；截完记得切回中文。
- 提交页、历史、储藏弹窗用**空白新会话**截图（会话没有消息就没有报错横幅）；差异与冲突视图用带会话的主区域截图。
- 只裁浏览器外框，不裁界面；不要出现用户仓库的真实路径、分支名或提交信息——用演示仓库。
- 关键交互状态（只读徽标、冲突计数、进行中的网络操作）值得单独截，但不要为此拼图或加标注。

## 发布：一个 tag 触发全部

版本号三处必须一致：`package.json` 的 `version`、`CHANGELOG.md` 的段落标题、git tag。

```bash
git add -A && git commit -m "feat: …"     # 提交信息写 conventional，release notes 靠它分组
git tag v0.1.0
git push origin main --tags               # tag 一落地就触发发布
```

`.github/workflows/release.yml` 接手，顺序是：

1. **发布闸门**：跑和 CI 完全相同的四矩阵测试（Ubuntu / Windows × Node 22 / 24），全绿才继续。
2. **GitHub Release**：`scripts/release-notes.js` 生成说明，`gh release create`（同一 tag 重跑则 `release edit`；tag 里带 `-rc.N` 之类后缀的自动标成 prerelease）。
3. **npm publish**：`npm publish --provenance --access public`，registry 由 `publishConfig` 钉死官方源。
4. **回读校验**：等 npm 把新版本放进 packument（发布是异步处理的，可能要几分钟），再从官方源装一次，检查 `cordis.patch.yml`、`src/index.js`、七个 client chunk 与两个 locale 都在包里 —— DSH 解析 bundle 需要的东西缺一个都算发布失败。

**仓库里不放任何 npm token**：发布用 npm 的 Trusted Publishing（OIDC）。GitHub Actions 的这次运行身份就是发布凭据，npm 那边按「哪个仓库、哪个 workflow 文件」来认。绑定是一次性的人工操作，只能在 npm 网站做（脚本代替不了）：

1. 打开包的 **Settings → Publishing access → Trusted Publisher**（`https://www.npmjs.com/settings/yann9/packages/dsh-git-workbench/access`）。
2. 填 GitHub Actions：Repository owner `yann9`、Repository name `dsh-git-workbench`、Workflow filename `release.yml`（**只填文件名，不填 `.github/workflows/` 路径**）、Environment 留空（workflow 没声明 environment）。
3. **勾上允许 `npm publish`**：npm 的 Trusted Publisher 有两个互不相关的权限 —— `npm stage publish` 默认就有，直接 `npm publish` 要单独开。只勾暂存的话，发布会以 `403 … OIDC permission denied for this action` 失败。
4. 未验证的新绑定 48 小时后过期，所以要么绑完立刻推 tag 让它发布一次，要么下次再绑。

也可以用 CLI 配（需要 2FA）：`npm trust github @yann9/dsh-git-workbench --file release.yml --repo yann9/dsh-git-workbench --allow-publish --registry=https://registry.npmjs.org/`；每个包同一时间只有一条绑定，要改先 `npm trust list` 拿 id、再 `npm trust revoke --id=<id>`。

另外两件事：workflow 的 `id-token: write` 权限是凭据来源，去掉它就换不到发布身份；发布用的 npm CLI 必须 **≥ 11.16**，所以 release job 钉 Node 24（Node 22 自带的 npm 太旧，脚本里有一步显式检查并报错）。发布事件只用 `push: tags`，不要用 `pull_request_target` —— 那是已知攻击面。

第一次绑定前如果要先出包，就走下面的手动发布（OTP）路子，之后再补绑定。

发出去之前还有两行核对：`LICENSE` 的版权人一行（当前是 `dsh-git-workbench contributors`）、`package.json` 的 `repository` / `homepage` / `bugs` / `author` 是真实账号信息。`docs/internal/` 已在 `.gitignore` 里，设计日志不会被推上去。

`scripts/` 不在 `files` 里，发布用的脚本不会进包。

### release notes 是怎么分组的

- 取 `git log --no-merges <上一个 tag>..<本次 tag>`，按 conventional 前缀归到 Features / Bug fixes / Performance / Refactoring / Documentation / Style / Tests / Build / CI / Reverts / Chores，没有前缀的进 Other changes。
- 前缀带 `!` 或正文里出现 `BREAKING CHANGE:` 的，额外单列到 Breaking changes。
- `chore(release): …` 这类发布整理提交自己过滤掉，说明里不写。
- `CHANGELOG.md` 里对应版本的那段作为开头正文（人写的摘要在前，提交列表是审计线索）；找不到就只列提交。
- 本地预览：

```bash
node scripts/release-notes.js --tag v0.1.0 --output /tmp/notes.md
node scripts/release-notes.js --tag v0.1.0 --no-changelog   # 只要提交列表
```

## 手动发布到 npm

包名是 `@yann9/dsh-git-workbench`。不带 scope 的 `dsh-git-workbench` 在 npm 上已被另一个项目占用（`0.3.4`，维护者不是本项目），所以从一开始就用 scope。

包名出现在三处，改的时候必须一起改，否则启动时找不到 bundle：

- `package.json` 的 `name`；
- `cordis.patch.yml` 的 `name:`（DSH 按它解析模块）；
- client chunk 的 `id` 与 `require('<包名>/client.*.js')`，以及 `test/client-pure.test.js` 里断言的 bundle key。

已安装的 profile 也要同步：`node_modules/@<scope>/<包名>` 的目录、`package.json` 里的依赖键和 `dsh.profile.bundles` 条目。

不经过 CI 手动发布时的检查清单：

```bash
npm test
npm pack --dry-run        # 看打包内容：src / locale / cordis.patch.yml / docs（含 assets）/ README
npm publish --access public
```

手动发布**不要**加 `--provenance`：provenance 只能由 CI 生成，本机跑会报 `EUSAGE Automatic provenance generation not supported for provider: null`。要带 provenance 就走上面的 tag 流水线。

`publishConfig.registry` 已经钉死官方 `registry.npmjs.org`：本机默认源可能被换成镜像（npmmirror 之流只读不写），没有这一行 `npm publish` 会打到镜像上失败。登录也要指官方源，镜像的 token 不通用：

```bash
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

`package.json` 的 `files` 已经限定为 `src`、`locale/*.json`、`cordis.patch.yml`、`README.md`、`README.zh.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`SECURITY.md`、`docs/*.md` 与 `docs/assets`；`package.json` 与 `LICENSE` 由 npm 自动包含。`docs/internal/` 既在 `.gitignore` 里也不在 `files` 里，不会进包。发布前先 `npm login`（项目里没有 `.npmrc` 或 token），发布后从干净 profile 验一次：

```bash
dsh plugin --profile web add @yann9/dsh-git-workbench
dsh web
```

## PR 之前

- `npm test` 全绿。
- 改 host 代码：`node --check` 每个改动文件；确认没有引入 shell 调用（所有 git 只走 `exec.js`）。
- 改 UI：中英文词条一起加；在浅色与深色下各看一眼；窄栏（面板 ~440px）不应出现横向滚动。
- 改文档：README 只留骨架，细节进 `docs/`；不要写本机绝对路径。
