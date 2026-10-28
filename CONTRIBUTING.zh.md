# 参与开发

## 先读这三份

- [docs/architecture.zh.md](docs/architecture.zh.md)：host / client 各自负责什么，chunk 怎么分。
- [docs/jetbrains-parity.zh.md](docs/jetbrains-parity.zh.md)：交互为什么长这样，第 9 节是新增 UI 时必须遵守的规则。
- [docs/development.zh.md](docs/development.zh.md)：开发循环、测试、截图与发布。

## 开发循环

```bash
dsh plugin --profile web add link:<仓库绝对路径>
dsh web          # 改完代码重启
npm test         # 137 个用例，真实 git 仓库
```

没有构建步骤：不要引入打包器、不要生成产物。host 与 client 都必须能在 Node / 宿主模块系统里直接加载。

## 代码约定

- **所有 git 调用只走 `src/git/exec.js`**：`spawn('git', argv)`，不拼字符串、不经 shell。需要新命令时在那里加，不要在业务代码里再开一个 spawn。
- **写操作必须进 `GitService`**，由 `withWriteLock` 串行化；不要绕过它直接改 index。
- **host 返回值是 UI 的唯一事实来源**：客户端不要自行推导 ahead/behind、状态字母或可写性。
- 注释用英文，只在"为什么"不明显时写一行。
- 提交信息用 Conventional Commits：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`，正文说明动机。破坏性变更写 `feat(scope)!:` 或正文里的 `BREAKING CHANGE:`；GitHub Release 的说明就是按这些前缀分组的（见 [docs/development.zh.md](docs/development.zh.md)）。

## 改 UI 时

- 文案必须在 `src/client/client.i18n.js` 里同时给出 `zh` 与 `en`；缺失会回退中文再回退键名，但不要让新功能只存在于一种语言。
- 颜色只用 token：`--gwb-*` 与 `--dsw-alias-*`。文字色相用 `-ink` 变体，彩色底上的文字用 `--gwb-on-hue`；不要写死 `#fff` 或 `#ec1313`。
- 任何会改写工作区的动作都要走统一的确认框；破坏性按钮写明动词、染红、焦点默认落在「取消」。
- 面板最小宽度按 ~440px 检查一次：不能出现横向滚动，标签不能碎成 `or…`。
- 浅色和深色各看一眼；`statusColor` 这类内联样式函数改了要同步 `test/client-pure.test.js` 的契约测试。

## 改 git 行为时

- 用真实仓库写用例，不要 mock git。需要破坏性状态时自己备份、自己还原，收尾核对 `git status`、`git diff` 哈希与 stash 列表。
- 测试不能接触开发者日常使用的 DSH 数据目录（`~/.dsh`）；用临时目录或在独立数据目录里跑。
- 错误信息要能在中文界面里读：新出现的 git 拒绝要加进 `localizeError` 的规则表。

## PR 检查清单

- [ ] `npm test` 全绿
- [ ] `node --check` 覆盖所有改动的 host / client 文件
- [ ] 新增文案有中英文
- [ ] 深色 / 浅色、宽栏 / 窄栏都看过
- [ ] 文档同步：功能表与接口表的中英两版（`docs/features.md` / `docs/features.zh.md`、`docs/api.md` / `docs/api.zh.md`）、`CHANGELOG.md`
- [ ] 没有把本机绝对路径、账号、token 写进代码或文档

## 安全

发现安全问题不要开公开 issue，见 [SECURITY.zh.md](SECURITY.zh.md)。
