using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

// Hunt2: locate the mcsrfairplay world key for a live world.
// Improvements over the original HuntKey:
//   1. klass pointer is discovered from the master key's own object header
//      instead of being hardcoded (0xC0220000 only matches one JVM layout);
//   2. memory is read in 64KB chunks with 4KB fallback, so regions that fail
//      large reads are still scanned (original skipped whole 2MB spans);
//   3. no "printable bytes" rejection: ~45% of random 32-byte keys contain
//      more than 12 printable bytes and were silently discarded before;
//   4. fast path: find the world UUID, then only try keys near it.
class Hunt2
{
    public static readonly byte[] MASTER = new byte[]{
        0x80,0xED,0x65,0x5C,0xD0,0x40,0x25,0x48,
        0x24,0x78,0x81,0xB6,0xE6,0xCE,0x7B,0x54,
        0xEF,0x36,0x37,0x7E,0x6A,0xB7,0x71,0x75,
        0xF5,0xE2,0x02,0xAC,0xED,0x2A,0x20,0xCC };

    const uint VM_READ = 0x0010, VM_QUERY = 0x0400;
    const int CHUNK = 0x100000;   // 1MB first, fall back to 64KB then 4KB
    const int CHUNK_MID = 0x10000;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int read);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool VirtualQueryEx(IntPtr h, IntPtr addr, out MBI info, int len);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    struct MBI
    {
        public IntPtr Base;
        public IntPtr Alloc;
        public uint AllocProtect;
        public IntPtr Size;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    static bool Readable(MBI m)
    {
        if (m.State != 0x1000) return false;
        uint p = m.Protect & 0xFF;
        if (!(p == 0x02 || p == 0x04 || p == 0x06 || p == 0x08 || p == 0x20 ||
              p == 0x40 || p == 0x80)) return false;
        // JVM heap is MEM_PRIVATE (mmap MAP_PRIVATE|ANON). Skipping MEM_IMAGE (DLLs)
        // and MEM_MAPPED (shared) cuts a big slice of the address space.
        if (Program.PrivateOnly && m.Type != 0x20000) return false;
        return true;
    }

    public static byte[] ReadMem(IntPtr h, long addr, int size)
    {
        if (size <= 0) return null;
        byte[] b = new byte[size];
        int r;
        if (!ReadProcessMemory(h, (IntPtr)addr, b, size, out r) || r <= 0) return null;
        if (r == size) return b;
        byte[] a = new byte[r];
        Array.Copy(b, a, r);
        return a;
    }

    // KMP
    static void Find(byte[] hay, byte[] pat, long baseAddr, List<long> hits)
    {
        if (pat.Length == 0 || hay.Length < pat.Length) return;
        int[] pref = new int[pat.Length];
        for (int i = 1, j = 0; i < pat.Length; i++)
        {
            while (j > 0 && pat[i] != pat[j]) j = pref[j - 1];
            if (pat[i] == pat[j]) j++;
            pref[i] = j;
        }
        for (int i = 0, j = 0; i < hay.Length; i++)
        {
            while (j > 0 && hay[i] != pat[j]) j = pref[j - 1];
            if (hay[i] == pat[j]) j++;
            if (j == pat.Length) { hits.Add(baseAddr + i - pat.Length + 1); j = pref[j - 1]; }
        }
    }

    static IEnumerable<long[]> Regions(IntPtr h)
    {
        long addr = 0;
        while (addr < long.MaxValue)
        {
            MBI m;
            if (!VirtualQueryEx(h, (IntPtr)addr, out m, Marshal.SizeOf(typeof(MBI)))) break;
            long baseA = (long)m.Base, size = (long)m.Size;
            if (size <= 0) break;
            if (Readable(m)) yield return new long[] { baseA, size };
            long next = baseA + size;
            if (next <= addr) break;
            addr = next;
        }
    }

    // read 1MB first (fewer syscalls), then 64KB, then 4KB per failed span
    static void ScanRegion(IntPtr h, long baseA, long size, byte[] klass, byte[] iv, byte[] ct,
                           ConcurrentDictionary<string,byte> seen, ref long tried, ref long readTotal)
    {
        for (long off = 0; off < size && !Program.Found; off += CHUNK)
        {
            int want = (int)Math.Min(CHUNK, size - off);
            byte[] buf = ReadMem(h, baseA + off, want);
            if (buf != null)
            {
                readTotal += buf.Length;
                ScanBuffer(buf, baseA + off, klass, iv, ct, seen, ref tried);
                continue;
            }
            // large read failed: retry this span in 64KB pieces
            for (long mid = 0; mid < want && !Program.Found; mid += CHUNK_MID)
            {
                int wm = (int)Math.Min(CHUNK_MID, want - mid);
                byte[] bm = ReadMem(h, baseA + off + mid, wm);
                if (bm != null)
                {
                    readTotal += bm.Length;
                    ScanBuffer(bm, baseA + off + mid, klass, iv, ct, seen, ref tried);
                    continue;
                }
                if (wm <= 0x1000) continue;
                for (int sub = 0; sub < wm && !Program.Found; sub += 0x1000)
                {
                    int w2 = Math.Min(0x1000, wm - sub);
                    byte[] b2 = ReadMem(h, baseA + off + mid + sub, w2);
                    if (b2 == null) continue;
                    readTotal += b2.Length;
                    ScanBuffer(b2, baseA + off + mid + sub, klass, iv, ct, seen, ref tried);
                }
            }
        }
    }

    static void ScanBuffer(byte[] buf, long baseAddr, byte[] klass, byte[] iv, byte[] ct,
                           ConcurrentDictionary<string,byte> seen, ref long tried)
    {
        int n = buf.Length;
        for (int i = 0; i + 48 <= n; i++)
        {
            if (buf[i + 8] != klass[0] || buf[i + 9] != klass[1] ||
                buf[i + 10] != klass[2] || buf[i + 11] != klass[3]) continue;
            if (buf[i + 12] != 0x20 || buf[i + 13] != 0 || buf[i + 14] != 0 || buf[i + 15] != 0) continue;

            byte[] key = new byte[32];
            Array.Copy(buf, i + 16, key, 0, 32);
            TryKey(key, iv, ct, seen, ref tried);
        }
    }

    static void TryKey(byte[] key, byte[] iv, byte[] ct, ConcurrentDictionary<string,byte> seen, ref long tried)
    {
        string sig = BitConverter.ToString(key, 0, 8);
        if (!seen.TryAdd(sig, 0)) return;

        bool allZero = true, allSame = true;
        for (int i = 0; i < 32; i++)
        {
            if (key[i] != 0) allZero = false;
            if (key[i] != key[0]) allSame = false;
        }
        if (allZero || allSame) return;
        if (Eq(key, MASTER)) return;

        Interlocked.Increment(ref tried);
        try
        {
            using (var aes = Aes.Create())
            {
                aes.Key = key;
                aes.IV = iv;
                aes.Mode = CipherMode.CBC;
                aes.Padding = PaddingMode.PKCS7;
                using (var dec = aes.CreateDecryptor())
                {
                    byte[] plain = dec.TransformFinalBlock(ct, 0, ct.Length);
                    if (plain.Length > 4 && plain[0] == 0x1F && plain[1] == 0x8B)
                    {
                        Console.WriteLine(">>> HIT");
                        Console.WriteLine("KEY: " + BitConverter.ToString(key).Replace("-", ""));
                        File.WriteAllBytes(Program.OutPath, plain);
                        Program.Found = true;
                    }
                }
            }
        }
        catch { }
    }

    static bool Eq(byte[] a, byte[] b)
    {
        if (a.Length != b.Length) return false;
        for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
        return true;
    }

    static int Main(string[] args)
    {
        if (args.Length < 3)
        {
            Console.WriteLine("usage: Hunt2.exe <pid> <level.dat> <worldUUID.txt> [out.gzip] [--uuid-only]");
            return 2;
        }
        Program.Pid = int.Parse(args[0]);
        Program.LevelDat = args[1];
        Program.UuidPath = args[2];
        Program.OutPath = args.Length > 3 && !args[3].StartsWith("--") ? args[3] : "hunt-out.gzip";
        bool uuidOnly = Array.IndexOf(args, "--uuid-only") >= 0;
        if (Array.IndexOf(args, "--all-mem") >= 0) Program.PrivateOnly = false;

        byte[] ldFile = File.ReadAllBytes(Program.LevelDat);
        byte[] iv = new byte[16];
        Array.Copy(ldFile, 0, iv, 0, 16);
        int ctLen = ldFile.Length - 16;
        if (ctLen % 16 != 0) ctLen -= ctLen % 16;
        byte[] ct = new byte[ctLen];
        Array.Copy(ldFile, 16, ct, 0, ctLen);
        Console.WriteLine("level.dat=" + ldFile.Length + "B ct=" + ctLen + "B");

        byte[] uuid = File.ReadAllBytes(Program.UuidPath);
        Console.WriteLine("worldUUID=" + BitConverter.ToString(uuid).Replace("-", "").ToLower());

        IntPtr h = OpenProcess(VM_READ | VM_QUERY, false, Program.Pid);
        if (h == IntPtr.Zero) { Console.WriteLine("OpenProcess failed: " + Marshal.GetLastWin32Error()); return 1; }

        try
        {
            // stage 1: find the master key to learn the real klass pointer.
            // The master-key address stays put for the whole JVM lifetime, so cache it
            // per pid and skip this whole pass on the next run.
            Console.WriteLine("[1] locating master key...");
            long masterAddr = -1;
            byte[] cachedKlass = null;
            if (Program.TryCache(h, Program.Pid, out masterAddr, out cachedKlass))
            {
                Console.WriteLine("    cached @0x" + masterAddr.ToString("X") + " (verified)");
            }
            else
            {
                var hits = new List<long>();
                foreach (var r in Regions(h))
                {
                    for (long off = 0; off < r[1]; off += CHUNK)
                    {
                        int want = (int)Math.Min(CHUNK, r[1] - off);
                        byte[] buf = ReadMem(h, r[0] + off, want);
                        if (buf == null) continue;
                        hits.Clear();
                        Find(buf, MASTER, r[0] + off, hits);
                        if (hits.Count > 0) { masterAddr = hits[0]; break; }
                    }
                    if (masterAddr >= 0) break;
                }
                if (masterAddr < 0) { Console.WriteLine("master key not found"); return 1; }
            }

            byte[] hdr = ReadMem(h, masterAddr - 16, 16);
            if (hdr == null) { Console.WriteLine("cannot read header"); return 1; }
            byte[] klass = new byte[] { hdr[8], hdr[9], hdr[10], hdr[11] };
            Console.WriteLine("    master @0x" + masterAddr.ToString("X") +
                              "  klass=" + BitConverter.ToString(klass));
            if (hdr[12] != 0x20) Console.WriteLine("    warn: header len byte != 0x20 (" + hdr[12].ToString("x2") + ")");
            Program.SaveCache(Program.Pid, masterAddr, klass, 0);
            var seen = new ConcurrentDictionary<string, byte>();
            long tried = 0;
            long readTotal = 0;

            // stage 2: optional fast path around the world UUID (measured: UUID is not
            // resident in memory for a live world, so this is skipped by default)
            if (Array.IndexOf(args, "--uuid-first") >= 0)
            {
                Console.WriteLine("[2] world UUID fast path...");
                var uuidHits = new List<long>();
                foreach (var r in Regions(h))
                {
                    for (long off = 0; off < r[1]; off += CHUNK)
                    {
                        int want = (int)Math.Min(CHUNK, r[1] - off);
                        byte[] buf = ReadMem(h, r[0] + off, want);
                        if (buf == null) continue;
                        readTotal += buf.Length;
                        Find(buf, uuid, r[0] + off, uuidHits);
                    }
                }
                Console.WriteLine("    uuid occurrences: " + uuidHits.Count);
                long WINDOW = 1 << 21;
                foreach (long a in uuidHits)
                {
                    long from = a - WINDOW; if (from < 0) from = 0;
                    int want = (int)(WINDOW * 2);
                    ScanRegion(h, from, want, klass, iv, ct, seen, ref tried, ref readTotal);
                    if (Program.Found) break;
                }
                Console.WriteLine("    tried " + tried + " keys after fast path");
            }

            // stage 3: parallel full scan over all readable regions
            if (!Program.Found && !uuidOnly)
            {
                var regions = new List<long[]>();
                foreach (var r in Regions(h)) regions.Add(r);
                // Newly allocated objects (the world key is created when a world starts)
                // tend to live in higher-address heap regions, so scanning from the top
                // usually hits sooner. --forward restores the old order.
                if (Array.IndexOf(args, "--reverse") >= 0) regions.Reverse();
                int nThreads = Math.Max(1, Math.Min(Environment.ProcessorCount, 8));
                int ti = Array.IndexOf(args, "--threads");
                if (ti >= 0 && ti + 1 < args.Length)
                {
                    int tq;
                    if (int.TryParse(args[ti + 1], out tq) && tq > 0)
                        nThreads = Math.Min(tq, Environment.ProcessorCount);
                }
                Console.WriteLine("[3] full scan: " + regions.Count + " regions, " + nThreads + " threads...");
                var swScan = System.Diagnostics.Stopwatch.StartNew();
                Parallel.For(0, nThreads, t =>
                {
                    long localTried = 0, localRead = 0;
                    for (int i = t; i < regions.Count && !Program.Found; i += nThreads)
                    {
                        ScanRegion(h, regions[i][0], regions[i][1], klass, iv, ct, seen,
                                   ref localTried, ref localRead);
                    }
                    Interlocked.Add(ref tried, localTried);
                    Interlocked.Add(ref readTotal, localRead);
                });
                swScan.Stop();
                Console.WriteLine("    scan took " + swScan.ElapsedMilliseconds + " ms");
            }

            Console.WriteLine(Program.Found
                ? ">>> DONE, wrote " + Program.OutPath + "  (" + (readTotal / 1024 / 1024) + " MB, " + tried + " keys)"
                : "no hit: read " + (readTotal / 1024 / 1024) + " MB, tried " + tried + " keys");
            return Program.Found ? 0 : 3;
        }
        finally { CloseHandle(h); }
    }
}

