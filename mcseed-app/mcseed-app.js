'use strict';
// mcseed-app.js — 本地 Minecraft 1.16.1 seed 捕获器（零 DSH 依赖）
//
//   node mcseed-app.js watch   后台常驻监听：新世界出现自动捕获 seed，cmd 窗口实时显示+响铃
//   node mcseed-app.js next    交互式"等待新世界"模式：重置世界后按 Enter 显示新 seed
//   node mcseed-app.js now     立刻获取当前（最近修改的）世界的 seed
//   node mcseed-app.js show    打印最近捕获记录
//
// 路径自动检测（config.json 可选覆盖）：从运行中的 MC 游戏推导存档目录和 JDK 工具。
// 配置见 ../config.json（beep/autoHeap/heapCooldownMs/savesDir/logPath/statePath/jpsPath/javaPath）
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFile, execFileSync, spawn } = require('child_process');
const lib = require('./mcseed-lib.js');
const crypto = require('./mcseed-crypto.js');

// ---------- config ----------
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { /* defaults */ }

// ---------- CLI ----------
// node mcseed-app.js [watch|now|next|show] [--saves <dir>] [--log <file>] [--state <file>]
//                                          [--retry <n>] [--retry-ms <ms>] [--no-heap]
// 命令行优先级高于 config.json，便于多实例切换和不动发布配置做测试。
const ARGV = process.argv.slice(2);
function argValue(name) {
  const i = ARGV.indexOf(name);
  return i >= 0 && i + 1 < ARGV.length ? ARGV[i + 1] : null;
}
// 取模式参数时必须跳过 "--flag value" 里的 value，否则 `--saves D:\x now` 会把路径当模式。
const VALUE_FLAGS = ['--saves', '--log', '--state', '--retry', '--retry-ms', '--poll'];
function parseMode() {
  for (let i = 0; i < ARGV.length; i++) {
    const a = ARGV[i];
    if (VALUE_FLAGS.indexOf(a) >= 0) { i++; continue; }
    if (a.charAt(0) === '-') continue;
    return a;
  }
  return 'watch';
}
if (argValue('--saves')) cfg.savesDir = argValue('--saves');
if (argValue('--log')) cfg.logPath = argValue('--log');
if (argValue('--state')) cfg.statePath = argValue('--state');
if (ARGV.indexOf('--no-heap') >= 0) cfg.autoHeap = false;
if (argValue('--retry')) cfg.retryTimes = parseInt(argValue('--retry'), 10);
if (argValue('--retry-ms')) cfg.retryIntervalMs = parseInt(argValue('--retry-ms'), 10);
if (argValue('--poll')) cfg.pollMs = parseInt(argValue('--poll'), 10);

const BEEP = cfg.beep !== false;
// autoHeap 默认 true：watch 模式遇到加密无密钥世界也自动用 HuntKey 零痕迹内存扫描提取。
// 若想 watch 只读文件（加密世界等保存成明文再抓），在 config.json 设 "autoHeap": false。
const AUTO_HEAP = cfg.autoHeap !== false;
const HEAP_COOLDOWN_MS = cfg.heapCooldownMs || 20000;

// 新世界刚 reset 时 level.dat 已加密，worldDataKey.txt 实测要晚 1~3 秒才落盘。
// 等它落盘的成本远低于内存扫描，所以默认先重试再考虑 hunt。
const RETRY_TIMES = Number.isFinite(cfg.retryTimes) && cfg.retryTimes >= 0 ? cfg.retryTimes : 5;
const RETRY_INTERVAL_MS = Number.isFinite(cfg.retryIntervalMs) && cfg.retryIntervalMs > 0
  ? cfg.retryIntervalMs : 700;
// 扫存档目录的间隔。想"reset 后尽快看到 seed"就调小（400），代价是更频繁地扫目录。
const POLL_MS = Number.isFinite(cfg.pollMs) && cfg.pollMs >= 100 ? cfg.pollMs : 1200;

// 路径：config 显式配置优先，否则自动检测（从运行中的 MC 游戏推导）
let SAVES_DIR = cfg.savesDir || null;
let LOG_PATH = cfg.logPath || path.join(__dirname, 'seeds.log');
let STATE_PATH = cfg.statePath || path.join(__dirname, 'state.json');
let JPS = cfg.jpsPath || null;
let JAVA = cfg.javaPath || null;

// 自动检测：找到运行中的 MC (javaw) 进程 -> 同 JDK 的 jps + 实例存档目录。
// 兼容两类启动器：
//   - MultiMC：命令行带 -Djava.library.path=<实例>\natives
//   - 原版/其它：命令行带 -Dminecraft.gameDir=<目录> 或 -Djava.library.path=...\versions\...
// 都失败时回退到常见默认位置（%APPDATA%\.minecraft\saves 等），仍失败则用清晰报错让用户去配 config.json。
function autoDetect() {
  try {
    const pp = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      '$p = Get-Process javaw,java -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1; if ($p) { $p.Id.ToString() + "|" + $p.Path }',
    ], { encoding: 'utf8', timeout: 15000 }).trim();
    if (!pp || !pp.includes('|')) return;
    const sep = pp.indexOf('|');
    const javaExe = pp.slice(sep + 1);
    if (!javaExe) return;
    const javaBin = path.dirname(javaExe);
    if (!JAVA) JAVA = path.join(javaBin, 'java.exe');
    if (!JPS) JPS = path.join(javaBin, 'jps.exe');
    if (!SAVES_DIR) {
      try {
        const out = execFileSync(JPS, ['-lv'], { encoding: 'utf8', timeout: 10000 });
        for (const line of out.split('\n')) {
          // 1) MultiMC 形态：-Djava.library.path=<实例>\natives -> <实例>\.minecraft\saves
          const idx = line.indexOf('-Djava.library.path=');
          if (idx >= 0) {
            const inst = line.slice(idx + '-Djava.library.path='.length).trim().replace(/[\/\\]natives$/i, '');
            const cand = path.join(inst, '.minecraft', 'saves');
            if (fs.existsSync(cand)) { SAVES_DIR = cand; break; }
            // MultiMC 实例目录可能本身就是 .minecraft 内容，saves 就在 inst 同级或 inst\.minecraft
            const cand2 = path.join(inst, 'saves');
            if (fs.existsSync(cand2)) { SAVES_DIR = cand2; break; }
          }
          // 2) 原版形态：-Dminecraft.gameDir=<目录> -> <目录>\saves
          const gidx = line.indexOf('-Dminecraft.gameDir=');
          if (gidx >= 0) {
            const gdir = line.slice(gidx + '-Dminecraft.gameDir='.length).trim().split(/[\s]/)[0];
            const cand = path.join(gdir, 'saves');
            if (fs.existsSync(cand)) { SAVES_DIR = cand; break; }
          }
        }
      } catch (e) { /* jps failed */ }
    }
  } catch (e) { /* powershell failed */ }
}
autoDetect();

// 通用默认：优先探测常见存档位置，绝不硬编码某台机器路径。
if (!SAVES_DIR) {
  const candidates = [
    process.env.APPDATA && path.join(process.env.APPDATA, '.minecraft', 'saves'),
    process.env.HOME && path.join(process.env.HOME, '.minecraft', 'saves'),
    path.join(process.env.USERPROFILE || '', '.minecraft', 'saves'),
  ];
  for (const c of candidates) { if (c && fs.existsSync(c)) { SAVES_DIR = c; break; } }
}
if (!JPS) JPS = 'jps';
if (!JAVA) JAVA = 'java';

