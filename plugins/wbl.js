/**
 * wbl.js — 哔哩哔哩（B 站）音频插件
 * ------------------------------------------------------------------
 * 适用宿主：MusicFree / 同类插件系统
 * 平台标识：温哔哩
 * 作者：温
 * 反编译 + 变量重命名 + 注释 by 逆向工具链
 * ------------------------------------------------------------------
 * 与其他插件不同，本插件直连 B 站官方 API（不走代理）。
 * 因为 B 站近几年的接口大多启用了 WBI 签名 + buvid3/4 cookie 校验，
 * 所以代码里有大量鉴权相关逻辑。
 * ------------------------------------------------------------------
 * 支持功能：
 *   1. 关键字搜索视频（作为 music 或 album 类型返回）
 *   2. 关键字搜索 UP 主（作为 artist 类型返回）
 *   3. 获取视频播放地址（DASH 音频流，按码率分档）
 *   4. 视频分 P 列表（专辑详情）
 *   5. UP 主投稿列表
 *   6. 推荐位：入站必刷 / 每周必看 / 全站各分区排行榜
 *   7. 收藏夹导入
 *   8. 视频评论获取
 * ------------------------------------------------------------------
 * 关键鉴权机制：
 *   - buvid3 / buvid4 : 通过 /x/frontend/finger/spi 拿到的浏览器指纹
 *   - bili_ticket      : 通过 HMAC-SHA256 签名换取的临时 ticket
 *   - wbi 签名         : 用 img_url + sub_url 的 mixin key 对查询参数做 MD5
 *   - w_webid          : 从 UP 主主页 HTML 里抠出的 access_id（用于部分接口）
 */

"use strict";

Object.defineProperty(exports, "__esModule", { value: true });

const axios = require("axios");
const dayjs = require("dayjs");
const he = require("he"); // HTML 实体解码
const CryptoJs = require("crypto-js"); // MD5 / HMAC-SHA256
const { load } = require("cheerio"); // 解析 HTML

// 通用请求头（用于一般接口）
const headers = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36 Edg/89.0.774.63",
  accept: "*/*",
  "accept-encoding": "gzip, deflate, br",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
};

// buvid3/4 cookie 缓存（接口初始化时获取一次）
let cookieCache = null;

/**
 * 通过 bvid 或 aid 查询视频的 cid（分 P 主键）
 * B 站获取播放地址必须同时有 bvid/aid + cid
 * @param {string} bvid BV 号（BV1xx411x7xx）
 * @param {string|number} aid AV 号（纯数字）
 * @returns {Promise<object>} /x/web-interface/view 完整响应
 */
async function getCid(bvid, aid) {
  const params = bvid ? { bvid } : { aid };
  const response = await axios.get(
    "https://api.bilibili.com/x/web-interface/view?%s",
    { headers, params }
  );
  return response.data;
}

/**
 * 把 "mm:ss" / "hh:mm:ss" 形式的时长字符串转成秒
 * 数字直接返回
 * @param {number|string} duration
 * @returns {number}
 */
function durationToSec(duration) {
  if (typeof duration === "number") {
    return duration;
  }
  if (typeof duration === "string") {
    const parts = duration.split(":");
    return parts.reduce((acc, part) => acc * 60 + +part, 0);
  }
  return 0;
}

// 搜索接口专用请求头（带 origin + referer，否则会被风控）
const searchHeaders = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36 Edg/89.0.774.63",
  accept: "application/json, text/plain, */*",
  "accept-encoding": "gzip, deflate, br",
  origin: "https://search.bilibili.com",
  "sec-fetch-site": "same-site",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
  referer: "https://search.bilibili.com/",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
};

/**
 * 初始化 buvid3 / buvid4 cookie（懒加载，进程内只取一次）
 * 调用 B 站 /x/frontend/finger/spi 接口
 */
async function ensureCookie() {
  if (!cookieCache) {
    const response = await axios.get(
      "https://api.bilibili.com/x/frontend/finger/spi",
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) " +
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 " +
            "Mobile/15E148 Safari/604.1 Edg/114.0.0.0",
        },
      }
    );
    cookieCache = response.data.data;
  }
}

const PAGE_SIZE = 20;