static class Program
{
    public static int Pid;
    public static string LevelDat;
    public static string UuidPath;
    public static string OutPath;
    public static volatile bool Found;
    public static bool PrivateOnly = true;

    static string CacheFile
    {
        get
        {
            string dir = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            return Path.Combine(dir ?? ".", "hunt-cache.txt");
        }
    }

    // master key address is stable for the lifetime of one JVM; reuse it across runs
    // so we don't have to re-scan the address space just to learn klass + address.
    public static bool TryCache(IntPtr h, int pid, out long addr, out byte[] klass)
    {
        addr = -1;
        klass = null;
        try
        {
            if (!File.Exists(CacheFile)) return false;
            string[] p = File.ReadAllText(CacheFile).Trim().Split(':');
            if (p.Length < 3) return false;
            if (int.Parse(p[0]) != pid) return false;
            long a = long.Parse(p[1], System.Globalization.NumberStyles.HexNumber);
            byte[] k = new byte[4];
            for (int i = 0; i < 4; i++) k[i] = Convert.ToByte(p[2].Substring(i * 2, 2), 16);
            byte[] probe = Hunt2.ReadMem(h, a, 32);
            if (probe == null || probe.Length != 32) return false;
            for (int i = 0; i < 32; i++) if (probe[i] != Hunt2.MASTER[i]) return false;
            addr = a;
            klass = k;
            return true;
        }
        catch { return false; }
    }

    public static void SaveCache(int pid, long addr, byte[] klass, long lastKey)
    {
        try
        {
            File.WriteAllText(CacheFile, pid + ":" + addr.ToString("X") + ":" +
                BitConverter.ToString(klass).Replace("-", "") + ":" + lastKey.ToString("X"));
        }
        catch { }
    }
}
