# -*- coding: utf-8 -*-
"""下载 collector 需要的三个绿色工具到 tools/ 目录。可重复运行，已存在则跳过。"""
import os, sys, zipfile, urllib.request, shutil

TOOLS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tools")
os.makedirs(TOOLS, exist_ok=True)

UA = {"User-Agent": "Mozilla/5.0"}

def fetch(url, dest, label):
    if os.path.exists(dest) and os.path.getsize(dest) > 1024:
        print(f"[skip] {label} 已存在")
        return True
    tmp = dest + ".part"
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            got = 0
            while True:
                chunk = r.read(1024 * 256)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if total:
                    pct = got * 100 // total
                    sys.stdout.write(f"\r[{label}] {pct}%  {got//1048576}/{total//1048576} MB")
                else:
                    sys.stdout.write(f"\r[{label}] {got//1048576} MB")
                sys.stdout.flush()
        os.replace(tmp, dest)
        print(f"\n[done] {label} {os.path.getsize(dest)//1024} KB")
        return True
    except Exception as e:
        print(f"\n[fail] {label}: {type(e).__name__} {e}")
        if os.path.exists(tmp):
            try: os.remove(tmp)
            except: pass
        return False

def main():
    ok = True
    ok &= fetch("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
                os.path.join(TOOLS, "yt-dlp.exe"), "yt-dlp")
    ok &= fetch("https://github.com/mikf/gallery-dl/releases/latest/download/gallery-dl.exe",
                os.path.join(TOOLS, "gallery-dl.exe"), "gallery-dl")

    ffdest = os.path.join(TOOLS, "ffmpeg.exe")
    if os.path.exists(ffdest) and os.path.getsize(ffdest) > 1024:
        print("[skip] ffmpeg 已存在")
    else:
        zpath = os.path.join(TOOLS, "ffmpeg.zip")
        url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
        if fetch(url, zpath, "ffmpeg-zip"):
            print("[ffmpeg] 解压中...")
            try:
                with zipfile.ZipFile(zpath) as z:
                    target = None
                    for n in z.namelist():
                        if n.endswith("/bin/ffmpeg.exe") or n.endswith("/bin/ffprobe.exe"):
                            data = z.read(n)
                            out = os.path.join(TOOLS, os.path.basename(n))
                            with open(out, "wb") as f:
                                f.write(data)
                            print(f"[ffmpeg] 解出 {os.path.basename(n)} {len(data)//1048576} MB")
                            target = out
                if target:
                    ok = True
                else:
                    print("[ffmpeg] 压缩包里没找到 ffmpeg.exe"); ok = False
            except Exception as e:
                print(f"[ffmpeg] 解压失败 {e}"); ok = False
            finally:
                try: os.remove(zpath)
                except: pass
        else:
            ok = False

    print("\n=== 结果 ===")
    for f in ("yt-dlp.exe", "gallery-dl.exe", "ffmpeg.exe", "ffprobe.exe"):
        p = os.path.join(TOOLS, f)
        print(f"{f:16s} {'OK  ' + str(os.path.getsize(p)//1024) + ' KB' if os.path.exists(p) else '缺失'}")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
