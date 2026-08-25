'use strict';
// mcseed-crypto.js — pure-JS AES-128/256 + CBC + PKCS7, plus the mcsrfairplay
// level.dat unwrap (fixed key -> world key -> level.dat plaintext).
// Zero dependencies. Verified against .NET Aes output.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.mcseedCrypto = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------- GF(2^8) helpers ----------
  function gfMul(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      const hi = a & 0x80;
      a = (a << 1) & 0xFF;
      if (hi) a ^= 0x1B;
      b >>= 1;
    }
    return p;
  }
  function gfInv(a) {
    if (a === 0) return 0;
    for (let x = 1; x < 256; x++) if (gfMul(a, x) === 1) return x;
    return 0;
  }
  function buildSBox() {
    const sb = new Array(256);
    for (let i = 0; i < 256; i++) {
      const x = gfInv(i);
      let s = 0;
      for (let b = 0; b < 8; b++) {
        const bit = ((x >> b) & 1) ^ ((x >> ((b + 4) % 8)) & 1) ^ ((x >> ((b + 5) % 8)) & 1) ^
                    ((x >> ((b + 6) % 8)) & 1) ^ ((x >> ((b + 7) % 8)) & 1) ^ ((0x63 >> b) & 1);
        s |= bit << b;
      }
      sb[i] = s;
    }
    return sb;
  }
  const SBOX = buildSBox();
  const INV_SBOX = new Array(256);
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;

  // ---------- key expansion ----------
  function expandKey(key) {
    const Nk = key.length / 4;
    const Nr = Nk + 6;
    const w = [];
    for (let i = 0; i < Nk; i++) {
      w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
    }
    const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];
    for (let i = Nk; i < 4 * (Nr + 1); i++) {
      let temp = w[i - 1].slice();
      if (i % Nk === 0) {
        temp = [temp[1], temp[2], temp[3], temp[0]].map((x) => SBOX[x]);
        temp[0] ^= RCON[(i / Nk) - 1];
      } else if (Nk > 6 && i % Nk === 4) {
        temp = temp.map((x) => SBOX[x]);
      }
      w.push([
        w[i - Nk][0] ^ temp[0],
        w[i - Nk][1] ^ temp[1],
        w[i - Nk][2] ^ temp[2],
        w[i - Nk][3] ^ temp[3],
      ]);
    }
    return { Nr, w };
  }

  // ---------- block ops ----------
  function addRoundKey(state, roundKey) {
    for (let i = 0; i < 16; i++) state[i] ^= roundKey[i];
  }
  function subBytes(state) { for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]]; }
  function invSubBytes(state) { for (let i = 0; i < 16; i++) state[i] = INV_SBOX[state[i]]; }
  function shiftRows(state) {
    // state is column-major: state[col*4+row]
    const t = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[c * 4 + r] = state[((c + r) % 4) * 4 + r];
    for (let i = 0; i < 16; i++) state[i] = t[i];
  }
  function invShiftRows(state) {
    const t = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[c * 4 + r] = state[((c - r + 4) % 4) * 4 + r];
    for (let i = 0; i < 16; i++) state[i] = t[i];
  }
  function mixColumns(state) {
    for (let c = 0; c < 4; c++) {
      const i = c * 4;
      const a0 = state[i], a1 = state[i + 1], a2 = state[i + 2], a3 = state[i + 3];
      state[i] = gfMul(a0, 2) ^ gfMul(a1, 3) ^ a2 ^ a3;
      state[i + 1] = a0 ^ gfMul(a1, 2) ^ gfMul(a2, 3) ^ a3;
      state[i + 2] = a0 ^ a1 ^ gfMul(a2, 2) ^ gfMul(a3, 3);
      state[i + 3] = gfMul(a0, 3) ^ a1 ^ a2 ^ gfMul(a3, 2);
    }
  }
  function invMixColumns(state) {
    for (let c = 0; c < 4; c++) {
      const i = c * 4;
      const a0 = state[i], a1 = state[i + 1], a2 = state[i + 2], a3 = state[i + 3];
      state[i] = gfMul(a0, 14) ^ gfMul(a1, 11) ^ gfMul(a2, 13) ^ gfMul(a3, 9);
      state[i + 1] = gfMul(a0, 9) ^ gfMul(a1, 14) ^ gfMul(a2, 11) ^ gfMul(a3, 13);
      state[i + 2] = gfMul(a0, 13) ^ gfMul(a1, 9) ^ gfMul(a2, 14) ^ gfMul(a3, 11);
      state[i + 3] = gfMul(a0, 11) ^ gfMul(a1, 13) ^ gfMul(a2, 9) ^ gfMul(a3, 14);
    }
  }

  function encryptBlock(block, key) {
    const { Nr, w } = expandKey(key);
    const state = block.slice();
    const roundKey = (r) => {
      const rk = new Array(16);
      for (let c = 0; c < 4; c++) for (let i = 0; i < 4; i++) rk[c * 4 + i] = w[r * 4 + c][i];
      return rk;
    };
    addRoundKey(state, roundKey(0));
    for (let r = 1; r < Nr; r++) {
      subBytes(state); shiftRows(state); mixColumns(state); addRoundKey(state, roundKey(r));
    }
    subBytes(state); shiftRows(state); addRoundKey(state, roundKey(Nr));
    return state;
  }
  function decryptBlock(block, key) {
    const { Nr, w } = expandKey(key);
    const state = block.slice();
    const roundKey = (r) => {
      const rk = new Array(16);
      for (let c = 0; c < 4; c++) for (let i = 0; i < 4; i++) rk[c * 4 + i] = w[r * 4 + c][i];
      return rk;
    };
    addRoundKey(state, roundKey(Nr));
    for (let r = Nr - 1; r >= 1; r--) {
      invShiftRows(state); invSubBytes(state); addRoundKey(state, roundKey(r)); invMixColumns(state);
    }
    invShiftRows(state); invSubBytes(state); addRoundKey(state, roundKey(0));
    return state;
  }

  // ---------- CBC + PKCS7 ----------
  function pkcs7Pad(data) {
    const padLen = 16 - (data.length % 16);
    const out = new Uint8Array(data.length + padLen);
    out.set(data);
    for (let i = data.length; i < out.length; i++) out[i] = padLen;
    return out;
  }
  function pkcs7Unpad(data) {
    if (data.length === 0 || data.length % 16 !== 0) throw new Error('cbc: bad length');
    const padLen = data[data.length - 1];
    if (padLen < 1 || padLen > 16) throw new Error('cbc: bad padding');
    for (let i = data.length - padLen; i < data.length; i++) {
      if (data[i] !== padLen) throw new Error('cbc: invalid padding');
    }
    return data.subarray(0, data.length - padLen);
  }

  function aesCbcEncrypt(plain, key, iv) {
    const padded = pkcs7Pad(plain);
    const out = new Uint8Array(padded.length);
    let prev = iv.slice();
    for (let off = 0; off < padded.length; off += 16) {
      const block = new Array(16);
      for (let i = 0; i < 16; i++) block[i] = padded[off + i] ^ prev[i];
      const enc = encryptBlock(block, key);
      out.set(enc, off);
      prev = enc;
    }
    return out;
  }
  function aesCbcDecrypt(ct, key, iv) {
    if (ct.length % 16 !== 0) throw new Error('cbc: ciphertext length not multiple of 16');
    const out = new Uint8Array(ct.length);
    let prev = iv.slice();
    for (let off = 0; off < ct.length; off += 16) {
      const block = Array.from(ct.subarray(off, off + 16));
      const dec = decryptBlock(block, key);
      for (let i = 0; i < 16; i++) out[off + i] = dec[i] ^ prev[i];
      prev = block;
    }
    return pkcs7Unpad(out);
  }

  // ---------- mcsrfairplay unwrap ----------
  // Fixed key extracted from the mod's static field (exersolver.mcsrfairplay.IllIlIl.IllIlIl).
  const MCSR_FIXED_KEY = (function () {
    const h = '80ed655cd0402548247881b6e6ce7b54ef36377e6ab77175f5e202aced2a20cc';
    const b = new Uint8Array(32);
    for (let i = 0; i < 32; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
    return b;
  })();

  // unwrap: worldDataKey.txt = [16B IV][AES-CBC(fixedKey, PKCS7(worldKey32))]
  function unwrapWorldKey(worldDataKeyBytes) {
    const iv = worldDataKeyBytes.subarray(0, 16);
    const ct = worldDataKeyBytes.subarray(16);
    return aesCbcDecrypt(ct, MCSR_FIXED_KEY, iv);
  }

  // level.dat = [16B IV][AES-CBC(worldKey, PKCS7(gzip NBT))]
  function unwrapLevelDat(levelDatBytes, worldKey) {
    const iv = levelDatBytes.subarray(0, 16);
    const ct = levelDatBytes.subarray(16);
    return aesCbcDecrypt(ct, worldKey, iv);
  }

  return {
    aesCbcEncrypt,
    aesCbcDecrypt,
    MCSR_FIXED_KEY,
    unwrapWorldKey,
    unwrapLevelDat,
  };
});