/**
 * 搜索基础函数（视频或 UP 主都走这个）
 * @param {string} keyword    关键字
 * @param {number} page       页码
 * @param {string} searchType "video" 或 "bili_user"
 * @returns {Promise<object>} /x/web-interface/search/type 返回的 data 字段
 */
async function searchBase(keyword, page, searchType) {
  await ensureCookie();
  const params = {
    context: "",
    page,
    order: "",
    page_size: PAGE_SIZE,
    keyword,
    duration: "",
    tids_1: "",
    tids_2: "",
    __refresh__: true,
    _extra: "",
    highlight: 1,
    single_column: 0,
    platform: "pc",
    from_source: "",
    search_type: searchType,
    dynamic_offset: 0,
  };
  const response = await axios.get(
    "https://api.bilibili.com/x/web-interface/search/type",
    {
      headers: Object.assign(Object.assign({}, searchHeaders), {
        cookie: "buvid3=" + cookieCache.b_3 + ";buvid4=" + cookieCache.b_4,
      }),
      params,
    }
  );
  return response.data.data;
}

/**
 * 拉取指定收藏夹的全部内容（自动翻页，直到 has_more=false）
 * @param {string|number} favId 收藏夹 ID（ml+数字）
 * @returns {Promise<Array>}
 */
async function getFavoriteList(favId) {
  const all = [];
  const ps = 20;
  let pn = 1;
  while (true) {
    try {
      const response = await axios.get(
        "https://api.bilibili.com/x/v3/fav/resource/list",
        {
          params: { media_id: favId, platform: "web", ps, pn },
        }
      );
      const { medias, has_more } = response.data.data.data;
      all.push(...medias);
      if (!has_more) {
        break;
      }
      pn += 1;
    } catch (e) {
      // 单页失败就停止，避免死循环
      console.warn(e);
      break;
    }
  }
  return all;
}

/**
 * 把搜索结果里的视频对象归一化成 MusicFree 通用结构
 * 注意：B 站搜索接口返回的 title 包含 <em>高亮</em> 标签，需要先去掉再 HTML 解码
 * @param {object} raw B 站搜索结果原始对象
 */
function formatMedia(raw) {
  const decodedTitle = he.decode(
    (raw.title || "").replace(/(\<em(.*?)\>)|(\<\/em\>)/g, "")
  );
  return {
    id: raw.cid ?? raw.bvid ?? raw.aid,
    aid: raw.aid,
    bvid: raw.bvid,
    artist: raw.author ?? raw.owner?.name,
    title: decodedTitle,
    alias: decodedTitle.match(/《(.+?)》/)?.[1], // 抽出书名号里的别名
    album: raw.bvid ?? raw.aid,
    artwork:
      raw.pic && raw.pic.startsWith("//") ? `http:${raw.pic}` : raw.pic,
    duration: durationToSec(raw.duration),
    tags: raw.tag ? raw.tag.split(",") : undefined,
    date: dayjs.unix(raw.pubdate || raw.created).format("YYYY-MM-DD"),
  };
}

/**
 * 搜索视频（作为 music 或 album 类型返回）
 */
async function searchAlbum(keyword, page) {
  const result = await searchBase(keyword, page, "video");
  const data = result.result.map(formatMedia);
  return {
    isEnd: result.numResults <= page * PAGE_SIZE,
    data,
  };
}

/**
 * 搜索 UP 主（作为 artist 类型返回）
 */
async function searchArtist(keyword, page) {
  const result = await searchBase(keyword, page, "bili_user");
  const data = result.result.map((u) => ({
    name: u.uname,
    id: u.mid,
    fans: u.fans,
    description: u.usign,
    avatar:
      u.upic && u.upic.startsWith("//") ? "https://" + u.upic : u.upic,
    worksNum: u.videos,
  }));
  return {
    isEnd: result.numResults <= page * PAGE_SIZE,
    data,
  };
}

/**
 * WBI 签名核心算法 1：从 img_url+sub_url 拼接出的 64 字符串里
 * 按固定打乱顺序取前 32 位作为 mixin key
 * 这个打乱顺序是 B 站写死在前端的，固定不变
 * @param {string} imgAndSub img_url 末尾文件名 + sub_url 末尾文件名拼接出的 64 字符串
 * @returns {string} 32 字符的 mixin key
 */
