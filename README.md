# MANDOM v1.0

本地运行的下载 + 磁力搜索工具。零 npm 依赖，单进程服务，浏览器操作。

## 功能

**收集**
- 视频下载：X/Twitter、B站、YouTube 及 yt-dlp 支持的站点
- 直链：mp4 / m3u8（含 AES-128 加密，自己下分片再本地合并）
- 自动合并音视频轨、自动命名、失败重试、断点续传

**磁力搜索**
- 五源聚合：TPB、Nyaa、Rutor、LimeTorrents、BitSearch
- infohash 去重、标题去重、垃圾广告降权
- 相关性排序、做种/大小/时间排序、升降序
- 中文查询自动查维基补英文/日文原名
- 快速模式 / 精准模式 / 按源选择
- 种子文件列表预览

**Cookie 管理**
- 粘贴 Cookie-Editor 导出的 JSON 即可更新
- 一键检测是否仍有效

## 环境要求

- **Node.js 22+**（用到内置 `fetch` 和 `WebSocket`）
- **Python 3.8+**（仅首次下载工具时用）
- Windows（脚本是 `.cmd`，其他系统需要手动改）

## 快速开始

```bat
:: 1. 下载 yt-dlp 和 ffmpeg 到 tools/
python download_tools.py

:: 2. 启动
start.cmd
```

浏览器打开 `http://127.0.0.1:8792/`。

也可以手动把 `yt-dlp.exe`、`ffmpeg.exe`、`ffprobe.exe` 放进 `tools/` 目录。

## 目录说明

```
lib/engines/   下载引擎（twitter / direct / ytdlp）
lib/torrents.js  磁力搜索聚合
lib/hls.js     HLS 分片下载与合并
lib/queue.js   任务队列
public/        前端（纯静态，无构建）
tools/         外部工具（exe 不进仓库）
cookies/       各站 cookie（不进仓库）
data/          设置与任务历史（不进仓库）
downloads/     默认输出目录
```

## 配置

首次启动会自动生成 `data/settings.json`，也可以在页面里改输出目录。

X 的敏感内容需要登录态：把 `x.com` 的 cookies 导出成 `cookies/twitter.txt`（Cookie-Editor 的 JSON 或 Netscape 格式都行），程序会自动读取。

## 隐私

- 所有数据只存在本机，不上传
- cookie 只用于本站请求，不外发
- 磁力搜索是实时请求公开站点，不经过任何中转

## 已知限制

- X 敏感内容离不开登录 cookie
- 国内磁力站（磁力狗/磁力猫等）有 JS 验证或地域拦截，纯 HTTP 接不了
- 图集（pixiv/konachan）还没做
- DRM 内容无法下载

## 架构

见 [ARCHITECTURE.md](ARCHITECTURE.md)。
