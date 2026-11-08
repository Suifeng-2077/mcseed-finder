'use strict';
// mcseed-finder 测试：手写 AES 与 inflate 的正确性靠对拍保证，改 SBOX/huffman 必须有保护。
//   node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const nodeCrypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const APP_DIR = path.join(__dirname, '..', 'mcseed-app');
const lib = require(path.join(APP_DIR, 'mcseed-lib.js'));
const mcCrypto = require(path.join(APP_DIR, 'mcseed-crypto.js'));

// ---------- AES ----------
test('AES-256-CBC 命中 NIST SP800-38A F.2.5 向量', () => {
  const key = Buffer.from('603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4', 'hex');
  const iv = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const pt = Buffer.from(
    '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51' +
    '30c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710', 'hex');
  const expect = 'f58c4c04d6e5f1ba779eabfb5f7bfbd69cfc4e967edb808d679f777bc6702c7d' +
    '39f23369a9d9bacfa530e26304231461b2eb05e2c39be9fcda6c19078c6a9d1b';
  const got = Buffer.from(mcCrypto.aesCbcEncrypt(pt, key, iv)).toString('hex');
  // 实现会自动 PKCS7 补整块，所以只比较前 64 字节
  assert.strictEqual(got.slice(0, expect.length), expect);
});

test('AES 与 node:crypto 对拍（加解密各 100 组）', () => {
  for (let i = 0; i < 100; i++) {
    const key = nodeCrypto.randomBytes(32);
    const iv = nodeCrypto.randomBytes(16);
    const data = nodeCrypto.randomBytes(1 + Math.floor(Math.random() * 300));
    const mine = Buffer.from(mcCrypto.aesCbcEncrypt(data, key, iv));
    const c = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
    const ref = Buffer.concat([c.update(data), c.final()]);
    assert.strictEqual(Buffer.compare(mine, ref), 0, 'ciphertext mismatch at #' + i);
    assert.strictEqual(Buffer.compare(Buffer.from(mcCrypto.aesCbcDecrypt(mine, key, iv)), data), 0);
  }
});

test('PKCS7 非法填充会被拒绝', () => {
  const key = nodeCrypto.randomBytes(32);
  const iv = nodeCrypto.randomBytes(16);
  const bad = nodeCrypto.randomBytes(32); // 末字节几乎不可能构成合法填充
  assert.throws(() => mcCrypto.aesCbcDecrypt(bad, key, iv));
});

// ---------- inflate / gunzip ----------
test('inflateRaw 与 zlib.deflateRawSync 对拍', () => {
  const cases = {
    empty: Buffer.alloc(0),
    one: Buffer.from([65]),
    zeros: Buffer.alloc(200000, 0),
    text: Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(4000)),
    random: nodeCrypto.randomBytes(150000),
    periodic: Buffer.from('abcdefghij'.repeat(15000)),
  };
  for (const name of Object.keys(cases)) {
    const raw = cases[name];
    const mine = Buffer.from(lib.inflateRaw(zlib.deflateRawSync(raw)));
    assert.strictEqual(mine.length, raw.length, name + ': length');
    assert.strictEqual(Buffer.compare(mine, raw), 0, name + ': content');
  }
});

test('gunzip 处理 stored 块与 gzip 头字段', () => {
  const raw = Buffer.from('hello level.dat '.repeat(500));
  const gz = zlib.gzipSync(raw); // zlib 会带 FNAME/FCOMMENT 等标志的组合视输入而定
  assert.strictEqual(Buffer.compare(Buffer.from(lib.gunzip(gz)), raw), 0);
});

