# MC Seed Finder

> Minecraft 1.16.1 种子(Seed)捕获器 — 创建/重置新世界后，立刻告诉你这个世界的种子。
> 完全本地运行，零外部依赖，纯文件读取 + 零痕迹内存扫描，不改变游戏、日志无痕。

[English](#english) · [中文](#chinese)

## Chinese 中文

### 这是什么

一个在本地命令行运行的小工具：当你创建/重置新的 Minecraft 世界时，立刻显示这个世界的种子(seed)。适用于 Minecraft 1.16.1 + mcsrfairplay 整合包。

- ✅ **零外部依赖**：纯本地 Node.js 程序，不需要任何在线服务
- ✅ **三种取 seed 方式**，自动择优：
  1. `plain` 明文直读（level.dat 是明文 gzip）
  2. `enc` 密钥文件解密（读 worldDataKey.txt）
  3. `hunt` 零痕迹内存扫描（进程外 ReadProcessMemory，加密世界运行中 1 秒内出结果）
- ✅ **不改变游戏**：所有方式都不注入游戏、不加载额外组件、不改游戏文件、日志无痕

### 版本要求（重要）

| 组件 | 要求 |
|---|---|
| Minecraft | **1.16.1** |
| mcsrfairplay | **1.2.1**（版本不同主密钥不同，解密会失效） |
| Node.js | LTS 版（node -v 能出版本号） |
| JDK | 一般不需要 |

### 快速开始

1. 安装 **Node.js**（[nodejs.org](https://nodejs.org) 下载 LTS）
2. 解压本仓库 / 下载 Release 的 zip
3. **先启动游戏**（进入能创建/重置世界的界面）
4. 双击 `mcseed-app/` 里的脚本：

| 想做什么 | 双击 |
|---|---|
| 新开世界后立刻拿 seed（推荐） | `start-next.bat` |
| 后台一直监听，每个新世界自动抓 | `start-watch.bat` |
| 立刻拿最近世界的 seed | `start-now.bat` |

### 命令行用法

```bash
cd mcseed-app
node mcseed-app.js watch    # 后台监听
node mcseed-app.js next     # 等待新世界模式（重置世界→按Enter→看seed）
node mcseed-app.js now      # 立刻取当前世界
node mcseed-app.js show     # 查看最近 10 条捕获记录
```

### 配置

见 `config.json`（savesDir / beep / autoHeap / heapCooldownMs / logPath / statePath）。

### 文档

- [使用说明](docs/使用说明.md)
- [原理教学](docs/原理教学.md)
- [安装说明](docs/安装说明.md)
- [常见问题](docs/常见问题.md)

### 目录结构

```
mcseed/
├── config.json
├── mcseed-app/
│   ├── mcseed-app.js        # 主程序
│   ├── mcseed-lib.js        # gzip/NBT/seed 解析
│   ├── mcseed-crypto.js     # AES 解密
│   ├── start-*.bat          # 一键脚本
│   └── java/
│       ├── HuntKey.exe      # 零痕迹内存扫描核心（已编译）
│       └── HuntKey.cs       # 对应源码
└── docs/                    # 文档
```

### 免责声明

本项目仅供个人学习、本地研究及合法的单机/非排名场景使用。请在理解相关游戏规则后，自行判断使用场景与合规性。

---

## English

A local command-line tool that shows the seed of a newly created/reset Minecraft world (1.16.1 + mcsrfairplay). Runs fully offline.

- Zero external dependencies (pure Node.js)
- Three extraction methods, auto-selected: plaintext / key-file / zero-trace memory scan
- Non-intrusive: never injects, never loads extra components, never modifies game files, leaves no trace in game logs

**Requirements**: Minecraft 1.16.1 + mcsrfairplay 1.2.1 + Node.js (LTS).

**Quick start**: install Node.js → extract → start game → double-click `start-next.bat` in `mcseed-app/`.

## License

[MIT](LICENSE) © Suifeng-2077