const JAVA_DIR = path.join(__dirname, 'java');
const HUNT_KEY_EXE = path.join(JAVA_DIR, 'HuntKey.exe');
// Hunt2 是改进版：klass 指针从主密钥自己的对象头推导、64KB 分块容错读取、
// 不做"可打印字节"过滤（原版会丢掉约 45% 的合法 32 字节密钥）。
const HUNT2_EXE = path.join(JAVA_DIR, 'Hunt2.exe');
const DUMP_DIR = path.join(__dirname, 'tmp');
fs.mkdirSync(DUMP_DIR, { recursive: true });

// 存档目录必须存在，否则报错并给出修复指引，绝不静默落到错误路径。
function ensureSavesDir() {
  if (SAVES_DIR && fs.existsSync(SAVES_DIR)) return true;
  console.error('[mcseed] 找不到 Minecraft 存档目录！');
  console.error('  - 请先启动 Minecraft 游戏再运行本程序；');
  console.error('  - 或手动编辑 config.json，把 savesDir 改成你的存档目录（...\\.minecraft\\saves）；');
  console.error('  - 当前解析到的值: ' + (SAVES_DIR || '(空)'));
  return false;
}

// ---------- state ----------
// 去重 key：优先用世界 UUID（worldUUID.txt，16字节），没有才回退世界名。
// 这样同名世界删除后重建（Fast Reset）也能重新捕获，不会被旧记录误判。
function worldKeyForDir(dir, name) {
  try {
    const uf = path.join(dir, 'mcsrfairplay', 'worldUUID.txt');
    if (fs.existsSync(uf)) {
      const b = fs.readFileSync(uf);
      if (b && b.length >= 4) return 'uuid:' + b.toString('hex');
    }
  } catch (e) { /* ignore */ }
  return 'name:' + name;
}
const seen = new Set();
// 加载 state：兼容两种格式——
//   1) 行式（每行一个 key，append-only，增量写）
//   2) 旧的 JSON 对象格式（兼容升级）
try {
  const raw = fs.readFileSync(STATE_PATH, 'utf8').trim();
  if (raw.startsWith('{')) {
    const s = JSON.parse(raw);
    for (const k of Object.keys(s)) seen.add(k);
  } else {
    for (const line of raw.split('\n')) {
      const k = line.trim();
      if (k) seen.add(k);
    }
  }
} catch (e) { /* first run */ }

// 增量写 state：只把新增的 key 追加到文件尾部，避免每次全量重写。
// 首次捕获时写一个完整行式文件（含已有 key），之后新 key 逐行追加。
// 兼容旧 JSON 格式：若原文件是 JSON，首次持久化时先转成行式完整写。
let stateFileExists = fs.existsSync(STATE_PATH);
let stateWasJson = false;
try { if (stateFileExists && fs.readFileSync(STATE_PATH, 'utf8').trim().startsWith('{')) stateWasJson = true; } catch (e) {}
function persistState(newKey) {
  try {
    if (!stateFileExists || stateWasJson) {
      // 首次 / 从 JSON 迁移：把当前所有 key 写成一个完整行式文件
      const lines = [];
      for (const k of seen) lines.push(k);
      fs.writeFileSync(STATE_PATH, lines.join('\n') + '\n');
      stateFileExists = true;
      stateWasJson = false;
      return;
    }
    // 增量：追加单个新增 key（避免扫描整个 seen）
    if (newKey) fs.appendFileSync(STATE_PATH, newKey + '\n');
  } catch (e) { /* ignore */ }
}

// ---------- helpers ----------
function log(line) {
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) { /* ignore */ }
  console.log(line);
}
// 通知：cmd 窗口实时输出（log 已打印）+ 可选提示音
function beep() {
  if (!BEEP) return;
  try { process.stdout.write('\x07'); } catch (e) { /* ignore */ }
}
let lastToastAt = 0;
function notifyNewWorld(name, seed, isNew) {
  // cmd 窗口即通知：只对"新捕获"响铃提示（首次扫描历史存量不响）
  if (!isNew) return;
  const now = Date.now();
  if (now - lastToastAt < 2000) return;
  lastToastAt = now;
  beep();
}
function tryParseGzip(bytes) {
  try {
    if (bytes.length > 4 && bytes[0] === 0x1f && bytes[1] === 0x8b) return lib.parseNbt(lib.gunzip(bytes));
  } catch (e) { /* not gzip NBT */ }
  return null;
}
function readSeedFromDir(dir) {
  const ldPath = path.join(dir, 'level.dat');
  if (!fs.existsSync(ldPath)) return null;
  let ld;
  try {
    ld = fs.readFileSync(ldPath);
  } catch (e) {
    // Fast Reset 下世界目录可能正在被删除/重建，读到一半消失是正常竞态，返回 null 不抛。
    return null;
  }
  let nbt = tryParseGzip(ld);
  if (nbt) {
    const seed = lib.extractSeed(nbt);
    if (seed) {
      return {
        seed: seed.dec, seedNum: seed.num, levelName: lib.extractLevelName(nbt),
        mode: 'plain', kind: seed.kind, opaque: seed.opaque === true, rawLen: seed.rawLen,
      };
    }
  }
  const kf = path.join(dir, 'mcsrfairplay', 'worldDataKey.txt');
  if (fs.existsSync(kf)) {
    try {
      const wk = crypto.unwrapWorldKey(fs.readFileSync(kf));
      const plain = crypto.unwrapLevelDat(ld, wk);
      nbt = tryParseGzip(plain);
      if (nbt) {
        const seed = lib.extractSeed(nbt);
        if (seed) {
          return {
            seed: seed.dec, seedNum: seed.num, levelName: lib.extractLevelName(nbt),
            mode: 'enc', kind: seed.kind, opaque: seed.opaque === true, rawLen: seed.rawLen,
          };
        }
      }
    } catch (e) { /* 主密钥不匹配 / 世界里还没写完 */ }
  }
  return null;
}

// 世界当前处于哪种状态（决定该重试等 key、还是要报"磁盘上没有 seed"）。
function worldState(dir) {
  const ldPath = path.join(dir, 'level.dat');
  if (!fs.existsSync(ldPath)) return 'absent';
  let fd = null;
  try {
    fd = fs.openSync(ldPath, 'r');
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'plain';
  } catch (e) {
    return 'absent';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
  }
  return fs.existsSync(path.join(dir, 'mcsrfairplay', 'worldDataKey.txt')) ? 'key-ok' : 'key-nokey';
}