function getMixinKey(imgAndSub) {
  const mixinKey = [];
  // 固定的字符索引表（来自 B 站前端 wbi 算法）
  const idxTable = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5,
    49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24,
    55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
    57, 62, 11, 36, 20, 34, 44, 52,
  ];
  idxTable.forEach((idx) => {
    if (imgAndSub.charAt(idx)) {
      mixinKey.push(imgAndSub.charAt(idx));
    }
  });
  return mixinKey.join("").slice(0, 32);
}

/**
 * 计算 HMAC-SHA256 签名（用于 bili_ticket 接口）
 * @param {string} key  密钥
 * @param {string} data 待签名字符串
 * @returns {string} hex 编码的签名
 */
function hmacSha256(key, data) {
  return CryptoJs.HmacSHA256(data, key).toString(CryptoJs.enc.Hex);
}

/**
 * 获取 bili_ticket：B 站新一代通用票据，用于 wbi 签名前的 nav 接口
 * 算法：
 *   1. 取当前时间戳
 *   2. 用固定密钥 "XgwSnGZ1p" 对 "ts" + 时间戳做 HMAC-SHA256
 *   3. 拿签名去 /bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket 换 ticket
 * @param {string} csrf 可选，b站登录态 csrf token
 * @returns {Promise<object>} ticket 信息
 */
async function getBiliTicket(csrf) {
  const ts = Math.floor(Date.now() / 1000);
  const hexsign = hmacSha256("XgwSnGZ1p", "ts" + ts);
  const url =
    "https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket";
  const response = await axios.post(url, null, {
    params: {
      key_id: "ec02",
      hexsign,
      "context[ts]": ts,
      csrf: csrf || "",
    },
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0",
    },
  });
  return response.data.data;
}

// wbi 签名用的 img / sub 文件名 + 当日缓存标记（同一天内只取一次）
let wbiImg;
let wbiSub;
let wbiSyncedDate;

/**
 * 获取 wbi 签名所需的 img_url 与 sub_url 末尾文件名（带当日缓存）
 * 内部会先调 getBiliTicket 拿到 nav 数据
 * @returns {Promise<{img: string, sub: string}>}
 */
async function getWBIKeys() {
  // 同一天内复用缓存
  if (
    wbiImg &&
    wbiSub &&
    wbiSyncedDate &&
    wbiSyncedDate.getDate() === new Date().getDate()
  ) {
    return { img: wbiImg, sub: wbiSub };
  }

  const ticketData = await getBiliTicket("");
  // img_url 形如 https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png
  // 我们只需要末尾的文件名（去掉扩展名）
  wbiImg = ticketData.nav.img;
  wbiImg = wbiImg.slice(wbiImg.lastIndexOf("/") + 1, wbiImg.lastIndexOf("."));
  wbiSub = ticketData.nav.sub;
  wbiSub = wbiSub.slice(wbiSub.lastIndexOf("/") + 1, wbiSub.lastIndexOf("."));
  wbiSyncedDate = new Date();
  return { img: wbiImg, sub: wbiSub };
}

/**
 * WBI 签名核心算法 2：对查询参数生成 w_rid 签名
 * 算法：
 *   1. 取 img+sub 拼成 64 字符串，用 getMixinKey 得到 32 位 mixin key
 *   2. 把参数按 key 字典序排序，过滤空值，转成 urlencoded 形式
 *   3. 在末尾追加 mixin key，做 MD5
 * @param {object} params 待签名参数
 * @returns {Promise<string>} 32 位 hex 的 w_rid
 */
async function getWbiSign(params) {
  const { img, sub } = await getWBIKeys();
  const mixinKey = getMixinKey(img + sub);

  const sortedKeys = Object.keys(params).sort();
  const parts = [];
  for (let i = 0, filterRe = /[!'\(\)*]/g; i < sortedKeys.length; ++i) {
    const key = sortedKeys[i];
    let val = params[key];
    if (val && typeof val === "string") {
      // B 站要求过滤掉这些特殊字符
      val = val.replace(filterRe, "");
    }
    if (val != null) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
    }
  }
  const queryString = parts.join("&");
  return CryptoJs.MD5(queryString + mixinKey).toString();
}

// w_webid 缓存（1 小时有效）
let wWebId;
let wWebIdDate;

/**
 * 获取 UP 主主页的 w_webid（用于部分高级接口的额外校验）
 * 实现：抓 UP 主主页 HTML，从 #__RENDER_DATA__ 标签里解析出 access_id
 * 1 小时内复用缓存
 * @param {string} mid UP 主 mid
 */
