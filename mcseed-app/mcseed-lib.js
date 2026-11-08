'use strict';
// mcseed-lib.js — pure-JS gzip + NBT parser for Minecraft level.dat seed extraction.
// Zero dependencies. Works in Node (module.exports) and when inlined into a DSH dynamic plugin.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.mcseedLib = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- inflate (DEFLATE, RFC 1951) ----------
  function inflateRaw(data) {
    const out = [];
    let pos = 0;
    let bitbuf = 0;
    let bitcnt = 0;

    function readBits(n) {
      while (bitcnt < n) {
        if (pos >= data.length) throw new Error('inflate: unexpected end of stream');
        bitbuf |= data[pos++] << bitcnt;
        bitcnt += 8;
      }
      const v = bitbuf & ((1 << n) - 1);
      bitbuf >>>= n;
      bitcnt -= n;
      return v;
    }
    function readBit() { return readBits(1); }
    function align() { bitbuf = 0; bitcnt = 0; }

    function buildTable(lengths) {
      const count = new Array(16).fill(0);
      const pairs = [];
      for (let i = 0; i < lengths.length; i++) {
        const l = lengths[i];
        if (l > 0) { count[l]++; pairs.push([i, l]); }
      }
      pairs.sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
      return { count: count, symbols: pairs.map(function (p) { return p[0]; }) };
    }
    function decode(table) {
      let code = 0, first = 0, idx = 0;
      for (let len = 1; len <= 15; len++) {
        code |= readBit();
        const c = table.count[len];
        if (code - first < c) return table.symbols[idx + (code - first)];
        idx += c;
        first = (first + c) << 1;
        code <<= 1;
      }
      throw new Error('inflate: invalid huffman code');
    }

    const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

    const FIXED_LEN = new Array(288).fill(0);
    for (let i = 0; i <= 143; i++) FIXED_LEN[i] = 8;
    for (let i = 144; i <= 255; i++) FIXED_LEN[i] = 9;
    for (let i = 256; i <= 279; i++) FIXED_LEN[i] = 7;
    for (let i = 280; i <= 287; i++) FIXED_LEN[i] = 8;
    const FIXED_DIST = new Array(32).fill(5);
    const fixedLenTable = buildTable(FIXED_LEN);
    const fixedDistTable = buildTable(FIXED_DIST);

    let final = false;
    while (!final) {
      final = readBit() === 1;
      const type = readBits(2);
      if (type === 0) {
        align();
        if (pos + 4 > data.length) throw new Error('inflate: truncated stored block');
        const len = data[pos] | (data[pos + 1] << 8);
        pos += 4;
        for (let i = 0; i < len; i++) {
          if (pos >= data.length) throw new Error('inflate: truncated stored data');
          out.push(data[pos++]);
        }
      } else if (type === 1 || type === 2) {
        let litTable, distTable;
        if (type === 1) {
          litTable = fixedLenTable;
          distTable = fixedDistTable;
        } else {
          const hlit = readBits(5) + 257;
          const hdist = readBits(5) + 1;
          const hclen = readBits(4) + 4;
          const clLengths = new Array(19).fill(0);
          for (let i = 0; i < hclen; i++) clLengths[CLEN_ORDER[i]] = readBits(3);
          const clTable = buildTable(clLengths);
          const lengths = new Array(hlit + hdist).fill(0);
          let i = 0;
          while (i < hlit + hdist) {
            const sym = decode(clTable);
            if (sym < 16) {
              lengths[i++] = sym;
            } else if (sym === 16) {
              if (i === 0) throw new Error('inflate: bad length repeat');
              const rep = readBits(2) + 3;
              const prev = lengths[i - 1];
              for (let j = 0; j < rep; j++) lengths[i++] = prev;
            } else if (sym === 17) {
              const rep = readBits(3) + 3;
              for (let j = 0; j < rep; j++) lengths[i++] = 0;
            } else {
              const rep = readBits(7) + 11;
              for (let j = 0; j < rep; j++) lengths[i++] = 0;
            }
          }
          litTable = buildTable(lengths.slice(0, hlit));
          distTable = buildTable(lengths.slice(hlit));
        }
        for (;;) {
          const sym = decode(litTable);
          if (sym < 256) {
            out.push(sym);
            continue;
          }
          if (sym === 256) break;
          const li = sym - 257;
          let length = LEN_BASE[li];
          const le = LEN_EXTRA[li];
          if (le > 0) length += readBits(le);
          const dsym = decode(distTable);
          let dist = DIST_BASE[dsym];
          const de = DIST_EXTRA[dsym];
          if (de > 0) dist += readBits(de);
          const start = out.length - dist;
          for (let j = 0; j < length; j++) out.push(out[start + j]);
        }
      } else {
        throw new Error('inflate: invalid block type');
      }
    }
    return new Uint8Array(out);
  }

  // ---------- gzip wrapper ----------
  function gunzip(data) {
    if (data[0] !== 0x1f || data[1] !== 0x8b) throw new Error('gunzip: not a gzip stream');
    if (data[2] !== 8) throw new Error('gunzip: unsupported compression method');
    const flg = data[3];
    let pos = 10;
    if (flg & 4) {
      const xlen = data[pos] | (data[pos + 1] << 8);
      pos += 2 + xlen;
    }
    if (flg & 8) { while (data[pos] !== 0) pos++; pos++; }
    if (flg & 16) { while (data[pos] !== 0) pos++; pos++; }
    if (flg & 2) pos += 2;
    return inflateRaw(data.subarray(pos));
  }

  // ---------- NBT ----------
  function parseNbt(data) {
    const decoder = new TextDecoder('utf-8');
    let pos = 0;
    function readU8() { if (pos >= data.length) throw new Error('nbt: truncated'); return data[pos++]; }
    function readI8() { const v = readU8(); return v << 24 >> 24; }
    function readU16() { const v = (readU8() << 8) | readU8(); return v; }
    function readI16() { const v = readU16(); return v << 16 >> 16; }
    function readI32() { return (readU8() << 24) | (readU8() << 16) | (readU8() << 8) | readU8(); }
    function readI64() { const hi = readI32(); const lo = readI32(); return { hi: hi, lo: lo }; }
    function readF32() {
      if (typeof DataView === 'undefined') throw new Error('nbt: DataView unavailable');
      const buf = new ArrayBuffer(4);
      const dv = new DataView(buf);
      for (let i = 0; i < 4; i++) dv.setUint8(i, readU8());
      return dv.getFloat32(0, false);
    }
    function readF64() {
      if (typeof DataView === 'undefined') throw new Error('nbt: DataView unavailable');
      const buf = new ArrayBuffer(8);
      const dv = new DataView(buf);
      for (let i = 0; i < 8; i++) dv.setUint8(i, readU8());
      return dv.getFloat64(0, false);
    }
    function readString() {
      const len = readU16();
      const bytes = data.subarray(pos, pos + len);
      pos += len;
      return decoder.decode(bytes);
    }
    function parsePayload(type) {
      switch (type) {
        case 1: return readI8();
        case 2: return readI16();
        case 3: return readI32();
        case 4: return readI64();
        case 5: return readF32();
        case 6: return readF64();
        case 7: { const len = readI32(); const arr = data.subarray(pos, pos + len); pos += len; return Array.from(arr); }
        case 8: return readString();
        case 9: {
          const itemType = readU8();
          const len = readI32();
          const arr = [];
          for (let i = 0; i < len; i++) arr.push(parsePayload(itemType));
          return { itemType: itemType, value: arr };
        }
        case 10: return parseCompound();
        case 11: { const len = readI32(); const arr = []; for (let i = 0; i < len; i++) arr.push(readI32()); return arr; }
        case 12: { const len = readI32(); const arr = []; for (let i = 0; i < len; i++) arr.push(readI64()); return arr; }
        default: throw new Error('nbt: unknown tag type ' + type);
      }
    }
    function parseCompound() {
      const obj = {};
      for (;;) {
        const t = readU8();
        if (t === 0) break;
        const name = readString();
        obj[name] = parsePayload(t);
      }
      return obj;
    }
    const rootType = readU8();
    const rootName = readString();
    const value = parsePayload(rootType);
    return { name: rootName, type: rootType, value: value };
  }

  // ---------- seed extraction ----------
  // 1.16+: Data.WorldGenSettings.seed (Long).  Pre-1.16: Data.RandomSeed (Long).
  // 少数整合包会把 seed 换成 TAG_String（十进制或 base64 占位串），也要能识别，
  // 否则解析成功却被当成"没有 seed"，上层只能静默失败。
  function decodeBase64(s) {
    try {
      if (typeof Buffer === 'function' && typeof Buffer.from === 'function') {
        const b = Buffer.from(s, 'base64');
        return b.length > 0 ? b : null;
      }
    } catch (e) { /* fallthrough */ }
    try {
      if (typeof atob === 'function') {
        const bin = atob(s);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr.length > 0 ? arr : null;
      }
    } catch (e) { /* fallthrough */ }
    return null;
  }

  function extractSeed(nbt) {
    const data = nbt && nbt.value && nbt.value.Data;
    if (!data || typeof data !== 'object') return null;

    let raw = null;
    let field = null;
    if (data.WorldGenSettings && typeof data.WorldGenSettings === 'object' &&
        data.WorldGenSettings.seed !== undefined) {
      raw = data.WorldGenSettings.seed;
      field = 'WorldGenSettings.seed';
    } else if (data.RandomSeed !== undefined) {
      raw = data.RandomSeed;
      field = 'RandomSeed';
    }
    if (raw === null || raw === undefined) return null;

    // 常规形态：TAG_Long -> {hi, lo}
    if (typeof raw === 'object' && raw !== null && raw.hi !== undefined) {
      const hasBigInt = typeof BigInt === 'function';
      let dec = null;
      let num = null;
      if (hasBigInt) {
        const full = (BigInt(raw.hi) << 32n) + BigInt(raw.lo >>> 0);
        dec = full.toString();
        if (full >= -9007199254740991n && full <= 9007199254740991n) num = Number(full);
      } else {
        dec = String(raw.lo);
        if (raw.hi === 0) num = raw.lo >>> 0;
      }
      return { hi: raw.hi, lo: raw.lo, dec: dec, num: num, kind: 'long', field: field, opaque: false };
    }

    // 非预期形态：TAG_String。十进制仍可当种子用；base64/其它形态属于不透明占位，
    // 上层据此给出"磁盘上没有真实 seed"的明确提示，而不是把它当作读取失败。
    if (typeof raw === 'string') {
      const s = raw.trim();
      const out = { hi: null, lo: null, dec: s, num: null, kind: 'string', field: field, opaque: true };
      if (/^-?\d+$/.test(s)) {
        out.opaque = false;
        const n = Number(s);
        out.num = Number.isFinite(n) && Math.abs(n) <= 9007199254740991 ? n : null;
      } else {
        const bin = decodeBase64(s);
        if (bin) {
          out.rawLen = bin.length;
          out.rawHex = Array.prototype.map.call(bin, function (x) {
            return ('0' + x.toString(16)).slice(-2);
          }).join('');
        }
      }
      return out;
    }

    return null;
  }

  function extractLevelName(nbt) {
    const data = nbt && nbt.value && nbt.value.Data;
    return data && typeof data.LevelName === 'string' ? data.LevelName : null;
  }

  return {
    inflateRaw: inflateRaw,
    gunzip: gunzip,
    parseNbt: parseNbt,
    extractSeed: extractSeed,
    extractLevelName: extractLevelName,
  };
});
