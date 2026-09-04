/**
 * Cloudflare Worker: ws.suol.cc HTTPS 反代
 * ------------------------------------------------------------------
 * 部署步骤：
 *   1. 登录 https://dash.cloudflare.com → Workers & Pages → Create
 *   2. 把本文件内容粘贴到编辑器，"Deploy"
 *   3. 部署后会得到一个 URL，形如：
 *        https://xmly-proxy.<你的子域>.workers.dev
 *   4. 把这个 URL 填到 plugins/*.js 顶部的 BASE_URL 常量里
 *      （或者在 wrangler.toml 里设置环境变量 UPSTREAM 后部署）
 *
 * 原理：
 *   - 你的手机走 HTTPS 访问 Worker → 运营商看不到内容、不拦
 *   - Worker 走 HTTP 访问 ws.suol.cc → 阿里云香港机房直连，不被风控
 *   - 所有路径、参数、响应原样透传
 *
 * 路由约定：
 *   GET https://<your-worker>.workers.dev/<原始路径>?<原始参数>
 *   例：
 *     原 http://ws.suol.cc/kg/kg.php?msg=周杰伦&num=5
 *     → https://<your-worker>.workers.dev/kg/kg.php?msg=周杰伦&num=5
 *
 *   原 http://ws.suol.cc/xm/search?kw=周杰伦&page=1&core=track
 *     → https://<your-worker>.workers.dev/xm/search?kw=周杰伦&page=1&core=track
 *
 * 可选环境变量（在 Cloudflare 控制台 Settings → Variables 里配）：
 *   UPSTREAM  - 上游地址，默认 http://ws.suol.cc
 *   AUTH_KEY  - 鉴权密钥（推荐设置，防止 Worker 被滥用）
 *               设置后请求需带 header "X-Proxy-Key: <你的密钥>"
 */

// 上游地址（可被环境变量覆盖）
const DEFAULT_UPSTREAM = "http://ws.suol.cc";

// 鉴权失败响应
const UNAUTHORIZED = new Response("Unauthorized", {
  status: 401,
  headers: { "Content-Type": "text/plain" },
});

export default {
  /**
   * @param {Request} request
   * @param {object} env  环境变量 { UPSTREAM?, AUTH_KEY? }
   */
  async fetch(request, env) {
    const upstream = (env && env.UPSTREAM) || DEFAULT_UPSTREAM;

    // —— 鉴权检查（可选）——
    // 如果设置了 AUTH_KEY，请求必须带 X-Proxy-Key 头
    if (env && env.AUTH_KEY) {
      const providedKey = request.headers.get("X-Proxy-Key");
      if (providedKey !== env.AUTH_KEY) {
        return UNAUTHORIZED;
      }
    }

    // —— 构造上游 URL ——
    // request.url 形如 https://xxx.workers.dev/kg/kg.php?msg=...
    // 我们只取 pathname + search 部分，拼到 upstream 后面
    const inUrl = new URL(request.url);
    const targetUrl = upstream + inUrl.pathname + inUrl.search;

    // —— 透传 headers，但去掉 Worker 自动加的、上游不需要的 ——
    const passthroughHeaders = new Headers(request.headers);
    passthroughHeaders.delete("X-Proxy-Key"); // 不暴露鉴权头
    passthroughHeaders.delete("cf-connecting-ip");
    passthroughHeaders.delete("cf-ipcountry");
    passthroughHeaders.delete("cf-ray");
    passthroughHeaders.delete("cf-visitor");
    passthroughHeaders.delete("x-forwarded-for");
    passthroughHeaders.delete("x-real-ip");
    // 上游是 HTTP，不要带 Host
    passthroughHeaders.delete("host");

    // —— 发起上游请求 ——
    const upstreamReq = new Request(targetUrl, {
      method: request.method,
      headers: passthroughHeaders,
      redirect: "follow",
    });

    // GET / HEAD 不带 body；其他方法透传 body
    if (request.method !== "GET" && request.method !== "HEAD") {
      upstreamReq.body = request.body;
    }

    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamReq);
    } catch (e) {
      return new Response(
        JSON.stringify({
          error: "upstream_fetch_failed",
          message: String(e),
          upstream,
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // —— 透传响应 ——
    const respHeaders = new Headers(upstreamResp.headers);
    // 允许任意来源（MusicFree 是 app，无所谓 CORS，但加上无害）
    respHeaders.set("Access-Control-Allow-Origin", "*");
    // 关闭缓存，保证实时性（原插件都是 cacheControl: no-cache）
    respHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: respHeaders,
    });
  },

  /**
   * 处理 CORS 预检请求（其实用不到，但加了无害）
   */
  async options(request) {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  },
};