async function getWWebId(mid) {
  if (wWebId && wWebIdDate && Date.now() - wWebIdDate.getTime() < 3600000) {
    return wWebId;
  }
  const response = await axios.get("https://space.bilibili.com/" + mid, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36 Edg/89.0.774.63",
    },
  });
  const $ = load(response.data);
  const renderData = $("#__RENDER_DATA__").text();
  const parsed = JSON.parse(decodeURIComponent(renderData));
  wWebId = parsed.access_id;
  wWebIdDate = new Date();
  return wWebId;
}

/**
 * 获取 UP 主投稿视频列表（带 wbi 签名）
 * @param {{id: string}} artist UP 主对象
 * @param {number} page 页码（每页 30 条）
 */
async function getArtistWorks(artist, page) {
  const refererHeaders = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36 Edg/89.0.774.63",
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    origin: "https://space.bilibili.com",
    "sec-fetch-site": "same-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    referer: "https://space.bilibili.com/" + artist.id + "/video",
  };
  await ensureCookie();

  const ts = Math.round(Date.now() / 1000);
  const params = {
    mid: artist.id,
    ps: 30,
    tid: 0,
    pn: page,
    web_location: 1550101,
    order_avoided: true,
    order: "pubdate",
    keyword: "",
    platform: "web",
    dm_img_list: "[]",
    // 下面两个 dm_img_str 是 B 站反爬指纹，写死即可
    dm_img_str: "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
    dm_cover_img_str:
      "QU5HTEUgKE5WSURJQSwgTlZJRElBIEdlRm9yY2UgR1RYIDE2NTAgKDB4MDAwMDFGOTEpIERpcmVjdDNEMTEgdnNfNV8wIHBzXzVfMCwgRDNEMTEpR29vZ2xlIEluYy4gKE5WSURJQS",
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
    wts: ts.toString(),
  };

  const wRid = await getWbiSign(params);
  const response = await axios.get(
    "https://api.bilibili.com/x/space/wbi/arc/search",
    {
      headers: Object.assign(Object.assign({}, refererHeaders), {
        cookie: "buvid3=" + cookieCache.b_3 + ";buvid4=" + cookieCache.b_4,
      }),
      params: Object.assign(Object.assign({}, params), { w_rid: wRid }),
    }
  );
  console.log(response.data);

  const pageData = response.data.data;
  const videos = pageData.list.vlist.map(formatMedia);
  return {
    isEnd: pageData.page.pn * pageData.page.ps >= pageData.page.count,
    data: videos,
  };
}

/**
 * 获取视频播放地址（DASH 音频流）
 * B 站视频用的是 DASH 格式：视频流和音频流分开
 * 这里只取音频流，按码率分四档：low/standard/high/super
 * @param {{cid?: string, bvid?: string, aid?: string}} media 视频对象
 * @param {string} quality 音质档位
 * @returns {Promise<{url: string, headers: object}>}
 */
async function getMediaSource(media, quality) {
  // 没有 cid 就先用 bvid/aid 查一下
  let cid = media.cid;
  if (!cid) {
    cid = (await getCid(media.bvid, media.aid)).data.cid;
  }

  const idParams = media.bvid ? { bvid: media.bvid } : { aid: media.aid };
  const response = await axios.get(
    "https://api.bilibili.com/x/player/playurl",
    {
      headers,
      params: Object.assign(Object.assign({}, idParams), {
        cid,
        fnval: 16, // 16 = 请求 DASH 格式
      }),
    }
  );

  let url;
  if (response.data.data.dash) {
    // DASH 流：取音频流数组，按码率从低到高排序后选档
    const audioTracks = response.data.data.dash.audio;
    audioTracks.sort((a, b) => a.bandwidth - b.bandwidth);
    switch (quality) {
      case "low":
        url = audioTracks[0].baseUrl;
        break;
      case "standard":
        url = audioTracks[1].baseUrl;
        break;
      case "high":
        url = audioTracks[2].baseUrl;
        break;
      case "super":
        url = audioTracks[3].baseUrl;
        break;
    }
  } else {
    // 旧 FLV 流兜底
    url = response.data.data.durl[0].url;
  }

  // 从 URL 里抽出 host，作为请求头里的 host 字段
  // B 站 CDN 校验 host + referer，缺一不可
  const hostPart = url.substring(url.indexOf("/") + 2);
  const requestHeaders = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36 Edg/89.0.774.63",
    accept: "*/*",
    host: hostPart.substring(0, hostPart.indexOf("/")),
    "accept-encoding": "gzip, deflate, br",
    connection: "keep-alive",
    referer: `https://www.bilibili.com/video/${media.bvid ?? media.aid ?? ""}`,
  };

  return { url, headers: requestHeaders };
}

