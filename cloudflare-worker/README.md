# Cloudflare Worker 反代部署指南

## 为什么需要这个？

`ws.suol.cc` 后端**只支持 HTTP**，不开 443 端口，没有 HTTPS。
国内运营商的反诈系统会拦截 HTTP 明文请求，导致 MusicFree 调用插件时跳反诈页。

解决方案：在 Cloudflare Worker 上部署一个 HTTPS 反代，让手机走 HTTPS 访问 Worker，Worker 走 HTTP 访问上游。

```
[你的手机] ──HTTPS──> [Cloudflare Worker] ──HTTP──> [ws.suol.cc]
            不被拦              免费额度足够           阿里云香港
```

## 部署步骤（5 分钟）

### 方式一：在线部署（最简单，推荐）

1. 注册 / 登录 Cloudflare：https://dash.cloudflare.com
2. 左侧菜单 → **Workers & Pages** → **Create application** → **Create Worker**
3. 给 Worker 起个名字，比如 `xmly-proxy`
4. 删掉编辑器里的示例代码，把 `worker.js` 的内容**完整粘贴**进去
5. 点 **Deploy**
6. 部署成功后，你会得到一个 URL，形如：
   ```
   https://xmly-proxy.<你的子域>.workers.dev
   ```
   记下这个 URL。

7. **测试一下**（在浏览器里打开）：
   ```
   https://xmly-proxy.<你的子域>.workers.dev/kg/kg.php?msg=周杰伦&num=3
   ```
   如果返回 JSON 数据，说明部署成功！🎉

### 方式二：用 wrangler CLI 部署

```bash
# 1. 安装 wrangler
npm install -g wrangler

# 2. 登录
wrangler login

# 3. 进入目录
cd cloudflare-worker

# 4. 部署
wrangler deploy
```

部署完会输出 Worker URL。

## 启用鉴权（推荐）

不设防的话任何人都能用你的 Worker，会消耗你的免费额度（每天 10 万次请求）。

### 在线部署时：
1. Worker 详情页 → **Settings** → **Variables**
2. 添加变量：
   - `AUTH_KEY` = `随便填一个长字符串，比如 mySecretKey2024abc`
3. 保存

### wrangler 部署时：
编辑 `wrangler.toml`，取消 `AUTH_KEY` 那行的注释，填上你的密钥。

### 启用后插件怎么改？

在插件文件顶部，把：
```js
const BASE_URL = "https://xmly-proxy.xxx.workers.dev";
```
改成：
```js
const BASE_URL = "https://xmly-proxy.xxx.workers.dev";
const PROXY_KEY = "mySecretKey2024abc";  // 必须和 Worker 里设置的一样
```
然后所有 axios 调用都加上 header：
```js
axios.get(BASE_URL + "/kg/kg.php", { params: {...}, headers: { "X-Proxy-Key": PROXY_KEY } })
```

> 注：当前版本的插件代码还没集成 PROXY_KEY，如果你启用了鉴权，需要手动在每个 axios 调用里加上 `headers: { "X-Proxy-Key": "..." }`。我可以帮你改，告诉我即可。

## 把 Worker URL 配到插件里

部署成功并拿到 Worker URL 后，编辑 `plugins/` 下每个 `.js` 文件，找到这一行：

```js
const BASE_URL = "http://ws.suol.cc";
```

改成你的 Worker URL：

```js
const BASE_URL = "https://xmly-proxy.<你的子域>.workers.dev";
```

保存后重新在 MusicFree 里加载插件即可。

## 免费额度

- Cloudflare Workers 免费版：**每天 10 万次请求**
- 个人用 MusicFree 听歌完全够用（一首歌约 3~5 次请求：搜索 + 取URL + 取歌词）
- 10 万次 ≈ 每天 2~3 万首歌，绰绰有余

## 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| 浏览器打开 Worker URL 返回 401 | 启用了 AUTH_KEY 但没传 X-Proxy-Key | 在请求里加 header，或暂时取消 AUTH_KEY |
| 返回 502 `upstream_fetch_failed` | Worker 连不上 ws.suol.cc | 上游可能挂了，过几分钟再试 |
| 返回空响应 | 上游限流 | 等 1 分钟重试，或换关键字 |
| MusicFree 仍然跳反诈 | 插件里 URL 没改对 | 检查每个文件顶部的 BASE_URL |

## 为什么要用 Cloudflare？

- 完全免费
- 不需要服务器
- 全球 CDN，延迟低
- 配置简单，5 分钟搞定
- 不限流量（仅限请求数）
- HTTPS 默认开启

如果你没有 Cloudflare 账号，也可以用：
- Vercel Serverless Functions
- Deno Deploy
- 自建 Nginx 反代（需要服务器和域名 + 证书）

但 Cloudflare Worker 是最省事的。
