# TokenLedger 状态栏（VS Code 插件）

在 VS Code 右下角的状态栏显示 TokenLedger 记下的**今日预估费用**，或**最紧额度窗口的可用%**。鼠标悬停看额度条、今日按 Agent 的拆分、预算状态与本机网关健康；单击打开详情面板。

插件不自己算数：每一个数字都来自本机的命令行工具 `tokenledger-cli`（见仓库 [docs/cli.md](https://github.com/Geidorf/TokenLedger-open/blob/main/docs/cli.md)），它和桌面端是同一个核心库，口径与看板、托盘、小组件一致。

## 它做什么、不做什么

- 只运行本机的 `tokenledger-cli`，读它输出的 JSON。插件自己不读账本、不读任何密钥或凭据、不发网络请求。
- 额度只查你在桌面端「设置 · 订阅额度」里已经授权的来源，查法与桌面端相同。不想让它碰额度，把设置 `tokenledger.quota.enabled` 关掉，命令行就带 `--no-quota` 运行，只读本机账本。
- 不改任何数据，不触发扫描，不往云端推。新记录由桌面端扫描入账后，插件下一轮刷新就能看到。
- 不发布到扩展市场，用下面的 .vsix 手动安装。

## 安装

1. 先装好 TokenLedger 桌面端。命令行工具随安装包一起装上，位置见 docs/cli.md「构建与安装」。
2. 拿到 `tokenledger-status-<版本>.vsix`（自己打包见下文）。
3. VS Code 里打开扩展视图，右上角「…」→「从 VSIX 安装…」，选这个文件；或者在终端运行：

   ```sh
   code --install-extension tokenledger-status-0.1.0.vsix
   ```

插件先在 `PATH` 里找 `tokenledger-cli`，找不到再找桌面安装包的默认位置：

| 系统 | 默认位置 |
|---|---|
| Linux | `/usr/bin/tokenledger-cli`、`/usr/local/bin/`、`~/.local/bin/` |
| macOS | `/Applications/TokenLedger.app/Contents/MacOS/tokenledger-cli`（也找 `~/Applications`）、`/usr/local/bin/`、`/opt/homebrew/bin/` |
| Windows | `%LOCALAPPDATA%\tokenledger\`、`%LOCALAPPDATA%\Programs\tokenledger\`、`%ProgramFiles%\tokenledger\` 下的 `tokenledger-cli.exe` |

都不在的话，状态栏显示「⚠ TokenLedger」，悬停里有「打开设置」，把完整路径填进 `tokenledger.cliPath` 即可。

远程开发（SSH、容器、WSL）时插件优先跑在本机这一侧，读的是你本机桌面端的账本。

## 显示什么

**状态栏**（`tokenledger.statusBar.metric`）：

| 取值 | 显示 |
|---|---|
| `cost`（默认） | 今日预估费用，如 `≈$4.56`，写法与托盘、macOS 菜单栏标题相同 |
| `quota` | 最紧额度窗口的可用%，如 `Codex 37%`；没有可读的百分比额度时显示今日费用 |
| `both` | 两个都显示 |

最紧额度就是命令行 `status` 选出的那个窗口：所有状态正常的百分比窗口里可用% 最低的一个。预算超出时状态栏变成错误底色；预算接近上限，或最紧额度低于 20% 时变成警告底色（20%、50% 两档阈值与看板、小组件的额度着色一致）。

**悬停卡片与详情面板**：

- 今日：预估费用、有效 Token（输入 + 输出，缓存单列）、请求数。
- 额度：每个已授权来源的每个窗口一行。百分比窗口画条并写可用% 与重置时间；余额类窗口写剩余量；过期的标「过期」，未授权、出错的照实写，不画成 0。
- 今日拆分：按 Agent 的费用与 Token，前 5 名，其余并成「其他」。
- 预算：每条启用中的预算的已用、上限、比例与状态。
- 网关：是否在运行、启用的供应商数、路由组数、最近 20 次经网关请求的成功率与最近一次失败。

价格不可得的费用写「不可得」，读不到的 Token 写「—」，都不当成 0。

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `tokenledger.statusBar.metric` | `cost` | 见上表 |
| `tokenledger.refreshIntervalSeconds` | `60` | 刷新间隔，最少 15 秒；窗口不在前台时暂停，切回来补一次 |
| `tokenledger.quota.enabled` | `true` | 是否读取额度。额度列表最多每 5 分钟取一次，手动刷新与打开详情时总会取 |
| `tokenledger.cliPath` | 空 | 命令行工具的完整路径；只能在用户或机器设置里填，工作区设置不生效 |
| `tokenledger.dataDirectory` | 空 | 让命令行读另一个数据目录（环境变量 `TOKENLEDGER_APPDATA`），一般不用 |

命令面板里有「TokenLedger: 立即刷新」「TokenLedger: 显示今日详情」「TokenLedger: 打开插件设置」。

## 每次刷新运行的命令

```sh
tokenledger-cli status --json                     # 关闭额度时带 --no-quota
tokenledger-cli usage today --by agent --json
tokenledger-cli budget --json
tokenledger-cli gateway --limit 20 --json
tokenledger-cli quota --json                      # 最多每 5 分钟一次
```

每条命令单独成败：某一项失败只在对应区块写明原因，其他区块照常显示；全部失败时保留上一轮的数字并在卡片底部标出失败原因。插件只认 `schemaVersion` 为 1 的输出。

## 开发与打包

不需要安装任何依赖，Node.js 22 或更新即可。

```sh
cd extensions/vscode
npm test           # 单测：格式化黄金用例、命令行调用、视图、打包
npm run package    # 生成 dist/tokenledger-status-<版本>.vsix 并打印 SHA-256
```

本地调试：用 VS Code 打开 `extensions/vscode` 目录，按 F5 选「扩展开发宿主」运行。要用测试数据，在设置里把 `tokenledger.dataDirectory` 指向一个临时目录。

打包脚本用 Node 自带的 zlib 直接写 .vsix（zip），文件清单写在 `scripts/package-vsix.mjs` 里；许可证与图标取自仓库根目录的 `LICENSE` 与 `src-tauri/icons/128x128.png`，不在插件目录里另存一份。同样的输入得到逐字节相同的包。
