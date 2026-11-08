# Roadmap / 路线图

[English](#english) · [中文](#中文)

---

## 中文

### 现状（已完成）

| 能力 | 状态 | 实测数据 |
|---|---|---|
| 明文 `level.dat` → seed | ✅ | 单世界解析 ~7 ms |
| fairplay 加密世界（有 `worldDataKey.txt`）→ seed | ✅ | 1405/1409 个历史世界，命中 99.7% |
| 运行中世界（磁盘无 key）→ seed | ✅ | `Hunt2.exe` 进程外扫描，0.9~2.5 s |
| 增量监听 + 去重状态 | ✅ | `--poll` 可调，默认跳过 SeedQueue 空壳世界 |
| 失败分类可见 | ✅ | `fail` 行写明 `key-nokey` / `key-ok` / `plain` / `absent` |
| 手机看板 | ✅ | 世界出现 → 手机 1~3 s（明文 0.3 s） |
| 自测 | ✅ | 11 项：AES/inflate 对拍、NBT、CLI、看板接口 |

### 短期（1–2 周，工程债与稳定性）

| 事项 | 为什么值得做 | 估时 |
|---|---|---|
| 主密钥自愈 | `MCSR_FIXED_KEY` 是硬编码。fairplay 换版本即全线失效。改为启动时从本机 `mcsrfairplay*.jar` 提取，取不到再回落硬编码 | 1–2 天 |
| 种子库导出 / 检索 | `seeds.log` 现在只能 `show` 最近 10 条，上千世界无法检索。加 `export`（CSV）与 `find <seed>` 反查世界 | 0.5 天 |
| 看板显示「为什么没抓到」 | 现在没出结果是黑箱。把 `describeFailure` 的结果推到 `/api/status`，看板顶部显示 | 0.5 天 |
| 日志 / 状态轮转 | 长期运行会无限增长，按大小切片并保留最近 N 个 | 0.5 天 |
| 跟随实例自动切换 | 多个实例（普通 / FSG / RSG）时手改 `config.json` 易错，改为从运行中的 javaw 命令推出 `-Dminecraft.gameDir` | 1 天 |
| 英文使用者文档 | `docs/使用说明.md` 等目前仅中文 | 1–2 天 |

### 中期（1–2 月）

1. **SeedQueue 队列预读**：SeedQueue 生成世界时手里就有 seed。若能读出它的队列结构，可把延迟从「进世界后 1~3 s」降到「进世界前就知道」。需要逆 SeedQueue 1.8 的数据结构，估 3–5 天，成本主要在版本跟进。
2. **世界档案关联**：把 `level.dat` + `speedrunigt/record.json` + `hermes/play.log` 拼成一条完整记录（seed、用时、进度、死亡点），全部读本地文件。估 3–5 天。
3. **Seed Inspector**（见下）：长期目标，先做下界，再做主世界要塞。

### 长期目标：Seed Inspector（后期目标）

**一句话**：本地拿到 seed 之后，直接算出「这把能去哪个猪堡、哪个下界要塞、要塞 1/2 环在哪里」，不需要进游戏、不需要外部网站。

**输入**：一条已知 seed（来自捕获日志，或手动输入）。

**输出**（终端文本 / JSON / 手机看板卡片）：

```
seed = -4444784861886731898

下界双堡垒（按到下界原点 0,0 的距离排序）
  #1  Bastion  Housing     chunk ( 21, -13)   下界坐标 ( 336, -208)   距原点 395 格
  #2  Bastion  Bridge      chunk (-38,  17)   下界坐标 (-608,  272)   距原点 665 格
  #3  Fortress ---------   chunk ( 44,   9)   下界坐标 ( 704,  144)   距原点 718 格

主世界要塞（1/2 环）
  ring 0  #1  chunk (-27,  -19)   方块 (-432, -304)
  ring 0  #2  ...
  ring 1  #1  ...
```

**为什么拆两步做**：

| 阶段 | 内容 | 难度 | 原因 |
|---|---|---|---|
| 阶段 A | 下界结构（猪灵堡垒 / 下界要塞） | 低 | 只依赖 `seed + 结构网格参数 + RNG`，不依赖生物群系 |
| 阶段 B | 主世界要塞 1/2 环 | 高 | 要塞位置依赖生物群系采样，必须先实现 1.16.1 的生物群系生成 |

**验收标准**：

- 与游戏内 `/locate bastion_remnant`、`/locate fortress`、`/locate stronghold` 的结果**逐坐标一致**
- 对同一 seed 重复运行结果稳定（纯函数，无随机）
- 至少用 20 个真实世界做回归（用捕获到的 seed 建世界，先 `/seed` 确认再 `/locate` 对账）

**验证方法（关键）**：先用本工具抓到的 seed 新建一个开作弊的单人世界（种子框填入），
在游戏里执行 `/locate` 拿到官方答案，再与工具输出比对。这是唯一的权威基准。

技术设计（模块划分、1.16.1 算法要点、易错点）见
[seed-inspector-design.md](seed-inspector-design.md)。

### 非目标

- 不做任何「避免被发现」的能力：检测面不在工具侧，唯一暴露源是录像里的窗口与公开仓库
- 不做排名模式（Ranked）的 seed 获取：那里有 replay 系统与服务端真值，投入产出比为负
- 不引入构建链（webpack/vite/Tailwind）：手机通过热点访问，CDN 不可达，单文件零依赖是硬约束

---

## English

### Current state (done)

| Capability | Status | Measured |
|---|---|---|
| Plaintext `level.dat` → seed | ✅ | ~7 ms per world |
| fairplay-encrypted world (with `worldDataKey.txt`) | ✅ | 1405/1409 worlds, 99.7% |
| Running world (no key on disk) | ✅ | out-of-process scan via `Hunt2.exe`, 0.9–2.5 s |
| Incremental watching + dedup state | ✅ | `--poll` adjustable, SeedQueue placeholders skipped |
| Classified failure output | ✅ | `fail` rows carry `key-nokey` / `key-ok` / `plain` / `absent` |
| Phone dashboard | ✅ | world appears → phone in 1–3 s (0.3 s plaintext) |
| Test suite | ✅ | 11 checks: AES/inflate cross-checks, NBT, CLI, dashboard API |

### Short term (1–2 weeks, engineering debt)

| Item | Why | Effort |
|---|---|---|
| Self-healing master key | `MCSR_FIXED_KEY` is hardcoded; a fairplay bump breaks everything. Extract from the local jar at startup, fall back to the constant | 1–2 d |
| Seed library export / lookup | `seeds.log` can only show the last 10 rows; add CSV `export` and `find <seed>` | 0.5 d |
| Dashboard shows *why* nothing appeared | Expose `describeFailure` via `/api/status` | 0.5 d |
| Log / state rotation | Long runs grow without bound | 0.5 d |
| Auto-detect the running instance | Derive `-Dminecraft.gameDir` from the live javaw command line instead of editing `config.json` | 1 d |
| English user guides | `docs/*.md` are Chinese-only today | 1–2 d |

### Mid term (1–2 months)

1. **SeedQueue queue prefetch** — SeedQueue already knows the seed when it generates a world. Reading its queue structure would move the result from "1–3 s after entering" to "before entering". Requires reversing SeedQueue 1.8 internals; 3–5 d plus per-version upkeep.
2. **World archive** — join `level.dat`, `speedrunigt/record.json` and `hermes/play.log` into one record (seed, time, progress, deaths). All local files; 3–5 d.
3. **Seed Inspector** (below).

### Long-term goal: Seed Inspector

**One line**: given a seed, tell you which bastion / fortress / stronghold this run offers — computed locally, no game, no external site.

**Input**: a known seed (from the capture log, or typed in).

**Output** (terminal text / JSON / dashboard card): Nether bastions and fortresses sorted by distance to
Nether origin (0,0), then Overworld strongholds in rings 1–2, each with chunk and block coordinates.

**Why two stages**: Nether structures (stage A) depend only on seed + structure grid parameters + RNG —
low effort. Overworld strongholds (stage B) depend on **biome sampling**, so a 1.16.1 biome generator must
exist first — high effort.

**Acceptance**: coordinates must match in-game `/locate bastion_remnant`, `/locate fortress` and
`/locate stronghold` exactly; deterministic across runs; regression over ≥20 real worlds captured by this tool.

**Verification**: create a cheats-enabled world with the captured seed, run `/locate` in game, compare —
that is the only authoritative baseline.

Technical design, module layout and 1.16.1 pitfalls: [seed-inspector-design.md](seed-inspector-design.md).

### Non-goals

- No "stay undetected" work — the detection surface is not in this tool
- No Ranked-mode seed extraction — replay system plus server-side ground truth makes the trade negative
- No build chain (webpack/vite/Tailwind) — the phone reaches this over a hotspot, CDNs are unreachable
