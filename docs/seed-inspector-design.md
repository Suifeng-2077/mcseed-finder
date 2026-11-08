# Seed Inspector — Technical Design / 技术设计

> 长期目标（后期目标）的技术方案：本地拿到 seed 之后，直接算出下界双堡垒与主世界要塞 1/2 环坐标。
> 状态：**设计阶段，未实现**。本文只定义契约、模块与风险，不含实现代码。
>
> Long-term goal: compute Nether bastion/fortress positions and Overworld strongholds from a seed,
> entirely offline. Status: **design only, not implemented**.

[English](#english) · [中文](#中文)

---

## 中文

### 1. 目标与边界

**做**：输入一个 seed，输出下界猪灵堡垒（Bastion Remnant）、下界要塞（Nether Fortress）与主世界要塞
（Stronghold）第 1/2 环的位置，格式为终端文本、JSON、手机看板卡片。

**不做**：不做地形渲染、不做区块下载、不做「哪个堡垒更好」的评价（那是玩家判断）、不做多人/排名场景。

**唯一的正确性基准**：游戏内 `/locate bastion_remnant`、`/locate fortress`、`/locate stronghold`。
不是 wiki、不是第三方工具的截图，就是这两个命令的输出。

### 2. 输出契约

```json
{
  "seed": "-4444784861886731898",
  "nether": {
    "bastions": [
      { "type": "Housing", "region": [1, -1], "chunk": [21, -13],
        "block": [336, -208], "distToOrigin": 395 }
    ],
    "fortresses": [
      { "region": [1, 0], "chunk": [44, 9], "block": [704, 144], "distToOrigin": 718 }
    ]
  },
  "overworld": {
    "strongholds": [
      { "ring": 0, "chunk": [-27, -19], "block": [-432, -304] },
      { "ring": 1, "chunk": [61, 44], "block": [976, 704] }
    ]
  },
  "meta": { "mcVersion": "1.16.1", "generatedAt": "2026-11-09T00:00:00Z" }
}
```

约定：
- `chunk` 是结构起始区块坐标，`block` = `chunk * 16`（结构实际建筑可能向外延伸，不算在契约内）
- `distToOrigin` 用**下界坐标**到 (0,0) 的欧氏距离，按升序排列
- 输出**必须确定性**：同一 seed 多次运行字节级一致

### 3. 模块划分

```
mcseed-app/lib/
├── mcseed-rng.js          # WorldgenRandom（java.util.Random 兼容）+ 派生种子
├── mcseed-structcfg.js    # 1.16.1 StructuresConfig 常量表（含来源行号注释）
├── mcseed-nether.js       # 阶段 A：下界结构网格放置 + 类型判定
├── mcseed-biome.js        # 阶段 B：1.16.1 生物群系采样（多层噪声）
├── mcseed-stronghold.js   # 阶段 B：要塞环算法 + 生物群系修正
└── mcseed-report.js       # 统一输出（text / json / dashboard 卡片）
```

CLI：

```bash
node mcseed-app.js inspect <seed>                 # 终端文本
node mcseed-app.js inspect <seed> --json          # JSON
node mcseed-app.js inspect --last                 # 用 seeds.log 最后一条 seed
node mcseed-app.js inspect <seed> --nether-only   # 只跑阶段 A（不需要 biome）
```

### 4. 阶段 A：下界双堡垒

**依赖**：seed + 结构网格参数 + RNG + 下界生物群系（仅用于判定结构是否允许生成）。

**算法骨架**（1.16.1 结构放置）：

1. 用 `spacing` 把下界划成 region 网格；每个 region 内最多一个结构
2. 对每个 region，用 `WorldgenRandom` 以 `(seed, regionX, regionZ, salt)` 派生出区域种子
3. 区域内偏移 = `nextInt(spacing - separation)`，得到结构起始 chunk
4. 判定该位置生物群系是否在结构的允许列表内；不在则跳过
5. 猪灵堡垒还要判定**类型**（Housing / Stables / Bridge / Treasure），它由同一套 RNG 序列的后继取值决定

**必须核对、不能凭记忆的常量**：

| 常量 | 说明 |
|---|---|
| `bastion.spacing / separation / salt` | 来自 1.16.1 `StructuresConfig` |
| `fortress.spacing / separation / salt` | 同上 |
| 堡垒类型的选择取值顺序 | 来自 `BastionRemnantFeature` 的 `StructureStart` 构造 |

实现要求：每个常量在 `mcseed-structcfg.js` 里以「值 + 源码出处 + 核对日期」的形式书写，
并配一条对着 `/locate` 的回归用例。**参数错一个，所有坐标整体偏移**，这是本阶段最主要的失败模式。

**为什么阶段 A 便宜**：下界只有 5 个生物群系，且由少量噪声层决定，实现量比主世界小一个数量级；
如果先做 `--nether-only`，可以不依赖 `mcseed-biome.js` 的完整实现（用一个极简下界采样即可）。

### 5. 阶段 B：主世界要塞 1/2 环

**这是整个功能里最重的部分，也是最容易低估的部分。**

要塞位置**不是纯数学公式**：游戏先按环（ring）与角度算出候选点，然后在候选点附近搜索
「合适的生物群系」来落位（避开海洋、优先陆地）。搜索过程会移动要塞几百格。因此：

> **没有 1.16.1 的生物群系采样，就没有正确的要塞坐标。**

所以阶段 B 的依赖链是：

```
seed → 多层 Perlin/Octave 噪声 → 气候参数（温度/湿度/大陆度/侵蚀/怪异度）
     → 生物群系判定 → 要塞候选点修正 → 最终坐标
```

工作量估计：

| 子任务 | 估时 | 说明 |
|---|---|---|
| `mcseed-biome.js`（噪声 + 生物群系表） | 2–4 周 | 约 1500–2500 行；生物群系 ID 与阈值表必须逐项对照 1.16.1 源码 |
| 要塞环算法（ring 分布、每环数量、角度抖动） | 3–5 天 | 公式需核对 `ChunkGeneratorStronghold` |
| 生物群系修正搜索 | 2–3 天 | 搜索半径与步长同样要对照源码 |
| 回归（≥20 个真实世界对照 `/locate`） | 2 天 | 见第 6 节 |

**可选降级方案**：如果 1/2 环要塞的实现周期不可接受，可以先只输出
「理论候选点（未做生物群系修正）」并**明确标注 `unverified: true`**。
它通常距离真实位置几十到几百格，对「这一环大概在哪个方向」仍有参考价值，但不能当作精确坐标。

### 6. 验证与回归

**权威基准只有一个**：游戏内 `/locate`。

单 world 流程：

```text
1. 用本工具捕获到的 seed 新建单人世界（创建界面「种子」框直接填）
2. 进世界后依次执行：
     /locate bastion_remnant
     /locate fortress
     /locate stronghold
3. 记录坐标，与 `inspect <seed> --json` 的输出逐字段比对
```

回归要求：
- ≥20 个世界（覆盖不同 ring、不同堡垒类型）
- 断言「工具输出的 `block` 坐标 == `/locate` 返回坐标」**完全相等**，不做容差
- RNG 层单测：用固定的 `(seed, regionX, regionZ, salt)` 断言 `WorldgenRandom` 前 N 个取值，
  与 Java 侧 `java.util.Random` 输出对齐（这是最容易出错、也最容易测的一层）

### 7. 与现有架构的集成

- 只读本地数据：`inspect` 是纯函数（seed → 报告），不联网、不读写游戏目录
- 与看板联动：新世界捕获后，看板卡片上追加一行「最近堡垒 / 要塞 1 环距离」
  —— 需要先把报告缓存进内存，避免每次渲染都重算
- 报告持久化：`seeds.log` 保持 6 列不变，另存 `seed-reports.jsonl`（可选开关），不污染现有格式

### 8. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 结构常量记错 | 全部坐标偏移，且看起来「很像对的」 | 常量表带源码出处 + 单测向量 + `/locate` 回归 |
| 生物群系实现偏差 | 要塞位置偏几百格 | 分阶段交付；未完成前输出标 `unverified` |
| Java 与 JS 的 `Random` 语义差异 | RNG 序列错位，一切皆错 | 单测直接对拍 `java.util.Random` 前 N 个取值 |
| 版本漂移（1.16.2+ 算法不同） | 输出错误但无提示 | 报告里写死 `mcVersion`，非 1.16.1 直接拒绝 |
| 用户误把「候选点」当精确坐标 | 跑图浪费 | 未验证数据必须带显式标记并在终端高亮 |

---

## English

### 1. Goal and scope

**In**: one seed in, get Nether bastion remnants, Nether fortresses and Overworld strongholds (rings 1–2)
out — as terminal text, JSON, or a dashboard card.

**Out**: no terrain rendering, no chunk downloads, no "which bastion is better" scoring, no multiplayer or
ranked scenarios.

**The only correctness baseline**: the in-game commands `/locate bastion_remnant`, `/locate fortress`,
`/locate stronghold`. Not a wiki, not a screenshot of a third-party tool.

### 2. Output contract

Same JSON as above. Conventions: `chunk` is the structure's origin chunk, `block = chunk * 16`;
`distToOrigin` is the Euclidean distance in **Nether** coordinates to (0,0), sorted ascending; output must be
byte-identical across runs for the same seed.

### 3. Modules

```
mcseed-app/lib/
├── mcseed-rng.js          # WorldgenRandom (java.util.Random compatible) + derived seeds
├── mcseed-structcfg.js    # 1.16.1 StructuresConfig table, each value annotated with its source
├── mcseed-nether.js       # stage A: Nether structure grid placement + type roll
├── mcseed-biome.js        # stage B: 1.16.1 biome sampling (multi-octave noise)
├── mcseed-stronghold.js   # stage B: stronghold rings + biome correction
└── mcseed-report.js       # text / json / dashboard output
```

CLI: `inspect <seed>`, `--json`, `--last`, `--nether-only`.

### 4. Stage A — Nether structures (low effort)

Steps: divide the Nether into regions by `spacing`; derive a per-region seed from
`(seed, regionX, regionZ, salt)`; pick an in-region offset via `nextInt(spacing - separation)`; check the
biome against the structure's allow-list; for bastions, roll the type (Housing / Stables / Bridge / Treasure)
from the following RNG draws.

**Constants that must be read from the 1.16.1 source, never recalled from memory**: both structures'
`spacing / separation / salt`, and the draw order that selects a bastion type. Every constant goes into
`mcseed-structcfg.js` with value + source location + checked date, plus a `/locate` regression case.
A single wrong constant shifts every coordinate — that is this stage's main failure mode.

Stage A is cheap because the Nether has only five biomes driven by a few noise layers; `--nether-only` can
ship before the full biome generator exists.

### 5. Stage B — Overworld strongholds (the expensive part)

Stronghold placement is **not a closed-form formula**: the game computes candidate points per ring, then
searches nearby for a suitable biome (avoiding oceans, preferring land), and that search moves the stronghold
by hundreds of blocks.

> Without a 1.16.1 biome sampler there are no correct stronghold coordinates.

Dependency chain: seed → multi-octave noise → climate parameters → biome lookup → candidate correction →
final coordinates.

| Sub-task | Effort |
|---|---|
| `mcseed-biome.js` (noise + biome table) | 2–4 weeks, ~1500–2500 lines |
| Stronghold ring algorithm | 3–5 days |
| Biome correction search | 2–3 days |
| Regression against `/locate` (≥20 worlds) | 2 days |

**Fallback**: ship stage B as "theoretical candidate points without biome correction", explicitly marked
`unverified: true`. Those are typically tens to hundreds of blocks off — useful for direction, never as exact
coordinates.

### 6. Verification

Single world: create a world with the captured seed, run the three `/locate` commands, compare field by field
with `inspect <seed> --json`. Regression: ≥20 worlds, asserting **exact equality** (no tolerance) on block
coordinates, plus an RNG unit test that pins `WorldgenRandom`'s first N draws against `java.util.Random`.

### 7. Integration

`inspect` is a pure function (seed → report): no network, no writes into the game directory. The dashboard can
cache reports in memory and append one line ("nearest bastion / ring-1 stronghold distance") to the hero card.
`seeds.log` keeps its 6-column format; reports go to an optional separate `seed-reports.jsonl`.

### 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Wrong structure constant | Every coordinate shifts while still looking plausible | Source-annotated constant table + unit vectors + `/locate` regression |
| Biome implementation drift | Strongholds off by hundreds of blocks | Staged delivery; mark unverified output |
| Java vs JS `Random` semantics | RNG stream diverges, everything is wrong | Unit test pinning the first N draws |
| Version drift (1.16.2+ differs) | Wrong output with no warning | Hard-code `mcVersion`, refuse non-1.16.1 |
| User treats candidates as exact | Wasted runs | Explicit, highlighted `unverified` marking |