// 新世界刚创建时 level.dat 已加密，而 worldDataKey.txt 要晚 1~3 秒才落盘。
// 与其上内存扫描（分钟级、需 OpenProcess 权限），不如在这里等 key 落盘：
// 实测 1409 个真实速通世界里 99.7% 都能靠这条路拿到 seed。
async function readSeedWithRetry(dir, tries, intervalMs) {
  let res = readSeedFromDir(dir);
  if (res) return res;
  const n = tries === undefined ? RETRY_TIMES : tries;
  const wait = intervalMs === undefined ? RETRY_INTERVAL_MS : intervalMs;
  for (let i = 0; i < n; i++) {
    await sleep(wait);
    res = readSeedFromDir(dir);
    if (res) return res;
    // 只有世界被删掉才停止等待；key 刚落盘、文件还在写这两种情况都要继续试。
    if (worldState(dir) === 'absent') break;
  }
  return null;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
let cachedMcPid = null;
function findMcPid() {
  // 缓存 PID：游戏进程通常不变，避免每次全量 jps 扫描 + PowerShell 调用。
  // 每次仍做轻量存活验证（process.kill(pid,0)），游戏重启后自然失效并重新探测。
  if (cachedMcPid !== null && isProcessAlive(cachedMcPid)) return cachedMcPid;
  // 1) jps -lv 匹配常见 MC 主类（MultiMC/原版/Prism/CurseForge 等）
  try {
    const out = execFileSync(JPS, ['-lv'], { encoding: 'utf8', timeout: 10000 });
    const mains = [
      /org\.multimc\.EntryPoint/,      // MultiMC / PolyMC / Prism
      /net\.fabricmc\.loader\.impl\.launcher\.knot\.KnotClient/, // Fabric (KnotClient)
      /net\.minecraft\.client\.main\.Main/, // 原版 / CurseForge
      /com\.mojang\.minecraft\.launcher\.|net\.minecraft\.bootstrap\.Launcher/,
      /--launcherSessionId/,
    ];
    for (const line of out.split('\n')) {
      const pidm = line.match(/^(\d+)\s+(\S+)/);
      if (!pidm) continue;
      const isMc = mains.some((re) => re.test(line)) || /fabric|minecraft|1\.16/i.test(line);
      if (isMc && pidm[2] !== 'jps' && !/Jps$/.test(pidm[2])) { cachedMcPid = parseInt(pidm[1], 10); return cachedMcPid; }
    }
  } catch (e) { /* ignore */ }
  // 2) 兜底：PowerShell 找 javaw 进程（MC 主进程通常是 javaw）
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      '$p = Get-Process javaw -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { $p.Id }',
    ], { encoding: 'utf8', timeout: 15000 }).trim();
    const n = parseInt(out, 10);
    if (n > 0) { cachedMcPid = n; return n; }
  } catch (e) { /* ignore */ }
  return null;
}
let heapBusy = false;
let lastHeapAt = 0;
let lastHeapError = null;

// 零痕迹内存提取：进程外 ReadProcessMemory 扫 worldKey 并解密 level.dat（HuntKey.exe）。
// 不 attach、不加载 agent、不写游戏文件 → latest.log 零痕迹。较慢（全内存扫描，分钟级）。
// 走 spawn 异步：旧实现 execFileSync 会同步阻塞主线程最长 10 分钟，watch 心跳与 lock 感知全停。
const HUNT_TIMEOUT_MS = 600000;
function huntSeedRaw(worldDir) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const pid = findMcPid();
      if (!pid) return done({ error: 'no-mc-process' });
      const ldPath = path.join(worldDir, 'level.dat');
      if (!fs.existsSync(ldPath)) return done({ error: 'no-level-dat' });
      const outGz = path.join(DUMP_DIR, 'hunt-' + Date.now() + '-' + process.pid + '.gzip');
      // 进程外扫 worldKey -> 解密 level.dat -> 明文 gzip 写到 outGz。
      // seed 提取交给本地的 lib（可靠），不依赖扫描器内部输出。
      // 优先 Hunt2（自适应 klass、分块容错、不做可打印过滤），需要 worldUUID 做快路径。
      const uuidPath = path.join(worldDir, 'mcsrfairplay', 'worldUUID.txt');
      let exe = null;
      let exeArgs = null;
      if (fs.existsSync(HUNT2_EXE) && fs.existsSync(uuidPath)) {
        exe = HUNT2_EXE;
        exeArgs = [String(pid), ldPath, uuidPath, outGz];
        if (Number.isFinite(cfg.huntThreads) && cfg.huntThreads > 0) {
          exeArgs.push('--threads', String(cfg.huntThreads));
        }
      } else if (fs.existsSync(HUNT_KEY_EXE)) {
        exe = HUNT_KEY_EXE;
        exeArgs = [String(pid), ldPath, outGz];
      } else {
        return done({ error: 'no-hunt-exe' });
      }
      const child = spawn(exe, exeArgs, { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => {
        try { child.kill(); } catch (e) { /* ignore */ }
        done({ outGz: outGz, error: 'timeout' });
      }, HUNT_TIMEOUT_MS);
      child.on('error', (e) => {
        clearTimeout(timer);
        done({ outGz: outGz, error: 'spawn-failed', message: e && e.message });
      });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          if (fs.existsSync(outGz) && fs.statSync(outGz).size > 0) {
            const nbt = lib.parseNbt(lib.gunzip(fs.readFileSync(outGz)));
            const seed = lib.extractSeed(nbt);
            if (seed) {
              return done({
                outGz: outGz,
                result: {
                  seed: seed.dec, seedNum: seed.num,
                  levelName: lib.extractLevelName(nbt) || path.basename(worldDir),
                  mode: 'hunt', kind: seed.kind, opaque: seed.opaque === true,
                },
              });
            }
            return done({ outGz: outGz, error: 'no-seed-in-output' });
          }
          done({ outGz: outGz, error: 'empty-output' });
        } catch (e) {
          done({ outGz: outGz, error: 'parse-failed', message: e && e.message });
        }
      });
    } catch (e) {
      done({ error: 'unexpected', message: e && e.message });
    }
  });
}

// 取加密世界的 seed：零痕迹 HuntKey（进程外读内存），无 attach/堆转储路径。
// 只读内存、不注入游戏、不写游戏文件 → latest.log 零痕迹。
// force=true（now/next）时总是尝试；否则（watch）每个世界只尝试一次，避免反复扫描。
const heapAttempted = new Set();
async function heapExtract(worldDir, force) {
  if (heapBusy) return null;
  if (!force && heapAttempted.has(worldDir)) return null;
  if (!force) heapAttempted.add(worldDir);
  heapBusy = true;
  lastHeapAt = Date.now();
  let outGz = null;
  try {
    const r = await huntSeedRaw(worldDir);
    outGz = (r && r.outGz) || null;
    if (r && r.result) return r.result;
    lastHeapError = (r && r.error) || 'unknown';
    return null;
  } catch (e) {
    lastHeapError = 'unexpected';
    return null;
  } finally {
    // 只删本次自己产出的临时文件。旧实现清空整个 tmp/，会把用户放在那里的文件一起删掉。
    if (outGz) { try { fs.unlinkSync(outGz); } catch (e) { /* ignore */ } }
    heapBusy = false;
  }
}

// 返回 'captured' | 'retry' | 'skip'
// retry = 世界还在写（下个 tick 再试）；skip = 判定拿不到，记一条 fail 日志后本次进程内不再尝试。
const failCount = new Map();
const abandoned = new Set();
const FAIL_LIMIT = 3;

function describeFailure(dirPath, st) {
  if (st === 'absent') return 'level.dat 不存在（世界已被删除或仍在创建）';
  if (st === 'key-nokey') return 'level.dat 已加密但 worldDataKey.txt 尚未生成（世界还没保存完）';
  if (st === 'plain') return 'level.dat 是明文但解析不出 seed（NBT 结构异常）';
  if (st === 'key-ok') return '已加密且 key 存在，但主密钥不匹配或文件不完整（检查 fairplay 版本）';
  return '未知原因';
}

