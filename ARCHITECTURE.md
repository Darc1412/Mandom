# Collector 架构

## 分层（依赖只许向下）

```
server.js          路由与启动，无业务逻辑
  ├─ queue.js      任务队列、并发、状态机（唯一状态所有者）
  │   ├─ resolver.js   URL → Item 草稿（探测链）
  │   │   └─ engines/  ytdlp.js / direct.js / （以后 gallerydl.js）
  │   └─ store.js      落盘、命名模板、去重、sidecar
  ├─ sse.js        进度推送
  └─ config.js     设置读写
models.js          纯数据定义，无依赖
```

## 模块契约

| 模块 | 公开接口 | 禁止 |
|---|---|---|
| models | `siteOf(url)` `normalizeUrl(url)` `createItem()` `createAsset()` `createTask()` | 引用其他模块 |
| config | `get()` `set(patch)` `getTool(name)` | 网络、队列 |
| resolver | `resolve(url)` → `Item \| null` | 写文件、发事件 |
| engines/* | `probe(url, ctx)` → `Item \| null`，`download(task, ctx, onProgress)` → `{files}` | 互相引用、写最终路径 |
| store | `commit(task)`、`dedupeKey(item)` | 决定成功失败 |
| queue | `add(items)` `cancel(id)` `retry(id)`、EventEmitter `task` 事件 | 解析 URL、拼路径 |
| sse | `attach(req,res)` `broadcast(event)` | 知道任务细节 |

## 数据模型

```
Item   一条输入链接
  id, url, site, kind, title, author, date, thumb, duration,
  engine, assets[], status, error

Asset  一个可下载文件
  url, ext, quality, bytes, outputPath, meta

Task   Item 的运行态（queue 持有）
  id, item, state: queued|probing|downloading|done|failed|canceled,
  progress: {percent, bytes, total, speed, eta}, file, error, log[]
```

## 规则

1. 状态只存在 queue 里，其他地方只读。
2. 引擎只写临时目录，store 负责移入最终路径。
3. 加一个站点 = 加一个 engines 文件 + 在 engines/index.js 注册一行。
4. 对外只暴露 HTTP JSON 和 SSE，不暴露内部对象。
