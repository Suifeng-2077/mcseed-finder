# MC Seed Finder

> Minecraft 1.16.1 种子(Seed)捕获器 — 创建/重置世界后，立刻拿到这个世界的种子，运行中的世界也能拿。
> 完全本地运行，零外部依赖，纯文件读取 + 进程外零注入内存扫描，不改变游戏、游戏日志无痕。

[English](#english) · [中文](#chinese)

## Chinese 中文

### 这是什么

一个本地命令行小工具：创建/重置 Minecraft 世界后显示这个世界的 seed。面向 Minecraft 1.16.1（含 mcsrfairplay 整合包）。附带一个手机看板，世界一出现就把 seed 推到手机上。

- ✅ **零外部依赖**：纯 Node.js，不需要任何在线服务
- ✅ **四条取 seed 路径**，自动择优：

| 路径 | 说明 | 实测命中 |
|---|---|---|
| `plain` | `level.dat` 是明文 gzip，直接解 | 少数（新建、尚未加密的世界） |
| `enc` | 读 `worldDataKey.txt` 解出世界密钥，再解 `level.dat` | **99.7%**（1405/1409 个历史世界） |
| `hunt` | **世界正在运行、磁盘上还没有 key** 时，进程外扫 javaw 堆找 worldKey | 运行中的世界按需触发 |
| `idle` | 玩家还没进入的世界（SeedQueue 队列空壳） | 静默跳过，不计失败 |

- ✅ **运行中的世界也能取**：fairplay 只在世界退出、落盘保存时才写 `worldDataKey.txt`，所以正在玩的世界磁盘上永远解不开。`hunt` 走 `Hunt2.exe` 从进程外读取堆内存，实测 **0.9~2.5 秒**出结果，不注入、不加载 agent、不写游戏文件
- ✅ **不改变游戏**：所有路径都不注入游戏、不加载额外组件、不改游戏文件、游戏日志无痕
- ✅ **失败可见**：读不到的世界记一条 `fail` 日志并写明原因（缺 key / 主密钥不匹配 / NBT 异常），不静默跳过；seed 字段是占位串（非数字）时标 `(opaque)`
- ✅ **手机看板**：局域网网页，世界创建后约 **1~3 秒**推到手机（明文 0.3 秒）

### 版本要求

| 组件 | 要求 |
|---|---|
| Minecraft | **1.16.1** |
| mcsrfairplay | **1.2.1**（实测 1.1.4 生成的世界也能解，主密钥在这两个版本间未变） |
| Node.js | LTS 版（`node -v` 能出版本号） |
| JDK | 一般不需要（仅在需要从运行中的 javaw 找进程时用到 jps） |

### 快速开始

1. 安装 **Node.js**（[nodejs.org](https://nodejs.org) 下载 LTS）
2. 解压本仓库 / 下载 Release 的 zip
3. **先启动游戏**（进入能创建/重置世界的界面）
4. 双击 `mcseed-app/` 里的脚本：

| 想做什么 | 双击 |
|---|---|
| 后台监听 + 手机看板（推荐） | `start-phone.bat` |
| 停止手机看板 | `stop-phone.bat` |
| 后台监听，只记日志 | `start-watch.bat` |
| 新开世界后按 Enter 立刻拿 seed | `start-next.bat` |
| 立刻拿最近世界的 seed | `start-now.bat` |

### 命令行用法

```bash
cd mcseed-app
node mcseed-app.js watch    # 后台监听（新世界自动捕获）
node mcseed-app.js next     # 等待新世界模式（重置世界 → 按 Enter → 看 seed）
node mcseed-app.js now      # 立刻取最近的世界
node mcseed-app.js show     # 查看最近 10 条捕获记录
```

参数（优先级高于 `config.json`）：

```bash
node mcseed-app.js now   --saves "E:\MC game\MultiMC\instances\1.16.1\.minecraft\saves"
node mcseed-app.js watch --poll 250 --retry 8 --retry-ms 200      # 扫描间隔与等 key 的次数/间隔
node mcseed-app.js watch --http 8790 --http-token 你的口令          # 开启手机看板
node mcseed-app.js now   --no-heap                                # 禁用内存扫描（只用文件）
node mcseed-app.js watch --log <日志> --state <状态文件>
```

日志每行 6 列：`时间  类型  方式  世界名  LevelName  seed`，类型为 `init/new/now/next/fail`。
`fail` 行 seed 列为空、方式列写状态（`key-nokey` / `key-ok` / `plain` / `absent`）。

### 手机看板

```bash
node mcseed-app.js watch --poll 250 --http 8790 --http-token 你的口令
```

启动后终端会打印可访问地址，手机连同一个 WiFi / 热点，浏览器打开即可：

```
http://<本机局域网IP>:8790/?t=你的口令
```

- 只监听局域网，不访问外网；`/?t=` 口令不符一律 403
- 新的世界自动插到顶部并轻微震动，整页边缘有一次绿色脉冲
- 点任意一条可复制 seed（`http://` 下走 `execCommand` 回退，实测可复制）
- 支持 PWA「添加到主屏幕」，打开后无地址栏
- 跟随系统深/浅色主题；系统开启「减弱动效」时自动关闭动画

不希望通过局域网暴露端口时，可以用 USB 隧道（需要 adb + 手机开 USB 调试）：

```bash
adb reverse tcp:8790 tcp:8790
node mcseed-app.js watch --http 8790 --http-token 你的口令
# 手机浏览器打开 http://127.0.0.1:8790/?t=你的口令
```

### 配置

`config.json`：

| 键 | 说明 |
|---|---|
| `savesDir` | 存档目录（留空则自动探测） |
| `logPath` / `statePath` | 日志与去重状态文件 |
| `autoHeap` | 是否允许对运行中的世界做内存扫描（默认 true） |
| `heapCooldownMs` | 两次内存扫描的最小间隔 |
| `huntThreads` | 内存扫描线程数（实测 4 线程约 0.9~2.3 秒） |
| `beep` | 捕获时是否响一声 |

### 自测

```bash
npm test     # 等价于 node --test test/mcseed.test.js
```

覆盖：AES 对拍 NIST SP800-38A 向量 + 与 `node:crypto` 逐组比对、inflate 对拍 `zlib`、
NBT/seed 解析（含字符串形态）、CLI 端到端（加密存档 → 读出 seed）、手机看板鉴权与数据接口。

### 文档与语言

| 文档 | 语言 | 说明 |
|---|---|---|
| [README.md](README.md) | **中英双语** | 入口文档，两份同步维护 |
| [docs/ROADMAP.md](docs/ROADMAP.md) | **中英双语** | 路线图与后期目标（含 Seed Inspector） |
| [docs/seed-inspector-design.md](docs/seed-inspector-design.md) | **中英双语** | 长期目标的技术设计 |
| [docs/使用说明.md](docs/使用说明.md) | 中文 | 面向使用者 |
| [docs/安装说明.md](docs/安装说明.md) | 中文 | 环境与安装 |
| [docs/常见问题.md](docs/常见问题.md) | 中文 | 排错 |
| [docs/原理教学.md](docs/原理教学.md) | 中文 | 三种取 seed 方式的原理 |

约定：**入口与规划类文档中英双语，使用者文档目前仅有中文**（内容更细，翻译排期见 ROADMAP）。

### 目录结构

```
mcseed/
├── config.json
├── package.json
├── test/mcseed.test.js        # 对拍 + 端到端测试（npm test）
├── mcseed-app/
│   ├── mcseed-app.js          # 主程序（watch/now/next/show + 手机看板）
│   ├── mcseed-lib.js          # gzip / NBT / seed 解析
│   ├── mcseed-crypto.js       # AES-128/256 CBC + fairplay 解包
│   ├── start-*.bat / stop-phone.bat
│   └── java/
│       ├── Hunt2.exe / .cs    # 内存扫描（推荐：自适应 klass、分块容错、多线程）
│       └── HuntKey.exe / .cs  # 旧版扫描器（保留兜底）
└── docs/
```

### 版本兼容实测

`mcsrfairplay` 的固定主密钥在 `1.1.4 → 1.2.1` 之间**没有变化**：内置的 1.2.1 主密钥可以解开
1.1.4 整合包生成的世界（实测 1405/1409 个世界全部解出）。若将来主密钥更换，`fail` 日志会以
`key-ok` 状态明确报出「已加密且 key 存在，但主密钥不匹配」，而不是静默失败。

### 后期目标

见 [docs/ROADMAP.md](docs/ROADMAP.md)。其中长期目标是 **Seed Inspector**：拿到 seed 之后，
本地计算下界双堡垒（猪灵堡垒 + 下界要塞）与主世界要塞第 1/2 环坐标并输出，
技术设计见 [docs/seed-inspector-design.md](docs/seed-inspector-design.md)。

### 免责声明

本项目仅供个人学习、本地研究及合法的单机 / 非排名场景使用。请在理解相关游戏规则后，自行判断使用场景与合规性。

---

## English

A local command-line tool that reveals the seed of a Minecraft 1.16.1 world right after you create or reset it — including while the world is still running. Fully offline, zero dependencies, and it never injects into the game.

- **Zero external dependencies** — pure Node.js, no online service
- **Four extraction paths, auto-selected**:
  - `plain` — `level.dat` is plaintext gzip, parsed directly
  - `enc` — unwrap the world key from `worldDataKey.txt`, then decrypt `level.dat` (**99.7%** of 1405 historical worlds in testing)
  - `hunt` — for a *running* world, fairplay has not written the key to disk yet; scan the javaw heap from outside the process (`Hunt2.exe`), **0.9–2.5 s**, no injection, no agent, no file writes
  - `idle` — world exists but the player never entered it (SeedQueue placeholder); skipped silently, not counted as a failure
- **Non-intrusive** — nothing is injected, no extra components are loaded, no game files are modified, game logs stay clean
- **Failures are visible** — unreadable worlds get a `fail` log line with the reason instead of being skipped silently
- **Phone dashboard** — a LAN web page; a new world shows up on your phone in **1–3 s** (0.3 s for plaintext worlds)

**Requirements**: Minecraft 1.16.1 + mcsrfairplay 1.2.1 + Node.js LTS. JDK is generally unnecessary.

**Quick start**: install Node.js → extract → start the game → double-click `mcseed-app/start-phone.bat`
(or `start-watch.bat` for log-only, `start-next.bat` for interactive mode).

**Phone dashboard**: run `node mcseed-app.js watch --http 8790 --http-token <token>` and open
`http://<lan-ip>:8790/?t=<token>` on a phone in the same network. LAN only, token required,
PWA-capable, follows the system light/dark theme. For a zero-LAN-exposure setup, use
`adb reverse tcp:8790 tcp:8790` and open `http://127.0.0.1:8790/?t=<token>`.

**Tests**: `npm test` — AES against NIST SP800-38A plus per-block comparison with `node:crypto`,
inflate against `zlib`, NBT/seed parsing, and CLI/dashboard end-to-end.

**Documentation language policy**: entry and planning documents (README, ROADMAP, design docs) are
maintained in both Chinese and English; end-user guides under `docs/` are Chinese-only for now.

**Long-term goal**: the *Seed Inspector* — given a captured seed, compute Nether bastion and
fortress positions plus Overworld strongholds in rings 1–2 locally. See
[docs/ROADMAP.md](docs/ROADMAP.md) and [docs/seed-inspector-design.md](docs/seed-inspector-design.md).

**Disclaimer**: for personal study, local research, and legitimate single-player / non-ranked use.

## License

[MIT](LICENSE) © Suifeng-2077
