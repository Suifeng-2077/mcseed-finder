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
const { execFile, execFileSync, spawn } = require('child_process');
const lib = require('./mcseed-lib.js');
const crypto = require('./mcseed-crypto.js');

// ---------- config ----------
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { /* defaults */ }

const BEEP = cfg.beep !== false;
// autoHeap 默认 true：watch 模式遇到加密无密钥世界也自动用 HuntKey 零痕迹内存扫描提取。
// 若想 watch 只读文件（加密世界等保存成明文再抓），在 config.json 设 "autoHeap": false。
const AUTO_HEAP = cfg.autoHeap !== false;
const HEAP_COOLDOWN_MS = cfg.heapCooldownMs || 20000;

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
try {
  const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  for (const k of Object.keys(s)) seen.add(k);
} catch (e) { /* first run */ }
function persistState() {
  try {
    const o = {};
    for (const k of seen) o[k] = { key: k };
    fs.writeFileSync(STATE_PATH, JSON.stringify(o));
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
  const ld = fs.readFileSync(ldPath);
  let nbt = tryParseGzip(ld);
  if (nbt) {
    const seed = lib.extractSeed(nbt);
    if (seed) return { seed: seed.dec, seedNum: seed.num, levelName: lib.extractLevelName(nbt), mode: 'plain' };
  }
  const kf = path.join(dir, 'mcsrfairplay', 'worldDataKey.txt');
  if (fs.existsSync(kf)) {
    try {
      const wk = crypto.unwrapWorldKey(fs.readFileSync(kf));
      const plain = crypto.unwrapLevelDat(ld, wk);
      nbt = tryParseGzip(plain);
      if (nbt) {
        const seed = lib.extractSeed(nbt);
        if (seed) return { seed: seed.dec, seedNum: seed.num, levelName: lib.extractLevelName(nbt), mode: 'enc' };
      }
    } catch (e) { /* wrong key */ }
  }
  return null;
}
function isEncryptedNoKey(dir) {
  const ldPath = path.join(dir, 'level.dat');
  if (!fs.existsSync(ldPath)) return false;
  // 只读前 2 字节判断是否明文，避免读整个文件（level.dat 可能几 MB）
  const fd = fs.openSync(ldPath, 'r');
  try {
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return false; // plaintext gzip
  } finally { fs.closeSync(fd); }
  return !fs.existsSync(path.join(dir, 'mcsrfairplay', 'worldDataKey.txt'));
}
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

// 零痕迹内存提取：进程外 ReadProcessMemory 扫 worldKey 并解密 level.dat（HuntKey.exe）。
// 不注入游戏进程、不写游戏文件 → 游戏日志无痕。通常 1 秒内完成。
function huntSeed(worldDir) {
  try {
    const pid = findMcPid();
    if (!pid) return null;
    if (!fs.existsSync(HUNT_KEY_EXE)) return null;
    const ldPath = path.join(worldDir, 'level.dat');
    if (!fs.existsSync(ldPath)) return null;
    const outGz = path.join(DUMP_DIR, 'hunt-' + Date.now() + '.gzip');
    // HuntKey: 进程外扫 worldKey -> 解密 level.dat -> 明文 gzip 写到 outGz。
    // seed 提取交给本地的 lib（可靠），不依赖 HuntKey 内部输出。
    execFileSync(HUNT_KEY_EXE, [String(pid), ldPath, outGz], { timeout: 600000, stdio: 'ignore', encoding: 'utf8' });
    if (fs.existsSync(outGz) && fs.statSync(outGz).size > 0) {
      const nbt = lib.parseNbt(lib.gunzip(fs.readFileSync(outGz)));
      const seed = lib.extractSeed(nbt);
      if (seed) {
        const levelName = lib.extractLevelName(nbt) || path.basename(worldDir);
        return { seed: seed.dec, seedNum: seed.num, levelName, mode: 'hunt' };
      }
    }
  } catch (e) { /* hunt failed */ }
  return null;
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
  try {
    const huntRes = await huntSeed(worldDir);
    if (huntRes) return huntRes;
    return null;
  } catch (e) { return null; }
  finally {
    try {
      for (const f of fs.readdirSync(DUMP_DIR)) fs.unlinkSync(path.join(DUMP_DIR, f));
    } catch (e) { /* ignore */ }
    heapBusy = false;
  }
}

async function captureOne(dirPath, name, firstScan) {
  let res = readSeedFromDir(dirPath);
  // 自动内存扫描：仅对"新出现的"世界（非首次扫描）触发，首扫历史世界不做内存扫描，
  // 避免对大量历史世界逐个 HuntKey；历史世界等保存后多能走明文/密钥文件。
  if (!res && !firstScan && AUTO_HEAP && isEncryptedNoKey(dirPath) && Date.now() - lastHeapAt > HEAP_COOLDOWN_MS) {
    res = await heapExtract(dirPath);
    if (res) lastHeapAt = Date.now();
  }
  if (!res) return false;
  const wkey = worldKeyForDir(dirPath, name);
  seen.add(wkey);
  persistState();
  const line = [new Date().toISOString(), firstScan ? 'init' : 'new', res.mode, name, res.levelName || '', res.seed].join('\t');
  log(line);
  notifyNewWorld(name, res.seed, !firstScan);
  return true;
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
    try {
      const entries = fs.readdirSync(SAVES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const e of entries) {
        const dirPath = path.join(SAVES_DIR, e.name);
        if (seen.has(worldKeyForDir(dirPath, e.name))) continue;
        captureOne(dirPath, e.name, firstScan);
      }
      firstScan = false;
      // 心跳：每 60 秒打印一次状态，证明程序活着
      if (ticks % 50 === 0) {
        console.log('[' + new Date().toLocaleTimeString() + '] 运行中... 已捕获 ' + seen.size + ' 个世界 (日志: ' + LOG_PATH + ')');
      }
    } catch (e) {
      console.error('[mcseed] watch 错误: ' + e.message);
    } finally {
      scanning = false;
    }
  };
  setInterval(tick, 1200);
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
  console.log('[mcseed] 目标世界: ' + name);
  let res = readSeedFromDir(path.join(SAVES_DIR, name));
  if (!res) {
    console.log('[mcseed] 无密钥文件，进行零痕迹内存扫描提取...');
    res = await heapExtract(path.join(SAVES_DIR, name), true);
  }
  if (res) {
    console.log('[mcseed] seed = ' + res.seed + '  (mode=' + res.mode + ')');
    log([new Date().toISOString(), 'now', res.mode, name, res.levelName || '', res.seed].join('\t'));
    beep();
  } else {
    console.log('[mcseed] 未能获取 seed（游戏可能未运行）');
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
    let res = readSeedFromDir(dir);
    if (!res && isEncryptedNoKey(dir)) res = await heapExtract(dir, true);
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
    if (isEncryptedNoKey(path.join(SAVES_DIR, next))) {
      console.log('  （加密世界，正在零痕迹内存扫描，请稍候...）');
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
      console.log('  未能获取 ' + next + ' 的 seed（密钥可能还没就绪，稍后按 Enter 重试）');
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

// ---------- main ----------
const mode = process.argv[2] || 'watch';

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

if (mode === 'watch') watchLoop().catch((e) => console.error(e));
else if (mode === 'now') { if (!ensureSavesDir()) process.exit(1); nowMode().catch((e) => console.error(e)); }
else if (mode === 'next') { if (!ensureSavesDir()) process.exit(1); nextMode().catch((e) => console.error(e)); }
else if (mode === 'show') showMode();
else console.log('用法: node mcseed-app.js [watch|now|next|show]');