// 世界刚创建（level.dat 最近才写过）才值得等 key 落盘。历史世界里存在"加密但没有
// worldDataKey.txt"的死世界（实测 3/321），对它们每 tick 等 3.5 秒会把监听循环拖死。
// 新鲜度不能只看 level.dat 的 mtime：复制的世界会带着旧 mtime 进来，所以同时看
// worldUUID.txt 与目录本身的创建时间。
const FRESH_MS = 60000;
function isFreshWorld(dir) {
  try {
    let newest = 0;
    for (const p of [path.join(dir, 'level.dat'), path.join(dir, 'mcsrfairplay', 'worldUUID.txt')]) {
      try {
        const st = fs.statSync(p);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch (e) { /* missing */ }
    }
    try {
      const b = fs.statSync(dir).birthtimeMs;
      if (b > newest) newest = b;
    } catch (e) { /* ignore */ }
    if (newest === 0) return false;
    return Date.now() - newest < FRESH_MS;
  } catch (e) {
    return false;
  }
}

// 世界是否被玩家真正进入过。判据是 playerdata/*.dat 非空：Minecraft 在你进世界时
// 立刻写玩家数据。SeedQueue 预生成、只被 WorldPreview 预览过的世界没有这个文件，
// 也就没有 worldKey（fairplay 只在世界被加载时生成），对它们扫描纯属浪费。
// 不用 region 文件大小判断：刚进世界的头几秒 region 已经建好但内容还是 0 字节。
function hasPlayerJoined(dir) {
  try {
    const pd = path.join(dir, 'playerdata');
    if (!fs.existsSync(pd)) return false;
    for (const f of fs.readdirSync(pd)) {
      if (!/\.dat$/i.test(f)) continue;
      try {
        if (fs.statSync(path.join(pd, f)).size > 0) return true;
      } catch (e) { /* ignore */ }
    }
    return false;
  } catch (e) {
    return false;
  }
}

// 兜底：没有 playerdata 但确实生成过地形（极少数存档结构）。
function hasRegionData(dir) {
  try {
    const rd = path.join(dir, 'region');
    if (!fs.existsSync(rd)) return false;
    for (const f of fs.readdirSync(rd)) {
      if (!/\.mca$/i.test(f)) continue;
      try {
        if (fs.statSync(path.join(rd, f)).size > 4096) return true;
      } catch (e) { /* ignore */ }
    }
    return false;
  } catch (e) {
    return false;
  }
}

function worthHunting(dir) {
  return hasPlayerJoined(dir) || hasRegionData(dir);
}

async function captureOne(dirPath, name, firstScan) {
  const wkey = worldKeyForDir(dirPath, name);
  if (seen.has(wkey)) return 'captured';
  if (abandoned.has(wkey)) {
    // 被放弃过的世界如果后来玩家进去了，要复活它 —— SeedQueue 队列里的空壳
    // 往往是"先生成、隔几十秒才进"，早先的失败不代表拿不到。
    if (!hasPlayerJoined(dirPath)) return 'skip';
    abandoned.delete(wkey);
    failCount.delete(wkey);
  }

  const fresh = isFreshWorld(dirPath);
  const joined = hasPlayerJoined(dirPath);
  const keyFile = path.join(dirPath, 'mcsrfairplay', 'worldDataKey.txt');
  const hasKeyFile = fs.existsSync(keyFile);

  // 玩家已经进入、key 文件却不存在：fairplay 对运行中的世界不会写 key（只留在内存），
  // 所以别在这儿白等 —— 一步跳到内存扫描，能省掉整段 key 重试窗口。
  let res;
  if (joined && !hasKeyFile) {
    res = readSeedFromDir(dirPath);
  } else {
    res = fresh ? await readSeedWithRetry(dirPath) : readSeedFromDir(dirPath);
  }
  const st = worldState(dirPath);

  // 玩家还没进去、也没地形数据的世界，就是 SeedQueue 队列里的空壳。
  // 它们不算失败：不计 fail、不写日志、不放弃，安静等玩家进去。
  if (!res && !joined && !hasRegionData(dirPath)) {
    return 'idle';
  }

  // 自动内存扫描：只对"玩家真正进过的"世界做。
  // 首扫时只放行新鲜的世界，历史世界一律不扫，避免启动时把 CPU 打满。
  const huntable = joined || hasRegionData(dirPath);
  const allowHunt = huntable && (!firstScan || fresh);
  if (!res && allowHunt && AUTO_HEAP && st === 'key-nokey') {
    // 冷却期内不算失败：否则会被 failCount 推成 abandoned，等冷却过了永远不再尝试。
    if (Date.now() - lastHeapAt <= HEAP_COOLDOWN_MS) return 'idle';
    res = await heapExtract(dirPath);
    if (res) lastHeapAt = Date.now();
  }
  if (!res) {
    const n = (failCount.get(wkey) || 0) + 1;
    failCount.set(wkey, n);
    const reason = describeFailure(dirPath, st) + (lastHeapError ? '（hunt: ' + lastHeapError + '）' : '');
    if (n === 1) console.log('[mcseed] 未能取到 "' + name + '" 的 seed：' + reason);
    // 历史世界拿不到就是拿不到；只有刚创建的世界才继续等下一轮。
    if (!fresh || n >= FAIL_LIMIT) {
      abandoned.add(wkey);
      log([new Date().toISOString(), 'fail', st, name, reason, ''].join('\t'));
      return 'skip';
    }
    return 'retry';
  }

  seen.add(wkey);
  persistState(wkey);

  // 非数字 seed（整合包把 seed 字段换成 base64/字符串占位）单独标记，不能和真实 long seed
  // 混在同一列里让人误以为拿到了种子。
  const seedCol = res.opaque ? res.seed + '\t(opaque)' : res.seed;
  const iso = new Date().toISOString();
  log([iso, firstScan ? 'init' : 'new', res.mode, name, res.levelName || '', seedCol].join('\t'));
  pushRecent({
    time: iso, kind: firstScan ? 'init' : 'new', mode: res.mode,
    name: name, levelName: res.levelName || '', seed: res.seed,
    opaque: res.opaque === true, seedNum: res.seedNum,
  });
  if (res.opaque) {
    console.log('[mcseed] "' + name + '" 的 seed 字段是占位串（' + res.seed + '），磁盘上没有可用的真实 seed。');
  } else {
    notifyNewWorld(name, res.seed, !firstScan);
  }
  return 'captured';
}

// ---------- watch ----------
async function watchLoop() {
  console.log('==============================================');
  console.log('  MC Seed Watch  [运行中]');
  console.log('  存档目录: ' + SAVES_DIR);
  console.log('  JDK: ' + JAVA);
  console.log('  日志: ' + LOG_PATH);
  console.log('  模式: ' + (AUTO_HEAP ? '自动提取(零痕迹内存扫描)' : '零痕迹(文件直读)'));
  console.log('  新世界捕获时响一声; 关闭本窗口即停止; 再双击本脚本会提示已在运行');
  console.log('==============================================');
  let firstScan = true;
  let scanning = false;
  let ticks = 0;
  const tick = async () => {
    if (scanning) return;
    scanning = true;
    ticks++;
    const stat = { captured: 0, retry: 0, skip: 0, error: 0, idle: 0 };
    try {
      const entries = fs.readdirSync(SAVES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const e of entries) {
        const dirPath = path.join(SAVES_DIR, e.name);
        try {
          if (seen.has(worldKeyForDir(dirPath, e.name))) continue;
          // 必须 await：captureOne 是 async，未 await 时它内部抛错会变成
          // unhandledRejection，Node 15+ 默认直接终止整个监听进程（Fast Reset 竞态必中）。
          const r = await captureOne(dirPath, e.name, firstScan);
          stat[r] = (stat[r] || 0) + 1;
          if (r === 'idle') continue;
        } catch (err) {
          stat.error++;
          if (stat.error <= 3) {
            console.error('[mcseed] 跳过 "' + e.name + '"：' + (err && err.message ? err.message : err));
          }
        }
      }
      if (firstScan) {
        firstScan = false;
        console.log('[' + new Date().toLocaleTimeString() + '] 首次扫描完成：新记录 ' + stat.captured +
          '，待重试 ' + stat.retry + '，队列中 ' + stat.idle + '，放弃 ' + stat.skip + '，异常 ' + stat.error);
      }
      // 心跳：每 60 秒打印一次状态，证明程序活着
      if (ticks % 50 === 0) {
        console.log('[' + new Date().toLocaleTimeString() + '] 运行中... 已捕获 ' + seen.size + ' 个世界 (日志: ' + LOG_PATH + ')');
      }
    } catch (e) {
      console.error('[mcseed] 监听遇到错误，继续运行：' + (e && e.message ? e.message : e));
    } finally {
      scanning = false;
    }
  };
  setInterval(tick, POLL_MS);
  await tick();
}

// ---------- now ----------
async function nowMode() {
  const entries = fs.readdirSync(SAVES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  entries.sort((a, b) => {
    const ta = fs.existsSync(path.join(SAVES_DIR, a.name, 'level.dat')) ? fs.statSync(path.join(SAVES_DIR, a.name, 'level.dat')).mtimeMs : 0;
    const tb = fs.existsSync(path.join(SAVES_DIR, b.name, 'level.dat')) ? fs.statSync(path.join(SAVES_DIR, b.name, 'level.dat')).mtimeMs : 0;
    return tb - ta;
  });
  if (entries.length === 0) { console.log('没有找到存档'); return; }
  const name = entries[0].name;
  const dir = path.join(SAVES_DIR, name);
  console.log('[mcseed] 目标世界: ' + name);
  const fresh = isFreshWorld(dir);
  let res = fresh ? await readSeedWithRetry(dir) : readSeedFromDir(dir);
  const st = worldState(dir);
  if (!res && st === 'key-nokey') {
    console.log('[mcseed] 等待 worldDataKey.txt 落盘未果，改用零痕迹内存扫描（HuntKey）...');
    res = await heapExtract(dir, true);
  }
  if (res) {
    console.log('[mcseed] seed = ' + res.seed + '  (mode=' + res.mode + (res.opaque ? ', 占位串' : '') + ')');
    log([new Date().toISOString(), 'now', res.mode, name, res.levelName || '', res.seed].join('\t'));
    if (!res.opaque) beep();
  } else {
    console.log('未能获取 [' + name + '] 的 seed：' + describeFailure(dir, st) +
      (lastHeapError ? '（hunt: ' + lastHeapError + '）' : ''));
    console.log('  可能原因：');
    console.log('  - 游戏未运行：请先启动 Minecraft 游戏再试（加密世界需要从游戏内存读取）。');
    console.log('  - 这个世界的 seed 可能还没准备好：过几秒再试，或稍后重试。');
    console.log('  - 若持续失败，请检查游戏整合包是否为 1.16.1 + mcsrfairplay 1.2.1。');
  }
}

// ---------- next：交互式"等待新世界"模式 ----------
async function nextMode() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, () => res()));
  const newestWorld = () => {
    try {
      const entries = fs.readdirSync(SAVES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
      let best = null, bestT = 0;
      for (const e of entries) {
        const lp = path.join(SAVES_DIR, e.name, 'level.dat');
        if (fs.existsSync(lp)) {
          const t = fs.statSync(lp).mtimeMs;
          if (t > bestT) { bestT = t; best = e.name; }
        }
      }
      return best;
    } catch (e) { return null; }
  };
  const seedOf = async (name) => {
    const dir = path.join(SAVES_DIR, name);
    let res = await readSeedWithRetry(dir);
    if (!res && worldState(dir) === 'key-nokey') res = await heapExtract(dir, true);
    return res;
  };
  console.log('==============================================');
  console.log('  MC Seed - 等待新世界模式');
  console.log('  流程: 在游戏里重置/创建新世界 -> 回这个窗口按 Enter');
  console.log('        -> 立即显示新世界的 seed');
  console.log('  不满意就再重置一次，再按 Enter。Ctrl+C 退出。');
  console.log('==============================================');
  let last = newestWorld();
  if (last) console.log('  当前最新世界: ' + last);
  while (true) {
    await ask('  按 Enter 等待下一个新世界...');
    console.log('  等待新世界出现...');
    let next = newestWorld();
    const deadline = Date.now() + 10 * 60 * 1000;
    while (next === last && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1200));
      next = newestWorld();
    }
    if (next === last) { console.log('  10 分钟内没检测到新世界，再按 Enter 继续等'); continue; }
    last = next;
    console.log('  检测到新世界: ' + next + '，读取 seed...');
    const nextState = worldState(path.join(SAVES_DIR, next));
    if (nextState === 'key-nokey') {
      console.log('  （worldDataKey.txt 还没落盘，先等它写完；超时再走内存扫描）');
    }
    const res = await seedOf(next);
    if (res) {
      console.log('==============================================');
      console.log('  新世界: ' + next);
      console.log('   seed = ' + res.seed + '   (mode=' + res.mode + ')');
      console.log('==============================================');
      beep();
      log([new Date().toISOString(), 'next', res.mode, next, res.levelName || '', res.seed].join('\t'));
    } else {
      console.log('  未能获取 [' + next + '] 的 seed：' + describeFailure(path.join(SAVES_DIR, next), worldState(path.join(SAVES_DIR, next))) +
        (lastHeapError ? '（hunt: ' + lastHeapError + '）' : ''));
      console.log('  可能原因：游戏未运行 / seed 尚未就绪。');
      console.log('  请确认游戏已打开，按 Enter 再试一次。');
      console.log('  若持续失败，检查整合包是否为 1.16.1 + mcsrfairplay 1.2.1。');
    }
  }
}

