'use strict';
// mcseed-qr.js — 极简 QR 码生成器，只为把局域网 URL 画在终端里。
// 固定规格：byte mode、版本 3（29×29）、纠错等级 L、单 RS 块（55 数据码字 + 15 纠错码字）。
// 够放下 http://192.168.x.x:8790/?t=xxxxxx 这种 40~53 字符的地址；超长则返回 null 由调用方降级。
//
// 为什么不自带完整实现：通用 QR 库需要版本表 × 纠错等级 × 多块交织，几百行且容易记错参数。
// 这里只锁一个版本一个纠错等级，参数是固定的，可验证性最高。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.mcseedQr = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 3;
  const SIZE = 17 + 4 * VERSION;      // 29
  const ECL_L_FORMAT_BITS = 1;        // L = 01
  const DATA_CODEWORDS = 55;          // v3-L
  const EC_CODEWORDS = 15;            // v3-L

  // ---- GF(256), primitive polynomial 0x11D ----
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function buildTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, degree) {
    const gen = rsGenerator(degree);
    const res = new Uint8Array(data.length + degree);
    res.set(data);
    for (let i = 0; i < data.length; i++) {
      const factor = res[i];
      if (factor === 0) continue;
      for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
    }
    return res.slice(data.length);
  }

  // ---- 数据编码：byte mode ----
  function encodeData(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c > 0x7f) return null; // 只处理 ASCII（URL 都是 ASCII）
      bytes.push(c);
    }
    const capacityBits = DATA_CODEWORDS * 8;
    const neededBits = 4 + 8 + bytes.length * 8; // mode(4) + length(8, v1-9) + data
    if (neededBits > capacityBits) return null;

    const bits = [];
    const push = (value, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
    };
    push(0b0100, 4);            // byte mode
    push(bytes.length, 8);      // 长度（v1-9 用 8 bit）
    for (const b of bytes) push(b, 8);
    // terminator
    const term = Math.min(4, capacityBits - bits.length);
    push(0, term);
    while (bits.length % 8 !== 0) bits.push(0);
    // pad codewords
    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      out.push(v);
    }
    const PAD = [0xec, 0x11];
    let k = 0;
    while (out.length < DATA_CODEWORDS) {
      out.push(PAD[k % 2]);
      k++;
    }
    return Uint8Array.from(out);
  }

  // ---- 矩阵构建 ----
  function makeMatrix() {
    const m = [];
    const fn = []; // 是否为功能模块（不参与数据放置）
    for (let y = 0; y < SIZE; y++) {
      m.push(new Array(SIZE).fill(0));
      fn.push(new Array(SIZE).fill(false));
    }
    const set = (x, y, v) => { m[y][x] = v; fn[y][x] = true; };

    function finder(cx, cy) {
      for (let dy = -1; dy <= 7; dy++) {
        for (let dx = -1; dx <= 7; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
          const inRing = (dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6) &&
            (dx === 0 || dx === 6 || dy === 0 || dy === 6);
          const inCore = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
          set(x, y, inRing || inCore ? 1 : 0);
        }
      }
    }
    finder(0, 0);
    finder(SIZE - 7, 0);
    finder(0, SIZE - 7);

    // timing patterns
    for (let i = 8; i < SIZE - 8; i++) {
      set(i, 6, i % 2 === 0 ? 1 : 0);
      set(6, i, i % 2 === 0 ? 1 : 0);
    }

    // alignment pattern（v3 中心 22,22）
    const ac = 22;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const edge = Math.max(Math.abs(dx), Math.abs(dy));
        set(ac + dx, ac + dy, edge === 1 ? 0 : 1);
      }
    }

    // dark module
    set(8, SIZE - 8, 1);

    // 预留 format info 区域
    for (let i = 0; i <= 8; i++) {
      if (!fn[8][i]) set(i, 8, 0);
      if (!fn[i][8]) set(8, i, 0);
    }
    for (let i = 0; i < 8; i++) {
      set(SIZE - 1 - i, 8, 0);
      set(8, SIZE - 1 - i, 0);
    }
    return { m, fn, set };
  }

  function placeData(m, fn, codewords) {
    const bits = [];
    for (const cw of codewords) {
      for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
    }
    let idx = 0;
    let upward = true;
    for (let right = SIZE - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // 跳过 timing 列
      for (let vert = 0; vert < SIZE; vert++) {
        const y = upward ? SIZE - 1 - vert : vert;
        for (let k = 0; k < 2; k++) {
          const x = right - k;
          if (fn[y][x]) continue;
          m[y][x] = idx < bits.length ? bits[idx] : 0;
          idx++;
        }
      }
      upward = !upward;
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  function applyMask(m, fn, id) {
    const test = MASKS[id];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (!fn[y][x] && test(x, y)) m[y][x] ^= 1;
      }
    }
  }

  // format info: 5 bits (EC level + mask) + BCH(15,5) + xor 0x5412
  function formatBits(mask) {
    let data = (ECL_L_FORMAT_BITS << 3) | mask;
    let bch = data << 10;
    for (let i = 14; i >= 10; i--) {
      if ((bch >> i) & 1) bch ^= 0x537 << (i - 10);
    }
    return ((data << 10) | bch) ^ 0x5412;
  }

  function drawFormat(m, set, mask) {
    const f = formatBits(mask);
    for (let i = 0; i < 15; i++) {
      const bit = (f >> i) & 1;
      // 左上
      if (i < 6) set(8, i, bit);
      else if (i < 8) set(8, i + 1, bit);
      else if (i === 8) set(7, 8, bit);
      else set(14 - i, 8, bit);
      // 右上 / 左下
      if (i < 8) set(SIZE - 1 - i, 8, bit);
      else set(8, SIZE - 15 + i, bit);
    }
    set(8, SIZE - 8, 1); // dark module 始终为 1
  }

  function penalty(m) {
    let score = 0;
    // 规则 1：连续同色
    for (let y = 0; y < SIZE; y++) {
      let run = 1;
      for (let x = 1; x < SIZE; x++) {
        if (m[y][x] === m[y][x - 1]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
    for (let x = 0; x < SIZE; x++) {
      let run = 1;
      for (let y = 1; y < SIZE; y++) {
        if (m[y][x] === m[y - 1][x]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
    // 规则 2：2x2 同色块
    for (let y = 0; y < SIZE - 1; y++) {
      for (let x = 0; x < SIZE - 1; x++) {
        const v = m[y][x];
        if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
      }
    }
    // 规则 3：类 finder 图案
    const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const lineHit = (get) => {
      for (let i = 0; i + 11 <= SIZE; i++) {
        let a = true, b = true;
        for (let j = 0; j < 11; j++) {
          const v = get(i + j);
          if (v !== pat1[j]) a = false;
          if (v !== pat2[j]) b = false;
        }
        if (a) score += 40;
        if (b) score += 40;
      }
    };
    for (let y = 0; y < SIZE; y++) lineHit((i) => m[y][i]);
    for (let x = 0; x < SIZE; x++) lineHit((i) => m[i][x]);
    // 规则 4：黑白比例
    let dark = 0;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) dark += m[y][x];
    const ratio = (dark * 100) / (SIZE * SIZE);
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return score;
  }

  function build(text) {
    const data = encodeData(text);
    if (!data) return null;
    const ec = rsEncode(data, EC_CODEWORDS);
    const all = new Uint8Array(data.length + ec.length);
    all.set(data);
    all.set(ec, data.length);

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const { m, fn, set } = makeMatrix();
      placeData(m, fn, all);
      applyMask(m, fn, mask);
      drawFormat(m, set, mask);
      const score = penalty(m);
      if (!best || score < best.score) best = { score, m };
    }
    return best.m;
  }

  // 终端渲染：每个字符上下两个模块，带 4 模块静区
  function toTerminal(text, opts) {
    const m = build(text);
    if (!m) return null;
    const quiet = 2; // 以「字符行」计，上下各 2 行 = 4 模块
    const lines = [];
    const blank = '  '.repeat(SIZE + quiet * 2);
    for (let i = 0; i < quiet; i++) lines.push(blank);
    for (let y = 0; y < SIZE; y += 2) {
      let line = '  '.repeat(quiet);
      for (let x = 0; x < SIZE; x++) {
        const top = m[y][x] === 1;
        const bottom = (y + 1 < SIZE) ? m[y + 1][x] === 1 : false;
        let ch;
        if (top && bottom) ch = '█';
        else if (top && !bottom) ch = '▀';
        else if (!top && bottom) ch = '▄';
        else ch = ' ';
        line += ch + ch; // 宽度加倍，抵消终端字符高宽比
      }
      line += '  '.repeat(quiet);
      lines.push(line);
    }
    for (let i = 0; i < quiet; i++) lines.push(blank);
    return lines.join('\n');
  }

  return { build, toTerminal, SIZE, VERSION, maxChars: DATA_CODEWORDS - 2 - 3 };
});