/**
 * 推荐位：返回 3 个分组
 *   1. 每周必看（取 series 列表前 8 期）
 *   2. 入站必刷（固定一个）
 *   3. 排行榜（19 个分区，含全站/音乐/动画/鬼畜/游戏/知识 等）
 */
async function getTopLists() {
  // —— 入站必刷 ——
  const preciousGroup = {
    title: "入站必刷",
    data: [
      {
        id: "popular/precious?page_size=100&page=1",
        title: "入站必刷",
        coverImg:
          "https://s1.hdslb.com/bfs/static/jinkela/popular/assets/icon_history.png",
      },
    ],
  };

  // —— 每周必看 ——
  const weeklyGroup = { title: "每周必看", data: [] };
  const weeklyResp = await axios.get(
    "https://api.bilibili.com/x/web-interface/popular/series/list",
    {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      },
    }
  );
  weeklyGroup.data = weeklyResp.data.data.list
    .slice(0, 8)
    .map((item) => ({
      id: "popular/series/one?number=" + item.number,
      title: item.subject,
      description: item.name,
      coverImg:
        "https://s1.hdslb.com/bfs/static/jinkela/popular/assets/icon_weekly.png",
    }));

  // —— 排行榜（19 个分区，写死）——
  const rankingCategories = [
    { id: "ranking/v2?rid=0&type=all", title: "全站" },
    { id: "ranking/v2?rid=3&type=all", title: "音乐" },
    { id: "ranking/v2?rid=1&type=all", title: "动画" },
    { id: "ranking/v2?rid=119&type=all", title: "鬼畜" },
    { id: "ranking/v2?rid=168&type=all", title: "国创相关" },
    { id: "ranking/v2?rid=129&type=all", title: "舞蹈" },
    { id: "ranking/v2?rid=4&type=all", title: "游戏" },
    { id: "ranking/v2?rid=36&type=all", title: "知识" },
    { id: "ranking/v2?rid=188&type=all", title: "科技" },
    { id: "ranking/v2?rid=234&type=all", title: "运动" },
    { id: "ranking/v2?rid=223&type=all", title: "汽车" },
    { id: "ranking/v2?rid=160&type=all", title: "生活" },
    { id: "ranking/v2?rid=211&type=all", title: "美食" },
    { id: "ranking/v2?rid=217&type=all", title: "动物圈" },
    { id: "ranking/v2?rid=155&type=all", title: "时尚" },
    { id: "ranking/v2?rid=5&type=all", title: "娱乐" },
    { id: "ranking/v2?rid=181&type=all", title: "影视" },
    { id: "ranking/v2?rid=0&type=origin", title: "原创" },
    { id: "ranking/v2?rid=0&type=rookie", title: "新人" },
  ];
  const rankingGroup = {
    title: "排行榜",
    data: rankingCategories.map((cat) =>
      Object.assign(Object.assign({}, cat), {
        coverImg:
          "https://s1.hdslb.com/bfs/static/jinkela/popular/assets/icon_rank.png",
      })
    ),
  };

  return [weeklyGroup, preciousGroup, rankingGroup];
}

/**
 * 推荐位详情：根据 sheet.id（形如 "popular/series/one?number=123"）拼接出完整 URL 拉取
 * @param {{id: string, title?: string, description?: string, coverImg?: string}} sheet
 */
async function getTopListDetail(sheet) {
  const response = await axios.get(
    "https://api.bilibili.com/x/web-interface/" + sheet.id,
    {
      headers: Object.assign(Object.assign({}, headers), {
        referer: "https://www.bilibili.com/",
      }),
    }
  );
  return Object.assign(Object.assign({}, sheet), {
    musicList: response.data.data.list.map(formatMedia),
  });
}