// ---------- show ----------
function showMode() {
  if (!fs.existsSync(LOG_PATH)) { console.log('暂无记录'); return; }
  const lines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
  console.log('共 ' + lines.length + ' 条记录，最近 10 条：');
  for (const l of lines.slice(-10)) console.log('  ' + l);
}

// ---------- 手机看板（局域网）----------
// 用途：打完一局用手机看 seed，不切回电脑窗口。电脑侧不产生窗口切换/光标离窗，
// fairplay 的 input_log 时间线里就不会出现"人离开游戏"的空档。
// 只监听本机网卡、只读内存里的 recent，不写入任何文件，不访问外网。
const recent = [];
const sseClients = new Set();
function pushRecent(rec) {
  recent.push(rec);
  if (recent.length > 50) recent.shift();
  const payload = 'data: ' + JSON.stringify(rec) + '\n\n';
  for (const c of sseClients) {
    try { c.write(payload); } catch (e) { /* client gone */ }
  }
}
function lanAddresses() {
  const out = [];
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const a of ifs[name] || []) {
        if (a.family === 'IPv4' && !a.internal) out.push(a.address);
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

// 手机打开页面时要立刻有东西看：从日志尾部回填最近几条（不回填的话，历史世界
// 早已记进 state，进程刚启动时 recent 是空的，手机看到的是一片空白）。
// 从尾部往前找、跳过 fail 行，直到凑够 n 条 —— 日志末尾经常是一串 fail。
function loadRecentFromLog(n) {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const want = n || 20;
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
    const picked = [];
    for (let i = lines.length - 1; i >= 0 && picked.length < want; i--) {
      const p = lines[i].split('\t');
      if (p.length < 6) continue;
      if (p[1] === 'fail') continue;
      picked.push({
        time: p[0], kind: p[1], mode: p[2], name: p[3],
        levelName: p[4], seed: p[5], opaque: p[6] === '(opaque)',
      });
    }
    picked.reverse();
    for (const r of picked) recent.push(r);
    if (recent.length > 50) recent.splice(0, recent.length - 50);
  } catch (e) { /* ignore */ }
}
const PHONE_HTML = [
  '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  '<meta name="theme-color" content="#090b0e" media="(prefers-color-scheme: dark)">',
  '<meta name="theme-color" content="#f6f8fb" media="(prefers-color-scheme: light)">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<title>MC Seed</title><style>',
  ':root{color-scheme:light dark;--spring:linear(0,.32 11%,.68 23%,.9 36%,1.01 50%,1.01 64%,1 100%)}',
  '/* fallback: dark palette for engines without light-dark() */',
  ':root{--bg:#090b0e;--fg:#eef3f8;--dim:#7c8895;--dim2:#4f5b68;--line:#1e2733;--line2:#2a3644;',
  '--acc:#5fe39b;--acc2:#2f7d57;--warn:#f0b46b;--tap:#1a232d;--pill:#0f1419;',
  '--g1:#18212a;--g2:#121821;--g3:#0f141a;--glow:rgba(95,227,155,.16);',
  '--pageglow:rgba(95,227,155,.075);--shadow:rgba(0,0,0,.9);--inset:rgba(255,255,255,.035);',
  '--rs:#b7c6d6;--dot:#e0606a}',
  '@supports (color:light-dark(#fff,#000)){:root{',
  '--bg:light-dark(oklch(.977 .004 250),oklch(.168 .012 252));',
  '--fg:light-dark(oklch(.22 .015 250),oklch(.965 .006 250));',
  '--dim:light-dark(oklch(.47 .015 250),oklch(.64 .014 250));',
  '--dim2:light-dark(oklch(.63 .012 250),oklch(.47 .012 250));',
  '--line:light-dark(oklch(.9 .008 250),oklch(.28 .018 252));',
  '--line2:light-dark(oklch(.86 .01 250),oklch(.33 .022 252));',
  '--acc:light-dark(oklch(.58 .14 157),oklch(.845 .155 157));',
  '--acc2:light-dark(oklch(.52 .14 157),oklch(.56 .125 157));',
  '--warn:light-dark(oklch(.6 .13 70),oklch(.78 .13 70));',
  '--tap:light-dark(oklch(.94 .008 250),oklch(.2 .016 252));',
  '--pill:light-dark(oklch(.96 .005 250),oklch(.19 .014 252));',
  '--g1:light-dark(oklch(1 0 0),oklch(.26 .018 252));',
  '--g2:light-dark(oklch(.975 .003 250),oklch(.21 .015 252));',
  '--g3:light-dark(oklch(.955 .005 250),oklch(.185 .013 252));',
  '--glow:light-dark(rgba(47,125,87,.10),rgba(95,227,155,.16));',
  '--pageglow:light-dark(rgba(47,125,87,.055),rgba(95,227,155,.075));',
  '--shadow:light-dark(rgba(20,40,70,.14),rgba(0,0,0,.9));',
  '--inset:light-dark(rgba(255,255,255,.9),rgba(255,255,255,.035));',
  '--rs:light-dark(oklch(.42 .015 250),oklch(.76 .012 250));}}',
  '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}',
  'html,body{margin:0;padding:0}',
  'body{background:radial-gradient(120% 55% at 50% -12%,var(--pageglow),transparent 62%),var(--bg);',
  'color:var(--fg);min-height:100vh;',
  'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;',
  'padding:0 16px calc(28px + env(safe-area-inset-bottom));',
  '-webkit-font-smoothing:antialiased;overflow-x:hidden;transition:background-color .3s,color .3s}',
  'header{position:sticky;top:0;z-index:9;display:flex;align-items:center;justify-content:space-between;',
  'gap:10px;padding:calc(14px + env(safe-area-inset-top)) 0 12px;',
  'background:linear-gradient(var(--bg) 62%,transparent)}',
  '.brand{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13px;',
  'font-weight:600;letter-spacing:.22em;color:var(--fg)}',
  '.brand s{text-decoration:none;color:var(--acc2);margin-left:2px}',
  '.pill{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;',
  'background:var(--pill);border:1px solid var(--line);font-size:11px;color:var(--dim);',
  'font-family:system-ui,-apple-system,sans-serif;letter-spacing:.02em;white-space:nowrap}',
  '.pill i{width:6px;height:6px;border-radius:50%;background:var(--dim2);flex:0 0 auto;transition:.25s}',
  '.pill.ok i{background:var(--acc);box-shadow:0 0 9px var(--acc)}',
  '.pill.bad i{background:var(--dot);box-shadow:0 0 9px var(--dot)}',
  '.cap{font-family:system-ui,-apple-system,sans-serif;font-size:10.5px;letter-spacing:.18em;',
  'color:var(--dim2);margin:20px 2px 9px;display:flex;align-items:center;justify-content:space-between}',
  '.cap b{font-weight:500;color:var(--dim);letter-spacing:.14em}',
  '.cap.tap{cursor:pointer}.cap.tap:active b{color:var(--fg)}',
  '.hero{position:relative;border-radius:18px;padding:17px 17px 14px;overflow:hidden;',
  'background:linear-gradient(158deg,var(--g1) 0%,var(--g2) 46%,var(--g3) 100%);',
  'border:1px solid var(--line2);',
  'box-shadow:0 10px 30px -18px var(--shadow),inset 0 1px 0 var(--inset);',
  'transition:background .3s,border-color .3s}',
  '.hero::before{content:"";position:absolute;left:0;right:0;top:-55%;height:120px;pointer-events:none;',
  'background:radial-gradient(58% 100% at 26% 100%,var(--glow),transparent 72%)}',
  '.hero.empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:34px 18px;color:var(--dim2)}',
  '.hero.empty svg{opacity:.4}',
  '.hero.empty span{font-family:system-ui,sans-serif;font-size:12.5px;letter-spacing:.02em}',
  '.hname{font-family:system-ui,-apple-system,sans-serif;font-size:12.5px;color:var(--dim);',
  'letter-spacing:.02em;margin-bottom:11px;word-break:break-all}',
  '.seed{font-size:clamp(17px,6.2vw,30px);font-weight:700;line-height:1.14;color:var(--acc);',
  'letter-spacing:0;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}',
  '.seed .grp{display:inline-block;margin-left:.2em}.seed .grp:first-child{margin-left:0}',
  '.seed .dg{display:inline-block;width:.6em;height:1.14em;overflow:hidden;vertical-align:-.14em}',
  '.seed .dg i{display:block;transition:transform .78s var(--spring);will-change:transform}',
  '.seed .dg b{display:block;height:1.14em;line-height:1.14em;text-align:center;font-weight:700}',
  '.seed .neg{opacity:.5;font-weight:600;margin-right:.04em}',
  '.seed.op{font-size:13px;color:var(--warn);line-height:1.45;font-weight:600;word-break:break-all;white-space:normal}',
  '.seed.op .grp{margin-left:0}',
  '.hmeta{display:flex;align-items:center;gap:9px;margin-top:13px;padding-top:11px;',
  'border-top:1px solid var(--line);',
  'font-family:system-ui,-apple-system,sans-serif;font-size:11px;color:var(--dim2);letter-spacing:.03em}',
  '.hmeta b{color:var(--acc2);font-weight:600;letter-spacing:.06em;text-transform:uppercase}',
  '.hmeta em{font-style:normal;color:var(--dim);margin-left:auto}',
  '#list{margin-top:2px}',
  '#list.hide{display:none}',
  '.row{display:grid;grid-template-columns:1fr auto;gap:5px 12px;padding:13px 15px;',
  'border-bottom:1px solid var(--line);transition:background .15s}',
  '.row:first-child{border-top:1px solid var(--line)}',
  '.row:active{background:var(--tap)}',
  '.rn{font-family:system-ui,-apple-system,sans-serif;font-size:12px;color:var(--dim);',
  'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.rt{grid-column:2;grid-row:1;font-size:10.5px;color:var(--dim2);text-align:right;white-space:nowrap;',
  'font-family:system-ui,sans-serif}',
  '.rs{grid-column:1/-1;font-size:15px;color:var(--rs);font-variant-numeric:tabular-nums;',
  'word-break:break-all}',
  '@keyframes slidein{from{opacity:0;transform:translateY(-7px)}to{opacity:1;transform:none}}',
  '@keyframes flash{0%{box-shadow:inset 0 0 0 2px var(--acc),inset 0 0 60px var(--glow)}',
  '100%{box-shadow:inset 0 0 0 2px transparent,inset 0 0 0 transparent}}',
  'body.flash{animation:flash .85s ease-out}',
  '.row.fresh{animation:slidein .38s cubic-bezier(.2,.7,.3,1)}',
  '.toast{position:fixed;left:50%;bottom:calc(30px + env(safe-area-inset-bottom));',
  'transform:translate(-50%,16px);background:var(--pill);border:1px solid var(--line2);color:var(--fg);',
  'font-family:system-ui,sans-serif;font-size:12px;padding:10px 17px;border-radius:999px;opacity:0;',
  'transition:.22s cubic-bezier(.2,.7,.3,1);pointer-events:none;max-width:88vw;text-align:center;',
  'box-shadow:0 12px 30px -14px var(--shadow)}',
  '.toast.on{opacity:1;transform:translate(-50%,0)}',
  'footer{margin-top:22px;text-align:center;font-family:system-ui,sans-serif;font-size:10.5px;',
  'color:var(--dim2);letter-spacing:.06em}',
  '@media (min-width:640px){body{max-width:680px;margin:0 auto}}',
  '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}',
  '</style></head><body>',
  '<header><div class="brand">MC<s>·</s>SEED</div>',
  '<div class="pill" id="pill"><i></i><em id="pillT">连接中</em></div></header>',
  '<div class="cap"><b>最新</b></div><div id="hero"></div>',
  '<div class="cap tap" id="histT"><b>历史 <span id="histN"></span></b><span>点一下复制</span></div>',
  '<div id="list" class="hide"></div>',
  '<footer id="foot"></footer>',
  '<div class="toast" id="toast"></div>',
  '<script>',
  'var T=new URLSearchParams(location.search).get("t")||"";',
  'try{var ml=document.createElement("link");ml.rel="manifest";',
  'ml.href="manifest.json?t="+encodeURIComponent(T);document.head.appendChild(ml)}catch(x){}',
  'var $=function(i){return document.getElementById(i)};',
  'var heroEl=$("hero"),listEl=$("list"),pillEl=$("pill"),pillT=$("pillT"),toastEl=$("toast"),footEl=$("foot");',
  'var items=[],esOk=false,prevTop="",lastHist=0;',
  'var REDUCE=window.matchMedia&&matchMedia("(prefers-reduced-motion:reduce)").matches;',
  'function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){',
  'return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]})}',
  'function rel(t){var s=Math.floor((Date.now()-new Date(t).getTime())/1000);',
  'if(!isFinite(s))return "";if(s<0)s=0;if(s<3)return "刚刚";if(s<60)return s+" 秒前";',
  'if(s<3600)return Math.floor(s/60)+" 分钟前";if(s<86400)return Math.floor(s/3600)+" 小时前";',
  'return Math.floor(s/86400)+" 天前"}',
  'function hm(t){var d=new Date(t);var p=function(n){return ("0"+n).slice(-2)};',
  'return p(d.getHours())+":"+p(d.getMinutes())+":"+p(d.getSeconds())}',
  // slot-machine seed: one reel per digit, staggered stop
  'function seedHtml(v,anim){if(!v)return "";var s=String(v),neg="";',
  'if(s.charAt(0)==="-"){neg="<span class=\\"neg\\">-</span>";s=s.slice(1)}',
  'if(!/^[0-9]+$/.test(s))return "<span class=\\"txt\\">"+esc(v)+"</span>";',
  'var groups=[],i=s.length;while(i>0){var j=Math.max(0,i-3);groups.unshift(s.slice(j,i));i=j}',
  'var gi=0,digits="0123456789".split("");',
  'return neg+groups.map(function(g){return "<span class=\\"grp\\">"+g.split("").map(function(ch){',
  'var d=+ch,delay=gi++*26,from=-(10*(anim?2:0)+d);',
  'return "<span class=\\"dg\\"><i data-d=\\""+d+"\\" style=\\"transform:translateY("+from+"em);transition-delay:"+delay+"ms\\">"+digits.map(function(x){return "<b>"+x+"</b>"}).join("")',
  '+"</i></span>"}).join("")+"</span>"}).join("")}',
  'function runReels(anim){var rs=heroEl.querySelectorAll(".seed .dg i");if(!rs.length)return;',
  'var set=function(){for(var i=0;i<rs.length;i++){rs[i].style.transform="translateY(-"+rs[i].getAttribute("data-d")+"em)"}};',
  'if(!anim||REDUCE){for(var i=0;i<rs.length;i++){rs[i].style.transition="none"};set();return}',
  'requestAnimationFrame(set)}',
  'function toast(m){toastEl.textContent=m;toastEl.className="toast on";',
  'clearTimeout(toast._t);toast._t=setTimeout(function(){toastEl.className="toast"},1400)}',
  'function legacyCopy(t,done){var a=document.createElement("textarea");a.value=t;',
  'a.setAttribute("readonly","");a.style.position="fixed";a.style.top="-1000px";',
  'document.body.appendChild(a);a.select();a.setSelectionRange(0,t.length);',
  'var ok=false;try{ok=document.execCommand("copy")}catch(e){}',
  'document.body.removeChild(a);if(ok)done();else toast("复制失败，长按选择")}',
  'function copy(t){var done=function(){toast("已复制 "+t)};',
  'if(navigator.clipboard&&window.isSecureContext){',
  'navigator.clipboard.writeText(t).then(done,function(){legacyCopy(t,done)})}',
  'else legacyCopy(t,done)}',
  'function setState(ok,txt){esOk=ok;pillEl.className="pill "+(ok?"ok":"bad");pillT.textContent=txt}',
  'function heroHtml(r,anim){',
  'if(!r)return "<div class=\\"hero empty\\"><svg width=\\"26\\" height=\\"26\\" viewBox=\\"0 0 24 24\\"",',
  '" fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"1.6\\"><path d=\\"M3 12h4l2-7 4 14 2-7h6\\"/></svg>",',
  '"<span>还没有捕获记录</span></div>";',
  'var cls=r.opaque?"seed op":"seed";',
  'return "<div class=\\"hero\\" data-seed=\\""+esc(r.seed)+"\\">"',
  '+"<div class=\\"hname\\">"+esc(r.name)+"</div>"',
  '+"<div class=\\""+cls+"\\">"+seedHtml(r.seed,anim)+"</div>"',
  '+"<div class=\\"hmeta\\"><b>"+esc(r.mode)+"</b><span>"+hm(r.time)+"</span>"',
  '+"<em class=\\"rel\\" data-t=\\""+esc(r.time)+"\\">"+rel(r.time)+"</em></div></div>"}',
  'function rowHtml(r,fresh){return "<div class=\\"row"+(fresh?" fresh":"")+"\\" data-seed=\\""+esc(r.seed)+"\\">"',
  '+"<div class=\\"rn\\">"+esc(r.name)+"</div>"',
  '+"<div class=\\"rt\\"><span class=\\"rel\\" data-t=\\""+esc(r.time)+"\\">"+rel(r.time)+"</span></div>"',
  '+"<div class=\\"rs\\">"+esc(r.seed)+"</div></div>"}',
  'function render(fresh){var top=items.length?items[0].time:"";',
  'var anim=fresh&&top!==prevTop&&items.length>0;',
  'heroEl.innerHTML=heroHtml(items[0],anim);',
  'runReels(anim);prevTop=top;',
  'var rest=items.slice(1,21);',
  'listEl.innerHTML=rest.map(function(r,i){return rowHtml(r,fresh&&i===0)}).join("");',
  'var hn=$("histN");if(hn)hn.textContent=rest.length?rest.length:"";',
  'if(rest.length&&lastHist===0)listEl.classList.add("hide");lastHist=rest.length;',
  'footEl.textContent=items.length?("共 "+items.length+" 条 · 点历史展开"):""}',
  'function tickRel(){var ns=document.querySelectorAll(".rel");',
  'for(var i=0;i<ns.length;i++)ns[i].textContent=rel(ns[i].getAttribute("data-t"))}',
  'function flash(){document.body.classList.remove("flash");',
  'void document.body.offsetWidth;document.body.classList.add("flash")}',
  'document.addEventListener("click",function(e){',
  'var ht=e.target.closest("#histT");',
  'if(ht){listEl.classList.toggle("hide");return}',
  'var el=e.target.closest("[data-seed]");if(!el)return;var s=el.getAttribute("data-seed");',
  'if(s)copy(s)});',
  'function load(){fetch("/api/recent?t="+encodeURIComponent(T)).then(function(r){return r.json()})',
  '.then(function(j){items=j.items||[];render(false);',
  'setState(true,"已同步 "+hm(new Date()))}).catch(function(){setState(false,"离线 · 重试中")})}',
  'load();',
  'try{var es=new EventSource("/events?t="+encodeURIComponent(T));',
  'es.onopen=function(){setState(true,"实时连接")};',
  'es.onmessage=function(e){try{var r=JSON.parse(e.data);items.unshift(r);items=items.slice(0,30);',
  'render(true);flash();if(navigator.vibrate)navigator.vibrate([22,32,22])}catch(x){}};',
  'es.onerror=function(){setState(false,"断线 · 轮询中")}}catch(x){}',
  'setInterval(function(){if(!esOk)load()},5000);',
  'setInterval(tickRel,1000);',
  '</script></body></html>',
].join('\n');

