using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.IO;
using System.IO.Compression;
class HuntKey {
  // 已知的 mcsrfairplay 固定主密钥（byte[32]），用于定位 mcsrfairplay 类区域
  static readonly byte[] MASTER = new byte[]{
    0x80,0xED,0x65,0x5C,0xD0,0x40,0x25,0x48,
    0x24,0x78,0x81,0xB6,0xE6,0xCE,0x7B,0x54,
    0xEF,0x36,0x37,0x7E,0x6A,0xB7,0x71,0x75,
    0xF5,0xE2,0x02,0xAC,0xED,0x2A,0x20,0xCC };
  const long NEIGHBOR_SPAN = 1 << 18; // 主密钥邻域 ±256KB 内找 worldKey
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a,bool i,int p);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h,IntPtr a,byte[] b,int s,out int r);
  [DllImport("kernel32.dll")] static extern bool VirtualQueryEx(IntPtr h,IntPtr a,out MBI m,int l);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  const uint VM_READ=0x10, QUERY=0x400;
  const int CHUNK=0x200000;
  [StructLayout(LayoutKind.Sequential)] struct MBI { public IntPtr Base; public IntPtr Alloc; public uint Prot1; public IntPtr Size; public uint State; public uint Protect; public uint Type; }

  static bool IsReadable(MBI m){ return (m.State==0x1000)&&((m.Protect&0x04)!=0||(m.Protect&0x02)!=0); }

  // KMP 精确匹配
  static List<long> KmpSearch(byte[] region, byte[] pat, long baseAddr){
    var hits=new List<long>();
    if(pat.Length==0||region.Length<pat.Length) return hits;
    int[] pref=new int[pat.Length];
    for(int i=1,j=0;i<pat.Length;i++){ while(j>0&&pat[i]!=pat[j]) j=pref[j-1]; if(pat[i]==pat[j]) j++; pref[i]=j; }
    for(int i=0,j=0;i<region.Length;i++){
      while(j>0&&region[i]!=pat[j]) j=pref[j-1];
      if(region[i]==pat[j]) j++;
      if(j==pat.Length){ hits.Add(baseAddr+i-pat.Length+1); j=pref[j-1]; }
    }
    return hits;
  }

  // 读一段内存
  static byte[] ReadMem(IntPtr h, long addr, int size){
    byte[] b=new byte[size]; int r=0;
    if(ReadProcessMemory(h,(IntPtr)addr,b,size,out r)&&r>0){ byte[] a=new byte[r]; Array.Copy(b,a,r); return a; }
    return null;
  }

  static void Main(string[] a){
    int pid=int.Parse(a[0]);
    byte[] ld=File.ReadAllBytes(a[1]);
    byte[] iv=new byte[16]; Array.Copy(ld,0,iv,0,16);
    int ctLen=ld.Length-16; if(ctLen%16!=0) ctLen-=ctLen%16;
    byte[] ct=new byte[ctLen]; Array.Copy(ld,16,ct,0,ctLen);
    IntPtr h=OpenProcess(VM_READ|QUERY,false,pid);
    if(h==IntPtr.Zero){Console.WriteLine("open fail");return;}

    // ---- 阶段1: 全内存扫主密钥（精确32字节模式，比扫所有byte[32]快）----
    Console.WriteLine("[1/2] 定位 mcsrfairplay 主密钥...");
    long masterAddr=-1; long addr=0;
    while(masterAddr<0){
      MBI m; if(!VirtualQueryEx(h,(IntPtr)addr,out m,Marshal.SizeOf<MBI>())) break;
      long baseA=(long)m.Base, size=(long)m.Size;
      if(IsReadable(m)&&size>0){
        long off=0;
        while(off<size&&masterAddr<0){
          int toRead=(int)Math.Min(CHUNK,size-off);
          byte[] buf=ReadMem(h,baseA+off,toRead);
          if(buf!=null){
            var hits=KmpSearch(buf,MASTER,baseA+off);
            if(hits.Count>0){ masterAddr=hits[0]; break; }
          }
          off+=toRead;
        }
      }
      long next=baseA+size; if(next<=addr) break; addr=next;
    }
    if(masterAddr<0){ Console.WriteLine("未找到主密钥"); CloseHandle(h); return; }
    Console.WriteLine("主密钥 @ 0x"+masterAddr.ToString("X")+"（已确认 mcsrfairplay 加载）");

    // ---- 阶段2: 全内存扫 byte[32] 高熵候选，用解密 level.dat 验证哪个是 worldKey ----
    // worldKey 与主密钥不在同一对象、内存位置不确定，只能全内存扫描候选并解密验证。
    Console.WriteLine("[2/2] 全内存扫描 byte[32] 找 worldKey...");
    long scanAddr=0; int tried=0; long totalRead=0;
    while(scanAddr<long.MaxValue){
      MBI m; if(!VirtualQueryEx(h,(IntPtr)scanAddr,out m,Marshal.SizeOf<MBI>())) break;
      long baseA=(long)m.Base, size=(long)m.Size;
      if(IsReadable(m)&&size>0){
        long off=0;
        while(off<size){
          int toRead=(int)Math.Min(CHUNK,size-off);
          byte[] buf=ReadMem(h,baseA+off,toRead);
          if(buf!=null){
            totalRead+=buf.Length;
            for(int i=0;i<buf.Length-48;i++){
              // byte[] 数组: [mark 8][klass C0 22 00 00][len 0x20][data 32]
              if(buf[i+8]==0xC0&&buf[i+9]==0x22&&buf[i+10]==0x00&&buf[i+11]==0x00&&
                 buf[i+12]==0x20&&buf[i+13]==0x00&&buf[i+14]==0x00&&buf[i+15]==0x00){
                byte[] key=new byte[32];
                Array.Copy(buf,i+16,key,0,32);
                int printable=0; foreach(byte bb in key) if(bb>=0x20&&bb<0x7F) printable++;
                if(printable>12) continue;
                bool allZero=true; foreach(byte bb in key) if(bb!=0){allZero=false;break;}
                if(allZero) continue;
                if(ArrayEquals(key,MASTER)) continue; // 跳过主密钥本身
                tried++;
                try{
                  using(var aes=Aes.Create()){
                    aes.Key=key; aes.IV=iv; aes.Mode=CipherMode.CBC; aes.Padding=PaddingMode.PKCS7;
                    using(var dec=aes.CreateDecryptor()){
                      byte[] plain=dec.TransformFinalBlock(ct,0,ct.Length);
                      if(plain.Length>4&&plain[0]==0x1F&&plain[1]==0x8B){
                        Console.WriteLine(">>> HIT! worldKey found");
                        Console.WriteLine("KEY: "+BitConverter.ToString(key).Replace("-",""));
                        File.WriteAllBytes(a[2],plain);
                        CloseHandle(h); return;
                      }
                    }
                  }
                }catch{}
              }
            }
          }
          off+=toRead;
        }
      }
      long next=baseA+size; if(next<=scanAddr) break; scanAddr=next;
    }
    Console.WriteLine("--- 无命中: 读取 "+(totalRead/1024/1024)+" MB, 尝试 "+tried+" 个 ---");
    CloseHandle(h);
  }

  static bool ArrayEquals(byte[] x, byte[] y){ if(x.Length!=y.Length) return false; for(int i=0;i<x.Length;i++) if(x[i]!=y[i]) return false; return true; }
}