/**
 * 导入收藏夹
 * 支持多种输入形式：
 *   1. 纯数字                          → 直接当 favId
 *   2. /playlist/pl123                 → 抽出 123
 *   3. /list/ml123                     → 抽出 123
 *   4. ?fid=123                        → 抽出 123
 * @param {string} input
 */
async function importMusicSheet(input) {
  let favId;
  // 依次尝试 4 种正则
  if (!favId) {
    favId = input.match(/^\s*(\d+)\s*$/)?.[1];
  }
  if (!favId) {
    favId = input.match(/^(?:.*)fid=(\d+).*$/)?.[1];
  }
  if (!favId) {
    favId = input.match(/\/playlist\/pl(\d+)/i)?.[1];
  }
  if (!favId) {
    favId = input.match(/\/list\/ml(\d+)/i)?.[1];
  }
  if (!favId) {
    return;
  }

  const medias = await getFavoriteList(favId);
  return medias.map((m) => ({
    id: m.id,
    aid: m.aid,
    bvid: m.bvid,
    artwork: m.cover,
    title: m.title,
    artist: m.upper?.name,
    album: m.bvid ?? m.aid,
    duration: durationToSec(m.duration),
  }));
}

/**
 * 把评论对象归一化
 * B 站评论的 reply_control.location 形如 "IP属地：北京"，需要截掉前缀
 */
function formatComment(raw) {
  return {
    id: raw.rpid,
    nickName: raw.member?.uname,
    avatar: raw.member?.avatar,
    comment: raw.content?.message,
    like: raw.like,
    createAt: raw.ctime * 1000,
    location:
      raw.reply_control?.location &&
      raw.reply_control.location.startsWith("IP属地：")
        ? raw.reply_control.location.slice(5)
        : undefined,
  };
}

/**
 * 获取视频评论（带 wbi 签名）
 * @param {{aid: string|number}} media 视频对象
 */
async function getMusicComments(media) {
  const params = {
    type: 1,
    mode: 3,
    oid: media.aid,
    plat: 1,
    web_location: 1315875,
    wts: Math.floor(Date.now() / 1000),
  };
  const wRid = await getWbiSign(params);
  const response = await axios.get(
    "https://api.bilibili.com/x/v2/reply/wbi/main",
    {
      params: Object.assign(Object.assign({}, params), { w_rid: wRid }),
    }
  );
  const replies = response.data.data.replies;
  const result = [];
  for (let i = 0; i < replies.length; ++i) {
    result[i] = formatComment(replies[i]);
    if (replies[i].replies?.length) {
      result[i].replies = replies[i].replies.map(formatComment);
    }
  }
  return { isEnd: true, data: result };
}

module.exports = {
  platform: "温哔哩",
  appVersion: ">=0.0",
  version: "0.0.1",
  author: "温",
  cacheControl: "no-cache",
  srcUrl: "",
  primaryKey: ["id", "aid", "bvid", "cid"],
  hints: { importMusicSheet: ["bilibili插件"] },
  supportedSearchType: ["music", "album", "artist"],

  /**
   * 搜索入口：album/music 都走视频搜索，artist 走 UP 主搜索
   */
  async search(keyword, page, type) {
    if (type === "album" || type === "music") {
      return await searchAlbum(keyword, page);
    }
    if (type === "artist") {
      return await searchArtist(keyword, page);
    }
  },

  getMediaSource,

  /**
   * 视频分 P 列表
   * 单 P 视频：直接返回带 cid 的单元素数组
   * 多 P 视频：每个 P 都映射成一个独立音乐项
   * @param {{bvid?: string, aid?: string}} album 视频对象
   */
  async getAlbumInfo(album) {
    const viewData = await getCid(album.bvid, album.aid);
    const data = viewData?.data ?? {};
    const cid = data.cid;
    const pages = data.pages;

    let musicList;
    if (pages.length === 1) {
      // 单 P：复用原 album 信息
      musicList = [Object.assign(Object.assign({}, album), { cid })];
    } else {
      // 多 P：每 P 一个独立条目
      musicList = pages.map((p) =>
        Object.assign(Object.assign({}, album), {
          cid: p.cid,
          title: p.part,
          duration: durationToSec(p.duration),
          id: p.cid,
        })
      );
    }
    return { musicList };
  },

  getArtistWorks,
  getTopLists,
  getTopListDetail,
  importMusicSheet,
  getMusicComments,
};