function startPhoneServer(port, token) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const q = u.searchParams.get('t') || '';
    if (token && q !== token) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    if (u.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(PHONE_HTML);
      return;
    }
    if (u.pathname === '/api/recent') {
      const items = recent.slice(-20).reverse();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ items: items }));
      return;
    }
    if (u.pathname === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      res.end(JSON.stringify({
        name: 'MC Seed',
        short_name: 'MCSeed',
        display: 'standalone',
        background_color: '#0b0e12',
        theme_color: '#0b0e12',
        start_url: './?t=' + encodeURIComponent(token),
        icons: [{ src: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxOTIgMTkyIj48cmVjdCB3aWR0aD0iMTkyIiBoZWlnaHQ9IjE5MiIgcng9IjQ0IiBmaWxsPSIjMTAxNTFiIi8+PHBhdGggZD0iTTM0IDEyNGgyMmwxNi01OCAyNiA5OCAyMC03NCAxMiAzNGgyMiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjNWZlMzliIiBzdHJva2Utd2lkdGg9IjExIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48L3N2Zz4=', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      }));
      return;
    }
    if (u.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store', Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) { /* ignore */ } }, 25000);
      req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  server.on('error', (e) => {
    console.error('[mcseed] 手机看板启动失败：' + (e && e.message ? e.message : e));
  });
  server.listen(port, '0.0.0.0', () => {
    const ips = lanAddresses();
    console.log('[mcseed] 手机看板已开启（局域网）：');
    for (const ip of ips) console.log('    http://' + ip + ':' + port + '/?t=' + token);
    if (ips.length === 0) console.log('    http://127.0.0.1:' + port + '/?t=' + token + '  (未发现局域网网卡)');
    console.log('    手机连同一个 WiFi，浏览器打开上面的地址即可；不要把这个端口映射到公网。');
  });
  return server;
}

// ---------- main ----------
const mode = parseMode();

// 防重复 watch：锁文件（避免重复双击导致多个监听）
const LOCK_PATH = path.join(__dirname, 'watch.lock');
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}
if (mode === 'watch') {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const oldPid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8'), 10);
      if (oldPid && isProcessAlive(oldPid)) {
        console.log('[mcseed] watch 已在运行 (PID ' + oldPid + ')，本实例退出');
        process.exit(0);
      }
    }
    fs.writeFileSync(LOCK_PATH, String(process.pid));
    process.on('exit', () => { try { fs.unlinkSync(LOCK_PATH); } catch (e) { /* ignore */ } });
  } catch (e) { /* lock best-effort */ }
}

// 手机看板（可选）：--http <端口> 开启，默认不监听任何端口。
const PHONE_PORT = parseInt(argValue('--http'), 10);
const PHONE_TOKEN = argValue('--http-token') ||
  Math.random().toString(36).slice(2, 8);
if (Number.isFinite(PHONE_PORT) && PHONE_PORT > 0) {
  loadRecentFromLog(20);
  startPhoneServer(PHONE_PORT, PHONE_TOKEN);
}

if (mode === 'watch') watchLoop().catch((e) => friendlyError('监听', e));
else if (mode === 'now') { if (!ensureSavesDir()) process.exit(1); nowMode().catch((e) => friendlyError('获取当前世界', e)); }
else if (mode === 'next') { if (!ensureSavesDir()) process.exit(1); nextMode().catch((e) => friendlyError('等待新世界', e)); }
else if (mode === 'show') showMode();
else console.log('用法: node mcseed-app.js [watch|now|next|show] [--saves <存档目录>] [--log <文件>] [--state <文件>] [--retry <次数>] [--retry-ms <毫秒>] [--no-heap] [--http <端口>] [--http-token <口令>]');

// 把未捕获的异常转成友好中文提示 + 常见原因，避免直接抛英文堆栈。
function friendlyError(action, e) {
  const msg = (e && e.message) ? String(e.message) : String(e);
  console.error('');
  console.error('[' + action + '] 出错了：');
  console.error('  ' + msg);
  console.error('');
  console.error('  可能原因与排查：');
  if (/ENOENT|no such file/i.test(msg)) console.error('  - 找不到文件/目录。请确认游戏已启动、存档目录存在。');
  else if (/EACCES|permission|denied/i.test(msg)) console.error('  - 没有读写权限。请以管理员身份运行 cmd，或检查文件是否被占用。');
  else if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(msg)) console.error('  - 网络连接问题。如果你在用代理，请确认代理软件已开启。');
  else if (/heap|dump|OpenProcess|jps/i.test(msg)) console.error('  - 内存/进程相关。请确认 Minecraft 游戏正在运行，或稍后重试。');
  else console.error('  - 请把上面这段错误信息截图，反馈给作者排查。');
  console.error('');
  if (process.env.DSH_MCSEED_DEBUG === '1') console.error(e && e.stack ? e.stack : e);
}