// ---------- NBT ----------
function nbtString(str) {
  const b = Buffer.from(str, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}
function tagCompound(name, body) {
  return Buffer.concat([Buffer.from([10]), nbtString(name), body, Buffer.from([0])]);
}
function tagLong(name, hi, lo) {
  const b = Buffer.alloc(8);
  b.writeInt32BE(hi, 0);
  b.writeUInt32BE(lo >>> 0, 4);
  return Buffer.concat([Buffer.from([4]), nbtString(name), b]);
}
function tagString(name, value) {
  return Buffer.concat([Buffer.from([8]), nbtString(name), nbtString(value)]);
}
function buildLevelDat(seed, levelName) {
  const hi = Number((BigInt(seed) >> 32n) & 0xffffffffn) | 0;
  const lo = Number(BigInt(seed) & 0xffffffffn);
  const wgs = tagCompound('WorldGenSettings', tagLong('seed', hi, lo));
  const data = tagCompound('Data', Buffer.concat([wgs, tagString('LevelName', levelName)]));
  return zlib.gzipSync(tagCompound('', data));
}

test('NBT 解析 + extractSeed（Long，正数与负数）', () => {
  for (const seed of ['0', '12345', '-690133972988147449', '3741797971081683963']) {
    const nbt = lib.parseNbt(lib.gunzip(buildLevelDat(BigInt(seed), 'w')));
    const got = lib.extractSeed(nbt);
    assert.strictEqual(got.dec, seed);
    assert.strictEqual(got.kind, 'long');
    assert.strictEqual(got.opaque, false);
    assert.strictEqual(lib.extractLevelName(nbt), 'w');
  }
});

test('extractSeed 识别字符串形态：十进制可用、base64 标记为不透明', () => {
  const dec = { WorldGenSettings: { seed: '-42' } };
  const a = lib.extractSeed({ value: { Data: dec } });
  assert.strictEqual(a.dec, '-42');
  assert.strictEqual(a.num, -42);
  assert.strictEqual(a.opaque, false);

  const ph = { WorldGenSettings: { seed: '727BhaZXzEGzHdjyAMY1IDYu0ozo0yOBDjI1c2FUdCc=' } };
  const b = lib.extractSeed({ value: { Data: ph } });
  assert.strictEqual(b.kind, 'string');
  assert.strictEqual(b.opaque, true);
  assert.strictEqual(b.rawLen, 32);
});

test('extractSeed 对缺失 seed 字段返回 null', () => {
  assert.strictEqual(lib.extractSeed({ value: { Data: {} } }), null);
  assert.strictEqual(lib.extractSeed(null), null);
});

// ---------- 端到端：造一个 fairplay 加密世界，让 CLI 自己读 ----------
test('CLI 端到端：加密存档 -> now 模式拿到正确 seed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcseed-test-'));
  const saves = path.join(tmp, 'saves');
  const worldDir = path.join(saves, 'TestWorld');
  fs.mkdirSync(path.join(worldDir, 'mcsrfairplay'), { recursive: true });

  const seed = '-690133972988147449';
  const plain = buildLevelDat(BigInt(seed), 'TestWorld');
  const worldKey = nodeCrypto.randomBytes(32);
  const iv1 = nodeCrypto.randomBytes(16);
  const levelDat = Buffer.concat([iv1, Buffer.from(mcCrypto.aesCbcEncrypt(plain, worldKey, iv1))]);
  fs.writeFileSync(path.join(worldDir, 'level.dat'), levelDat);

  const iv2 = nodeCrypto.randomBytes(16);
  const keyFile = Buffer.concat([iv2, Buffer.from(mcCrypto.aesCbcEncrypt(worldKey, mcCrypto.MCSR_FIXED_KEY, iv2))]);
  fs.writeFileSync(path.join(worldDir, 'mcsrfairplay', 'worldDataKey.txt'), keyFile);

  const out = execFileSync(process.execPath, [
    path.join(APP_DIR, 'mcseed-app.js'), 'now',
    '--saves', saves,
    '--log', path.join(tmp, 'seeds.log'),
    '--state', path.join(tmp, 'state.txt'),
    '--no-heap',
  ], { encoding: 'utf8', timeout: 60000 });

  assert.match(out, new RegExp('seed = ' + seed.replace('-', '\\-')));
  assert.match(out, /mode=enc/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('CLI 端到端：--saves 后面的路径不会被当成模式', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcseed-test2-'));
  const saves = path.join(tmp, 'saves');
  fs.mkdirSync(saves, { recursive: true });
  const out = execFileSync(process.execPath, [
    path.join(APP_DIR, 'mcseed-app.js'), '--saves', saves, 'show',
    '--log', path.join(tmp, 'seeds.log'), '--state', path.join(tmp, 'state.txt'),
  ], { encoding: 'utf8', timeout: 60000 });
  assert.match(out, /暂无记录/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- 手机看板 ----------
const { spawn } = require('node:child_process');

test('手机看板：token 鉴权 + 返回捕获记录', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcseed-http-'));
  const saves = path.join(tmp, 'saves');
  fs.mkdirSync(path.join(saves, 'W'), { recursive: true });
  fs.writeFileSync(path.join(saves, 'W', 'level.dat'), buildLevelDat(123456789n, 'W'));

  const port = 18000 + Math.floor(Math.random() * 3000);
  const child = spawn(process.execPath, [
    path.join(APP_DIR, 'mcseed-app.js'), 'watch',
    '--saves', saves, '--log', path.join(tmp, 'l.log'), '--state', path.join(tmp, 's.txt'),
    '--no-heap', '--http', String(port), '--http-token', 'tk',
  ], { stdio: 'ignore', windowsHide: true });

  try {
    let items = null;
    for (let i = 0; i < 20 && items === null; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/api/recent?t=tk');
        const j = await r.json();
        if (j.items && j.items.length > 0) items = j.items;
      } catch (e) { /* 还没起来 */ }
    }
    assert.ok(items && items.length > 0, '应至少返回一条捕获记录');
    assert.strictEqual(items[0].seed, '123456789');

    const bad = await fetch('http://127.0.0.1:' + port + '/api/recent');
    assert.strictEqual(bad.status, 403, '缺少 token 时应拒绝');

    const page = await fetch('http://127.0.0.1:' + port + '/?t=tk');
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /EventSource/);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
