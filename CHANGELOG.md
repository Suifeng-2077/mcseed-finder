# Changelog

所有值得注意的变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [语义化版本](https://semver.org/)。

## [1.1.1] — 2026-11-09

手机看板链路的六个缺陷修复。功能不变，但都是会让「手机上没反应」的真实问题。

### 修复 / Fixed

- **初始同步覆盖已收到的条目**：打开页面时 `load()` 拉一次历史，若此刻 SSE 已推来新世界，
  会被整体覆盖——新世界「闪一下就消失」。改为按 `时间+seed` 去重合并。
- **锁屏 / 切后台漏世界**：安卓浏览器后台会掐断 SSE，重连只接后续事件，断线期间的世界再也补不回来。
  现在 SSE `onopen` 主动补拉一次。
- **SSE 死连接不清**：客户端异常断开后 `write` 抛错，连接对象仍留在集合里，长跑会累积。
- **端口被占用时静默失效**：之前只打一行错就没了。现在自动顺延端口（最多 +5），
  并打印**实际监听端口**（原先打印的是原端口，手机会连到被占用的那个）。
- **PWA 图标主屏幕空白**：manifest 之前用 SVG data URI，安卓 Chrome 对其支持不稳。
  改为脚本生成的真实 PNG（192×192，由 `/icon-192.png` 提供）。
- **未指定口令时每次重启都变**：随机 token 每次重新生成，手机书签与主屏幕图标全部失效。
  现缓存到 `mcseed-app/.phone-token` 复用（已加入 `.gitignore`）。

### 其它 / Changed

- `--http-bind <地址>` 可绑定指定网卡；`127.0.0.1` 配合 `adb reverse` 实现零局域网暴露。
- 游戏未运行时不再尝试内存扫描，历史死世界不会反复写 `fail`。
- 二维码：启动时直接在终端画出可扫的 URL 二维码（内置编码器，零依赖）。

---

## [1.1.0] — 2026-11-09

### 新增 / Added

- **`hunt`：运行中的世界也能取 seed。** fairplay 只在世界退出、落盘保存时才写 `worldDataKey.txt`，
  所以正在玩的世界磁盘上解不开。新增 `Hunt2.exe` 从进程外扫描 javaw 堆定位 worldKey，
  实测 **0.9–2.5 秒**，不注入、不加载 agent、不写游戏文件。
  相比旧 `HuntKey.exe` 的四处硬伤：klass 指针改为从主密钥对象头现场推导（不再硬编码 `0xC0220000`）、
  1MB→64KB→4KB 三级降级读取（不再整段丢弃失败区域）、去掉「可打印字节」过滤（旧版会丢掉约 45% 的合法密钥）、
  多线程分区域扫描（找到即停）。
- **手机看板**（`--http <端口> --http-token <口令>`）：局域网网页，新世界通过 SSE 实时推送，
  世界出现到手机可见 **1–3 秒**。带 token 鉴权（不符一律 403）、点击复制 seed、PWA 添加到主屏幕、
  跟随系统深/浅色主题、逐位「老虎机」数字动画、可调震动反馈。
- **`idle` 状态**：SeedQueue 预生成的空壳世界静默跳过，不计失败、不写日志、不放弃；
  玩家进入后自动被重新拾起。
- **CLI 参数**：`--saves` / `--log` / `--state` / `--poll` / `--retry` / `--retry-ms` /
  `--http` / `--http-token` / `--no-heap`。
- **测试套件**（`npm test`，11 项）：AES 对拍 NIST SP800-38A 向量与 `node:crypto`、inflate 对拍 `zlib`、
  NBT/seed 解析（含字符串形态）、CLI 端到端（合成加密存档 → 读出 seed）、看板 token 鉴权与数据接口。
- **文档**：README 重写（徽章、mermaid 决策流程图、原生 alert、折叠 FAQ、实测数据表）；
  新增 `docs/ROADMAP.md` 与 `docs/seed-inspector-design.md`（均为中英双语）。

### 修复 / Fixed

- `watch` 循环里 `captureOne` 未 `await`，内部抛错会变成未捕获异常直接终止监听进程。
- 内存提取结束时清空整个 `tmp/` 目录，会误删用户放在那里的文件；改为只删本次自己产出的临时文件。
- 内存提取使用 `execFileSync`，同步阻塞主线程最长 10 分钟，监听心跳与锁感知全停；改为 `spawn` 异步。
- SeedQueue 空壳世界在 750 ms 内被连续 3 次失败判死，等玩家真正进入时已被跳过（永久不再处理）。
- 扫描冷却期内的跳过被计入失败次数，同样会把世界推成「已放弃」。
- 被放弃过的世界即使玩家后来进入也不再处理。
- 日志回填在文件尾部全是 `fail` 行时返回空列表，导致手机打开页面一片空白。
- 启动脚本在 cmd 下中文乱码；`.bat` 缺少 `chcp 65001`，且存在 BOM 与 LF 换行导致命令行被拆碎。

### 变更 / Changed

- `watch` 默认对「玩家已进入但磁盘无 key」的世界执行内存扫描（`autoHeap` 默认 `true`）；
  只要文件路径可用就不会触发，想彻底关闭用 `--no-heap`。
- 输出新增 `idle` 状态与 `(opaque)` 标记：seed 字段被替换成 base64 占位串时不再当作数字种子。

### 升级提示 / Notes

- 需要 Node.js ≥ 16；Windows 平台（堆扫描器是 .NET 二进制）。
- 原有 `config.json` 无需改动；新增可选键 `huntThreads`（扫描线程数，4 线程实测 0.9–2.3 秒）。

---

## [1.0.0] — 2026-08

首个版本：明文 / 密钥文件两条路径读取 1.16.1 世界的 seed，增量监听与去重状态，
`watch` / `now` / `next` / `show` 四个子命令。

---

## English

All notable changes are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/),
versioning follows [Semantic Versioning](https://semver.org/).

### Added

- **`hunt`: seed capture for a running world.** fairplay only writes `worldDataKey.txt` when a world is
  closed and saved, so a live world cannot be decrypted from disk. `Hunt2.exe` locates the world key by
  scanning the javaw heap from outside the process (**0.9–2.5 s**), with no injection, no agent, no file
  writes. Four defects of the old `HuntKey.exe` were removed: hardcoded klass pointer (now derived from the
  master key's own object header), 2 MB reads that skipped whole regions on failure (now 1 MB → 64 KB → 4 KB),
  a printable-byte filter that discarded ~45% of valid keys, and single-threaded scanning (now multi-threaded
  with early exit).
- **Phone dashboard** (`--http <port> --http-token <token>`): a LAN web page fed by SSE, **1–3 s** from world
  creation to phone. Token auth (403 otherwise), tap-to-copy, PWA install, system light/dark themes,
  slot-machine digit animation, haptic feedback.
- **`idle` state** for SeedQueue placeholders: skipped silently, never counted as failures, re-picked once the
  player enters.
- **CLI flags**: `--saves`, `--log`, `--state`, `--poll`, `--retry`, `--retry-ms`, `--http`, `--http-token`,
  `--no-heap`.
- **Test suite** (`npm test`, 11 checks): AES against NIST SP800-38A and `node:crypto`, inflate against `zlib`,
  NBT/seed parsing including string-form seeds, CLI end-to-end, dashboard auth and API.
- **Docs**: README rewritten (badges, mermaid decision flow, native alerts, collapsible FAQ, measured data);
  added `docs/ROADMAP.md` and `docs/seed-inspector-design.md`, both bilingual.

### Fixed

- Un-awaited `captureOne` inside the watch loop killed the process on an unhandled rejection.
- Heap extraction wiped the whole `tmp/` directory instead of only its own output file.
- Heap extraction blocked the main thread for up to 10 minutes (`execFileSync`); now `spawn`-based.
- SeedQueue placeholders were marked abandoned within 750 ms, before the player could enter them.
- Cooldown skips were counted as failures, pushing live worlds into the abandoned set.
- Abandoned worlds were never retried even after the player entered.
- Log backfill returned an empty list when the log tail was all `fail` rows.
- Startup scripts were mojibake in cmd (missing `chcp 65001`), and `.bat` files had a BOM plus LF endings that
  broke command parsing.

### Changed

- `watch` now scans memory for worlds the player has entered but which have no key on disk (`autoHeap` defaults
  to `true`); disable with `--no-heap`.
- New `idle` state and `(opaque)` marker for worlds whose seed field was replaced by a base64 placeholder.

### Notes

- Requires Node.js ≥ 16, Windows (the heap scanner is a .NET binary).
- Existing `config.json` needs no changes; optional `huntThreads` added.
