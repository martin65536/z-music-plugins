/**
 * bl.js — Z·哔哩哔哩 插件
 * ------------------------------------------------------------------
 * 适用宿主：MusicFree / 同类插件系统
 * 平台标识：Z·哔哩哔哩
 * 原作者：wenshao（原始混淆版）
 * 反编译 + 变量重命名 + 注释 by Super Z
 * ------------------------------------------------------------------
 * 通过 ws.suol.cc/api/wy/bili_php.php/ 自建网关中转 B 站接口，
 * 与早期版本直连 B 站官方 API 不同，新版统一走代理：
 *   - 不再需要 WBI 签名 / buvid / bili_ticket 等复杂鉴权
 *   - 播放走服务器转码 mp3（api/parse/audio）
 *   - 歌词 / 评论等都通过同一网关获取
 * ------------------------------------------------------------------
 * 支持功能：
 *   1. 关键字搜索视频（music / album 类型）
 *   2. 关键字搜索 UP 主（artist 类型）
 *   3. 视频分 P 列表（专辑详情）
 *   4. UP 主投稿列表
 *   5. 推荐位：入站必刷 + 全站 19 个分区排行榜
 *   6. 收藏夹导入（支持纯 ID / fid= / /playlist/pl / /list/ml 多种形式）
 *   7. LRC 歌词获取（B 站视频字幕）
 *   8. 视频评论获取
 * ------------------------------------------------------------------
 * 后端 baseUrl: http://ws.suol.cc/api/wy/bili_php.php/
 *   所有子接口形如：baseUrl + "api/search" / "api/view" / "api/space" 等
 */

"use strict";

Object.defineProperty(exports, "__esModule", { value: true });

const axios = require("axios");

// 后端代理基础地址（与其他插件统一走 ws.suol.cc）
const BASE_URL = "http://ws.suol.cc/api/wy/bili_php.php/";
const API = BASE_URL;

/**
 * 通用 GET 请求封装
 * @param {string} path     子路径，如 "api/search"
 * @param {object} params   查询参数
 * @returns {Promise<object>} axios response
 */
function httpGet(path, params) {
  return axios.get(API + path, {
    params,
    timeout: 20000,
  });
}

/**
 * 去除 HTML 标签并首尾去空格
 * B 站搜索结果 title 里可能带 <em> 高亮标签
 * @param {string} raw 原始字符串
 * @returns {string}
 */
function cleanTitle(raw) {
  return String(raw == null ? "" : raw).replace(/<[^>]+>/g, "").trim();
}

/**
 * 把相对协议封面（//i0.hdslb.com/...）补成 http: 完整 URL
 * @param {string} url 原始封面字段
 * @returns {string}
 */
function absArtwork(url) {
  const str = String(url == null ? "" : url);
  if (str === "") {
    return "";
  }
  if (str.indexOf("//") === 0) {
    return "http:" + str;
  }
  return str;
}

/**
 * 把 "mm:ss" / "hh:mm:ss" 形式的时长字符串转成秒
 * 数字直接返回；非法格式返回 0
 * @param {number|string} duration
 * @returns {number}
 */
function durationToSec(duration) {
  if (typeof duration === "number") {
    return duration;
  }
  if (typeof duration === "string") {
    const parts = duration.split(":").map(Number);
    if (!parts.length || parts.some(isNaN)) {
      return 0;
    }
    return parts.reduce((acc, part) => acc * 60 + part, 0);
  }
  return 0;
}

/**
 * 把 B 站视频对象归一化成 MusicFree 通用结构
 * @param {object} raw B 站视频原始对象（含 bvid/aid/cid/title/pic/author/duration/create）
 * @returns {object}
 */
function archiveToMusic(raw) {
  return {
    id: String(raw.bvid || raw.aid || ""),
    bvid: raw.bvid,
    aid: raw.aid,
    cid: raw.cid,
    platform: "Z·哔哩哔哩",
    title: cleanTitle(raw.title) || "未知视频",
    artist: raw.author || "B站UP主",
    album: String(raw.bvid || raw.aid || ""),
    artwork: absArtwork(raw.pic),
    duration: durationToSec(raw.duration),
    date: raw.create || "",
  };
}

/**
 * 把搜索接口返回的视频对象归一化（在 archiveToMusic 基础上补 playCount）
 * @param {object} raw 搜索结果原始对象
 * @returns {object}
 */
function videoSearchToMusic(raw) {
  const music = archiveToMusic(raw);
  music.id = String(raw.bvid || "");
  music.bvid = raw.bvid;
  music.artist = raw.author || "B站UP主";
  music.playCount = raw.play;
  return music;
}

/**
 * 判断分页是否到末尾
 * 规则：
 *   - 列表为空 → 末尾
 *   - total 未知 → 当前页结果数 < pageSize 视为末尾
 *   - total 已知 → page * pageSize >= total 视为末尾
 * @param {number} page      当前页码
 * @param {number} pageSize  每页条数
 * @param {number} total     总条数（可能为 null/undefined）
 * @param {Array}  items     当前页结果数组
 * @returns {boolean}
 */
function isEndOf(page, pageSize, total, items) {
  if (Array.isArray(items) && items.length === 0) {
    return true;
  }
  if (total == null) {
    return (items || []).length < pageSize;
  }
  return page * pageSize >= total;
}

/**
 * 搜索视频（作为 album / music 类型返回）
 * @param {string} keyword 关键字
 * @param {number} page    页码
 */
async function searchAlbum(keyword, page) {
  const pageSize = 20;
  const response = await httpGet("api/search", {
    keyword,
    page,
    page_size: pageSize,
    search_type: "video",
  });
  const body = response.data;
  const data = (body && body.data) || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const musicList = items.map(videoSearchToMusic);
  return {
    isEnd: isEndOf(page, pageSize, data.total, items),
    data: musicList,
  };
}

/**
 * 搜索 UP 主（作为 artist 类型返回）
 * @param {string} keyword 关键字
 * @param {number} page    页码
 */
async function searchArtist(keyword, page) {
  const pageSize = 20;
  const response = await httpGet("api/search", {
    keyword,
    page,
    page_size: pageSize,
    search_type: "bili_user",
  });
  const body = response.data;
  const data = (body && body.data) || {};
  const items = Array.isArray(data.items) ? data.items : [];

  const artists = items
    .map((u) => ({
      name: u.uname || "",
      id: String(u.mid || ""),
      fans: u.fans,
      description: u.usign,
      avatar: absArtwork(u.upic),
      worksNum: u.videos,
    }))
    .filter((a) => a.id !== "");

  return {
    isEnd: isEndOf(page, pageSize, data.total, items),
    data: artists,
  };
}

/**
 * 视频分 P 列表（专辑详情）
 *   - 单 P 视频：返回单个元素的数组
 *   - 多 P 视频：每个 P 映射成一个独立音乐项
 * 接口失败时退化为只使用入参 album 的信息
 * @param {object} album 视频对象（含 bvid 或 aid）
 */
async function getAlbumInfo(album) {
  const input = album || {};
  const params = {};
  if (input.bvid) {
    params.bvid = input.bvid;
  } else if (input.aid) {
    params.aid = input.aid;
  }

  // 拉视频详情拿 cid 和 pages
  let viewData = {};
  try {
    const response = await httpGet("api/view", params);
    const body = response.data;
    viewData = (body && body.code === 0 && body.data) || {};
  } catch (e) {
    // 接口失败时退化为空对象，下面用入参兜底
  }

  const cid = viewData.cid || input.cid || 0;
  const pages = Array.isArray(viewData.pages) ? viewData.pages : [];

  let musicList = [];
  if (pages.length <= 1) {
    // 单 P：直接复用入参 + viewData 补全
    musicList = [
      Object.assign(
        Object.assign(
          {},
          archiveToMusic({
            bvid: viewData.bvid || input.bvid,
            aid: viewData.aid || input.aid,
            cid,
            title: viewData.title || input.title,
            pic: viewData.pic || input.artwork,
            author: viewData.ownerName || input.artist,
            duration: viewData.duration || input.duration,
            create: "",
          })
        ),
        { platform: "Z·哔哩哔哩" }
      ),
    ];
  } else {
    // 多 P：每 P 一个独立条目
    const bvid = viewData.bvid || input.bvid;
    const aid = viewData.aid || input.aid;
    musicList = pages.map((p) => ({
      id: String(p.cid || bvid || aid || ""),
      bvid,
      aid,
      cid: p.cid,
      platform: "Z·哔哩哔哩",
      title: cleanTitle(p.part) || "未知分P",
      artist: viewData.ownerName || input.artist || "B站UP主",
      album: String(bvid || aid || ""),
      artwork: absArtwork(viewData.pic || input.artwork),
      duration: durationToSec(p.duration),
      date: "",
    }));
  }

  return {
    isEnd: true,
    albumItem: Object.assign(Object.assign({}, album), viewData),
    musicList,
  };
}

/**
 * UP 主投稿列表
 * @param {{id: string, name?: string}} artist UP 主对象
 * @param {number} page 页码（每页 30 条）
 */
async function getArtistWorks(artist, page) {
  const input = artist || {};
  const pageSize = 30;
  const artistName = input.name || "B站UP主";

  const response = await httpGet("api/space", {
    mid: input.id,
    page,
    ps: pageSize,
  });
  const body = response.data;
  const data = (body && body.data) || {};
  const items = Array.isArray(data.items) ? data.items : [];

  const musicList = items.map((item) => {
    const music = archiveToMusic(item);
    music.artist = artistName;
    return music;
  });

  return {
    isEnd: isEndOf(page, pageSize, data.total, items),
    data: musicList,
  };
}

/**
 * 推荐位：返回 2 个分组
 *   1. 入站必刷（固定一个）
 *   2. 排行榜（19 个分区：全站/音乐/动画/鬼畜/游戏/知识 等）
 * 注意：原版本还有「每周必看」分组，新版移除了
 */
function getTopLists() {
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

  return [preciousGroup, rankingGroup];
}

/**
 * 推荐位详情：调用 api/rank 拉取榜单内视频
 * @param {{id: string, title?: string}} sheet 榜单对象
 */
async function getTopListDetail(sheet) {
  const input = sheet || {};
  if (!input.id) {
    return { isEnd: true, topListItem: input, musicList: [] };
  }

  let items = [];
  try {
    const response = await httpGet("api/rank", { id: input.id });
    const body = response.data;
    items =
      body && body.code === 0 && Array.isArray(body.data.items)
        ? body.data.items
        : [];
  } catch (e) {
    // 失败返回空列表
  }

  return {
    isEnd: true,
    topListItem: Object.assign({}, input),
    musicList: items.map(archiveToMusic),
  };
}

/**
 * 导入收藏夹
 * 支持多种输入形式（依次尝试）：
 *   1. 纯数字                          → 直接当 favId
 *   2. ?fid=123                        → 抽出 123
 *   3. /playlist/pl123                 → 抽出 123
 *   4. /list/ml123                     → 抽出 123
 * 自动翻页，最多 50 页兜底（防极端收藏夹死循环）
 * @param {string} input
 */
async function importMusicSheet(input) {
  let favId;
  const text = String(input || "");

  // 依次尝试 4 种正则
  let match = text.match(/^\s*(\d+)\s*$/);
  if (match) favId = match[1];

  if (!favId) {
    match = text.match(/^(?:.*)fid=(\d+).*$/);
    if (match) favId = match[1];
  }

  if (!favId) {
    match = text.match(/\/playlist\/pl(\d+)/i);
    if (match) favId = match[1];
  }

  if (!favId) {
    match = text.match(/\/list\/ml(\d+)/i);
    if (match) favId = match[1];
  }

  if (!favId) {
    return;
  }

  const allMedias = [];
  let page = 1;
  const pageSize = 20;

  while (true) {
    let body = null;
    try {
      const response = await httpGet("api/favlist", {
        media_id: favId,
        page,
        ps: pageSize,
      });
      body = response.data;
    } catch (e) {
      break;
    }

    const data = (body && body.data) || {};
    const items = Array.isArray(data.items) ? data.items : [];

    allMedias.push(
      ...items.map((item) =>
        Object.assign(Object.assign({}, archiveToMusic(item)), {
          id: String(item.id || item.bvid || ""),
        })
      )
    );

    // 没有更多 或 当前页空 → 停止
    if (!data.hasMore || items.length === 0) {
      break;
    }
    page += 1;
    // 兜底：最多 50 页
    if (page > 50) {
      break;
    }
  }

  return allMedias;
}

/**
 * 获取播放地址
 * 新版统一走服务器转码 mp3：api/parse/audio?url=<bvid>&fmt=mp3
 * 不再像旧版那样解析 DASH 音频流
 * @param {{bvid?: string, id?: string}} media 视频对象
 * @param {string} quality 音质档位（新版忽略，固定 mp3）
 */
async function getMediaSource(media, quality) {
  const bvid =
    media &&
    (media.bvid ||
      (media.id && String(media.id).indexOf("BV") === 0 ? media.id : ""));
  if (!bvid) {
    throw new Error("缺少视频 BV 号");
  }
  const url =
    API +
    "api/parse/audio?url=" +
    encodeURIComponent(bvid) +
    "&fmt=mp3";
  return { url };
}

/**
 * 获取 LRC 歌词（B 站视频字幕，AI 生成或 UP 主上传）
 * @param {{bvid?: string, id?: string, cid?: string}} media 视频对象
 */
async function getLyric(media) {
  const input = media || {};
  const bvid =
    input.bvid ||
    (input.id && String(input.id).indexOf("BV") === 0 ? input.id : "");
  if (!bvid) {
    return null;
  }
  try {
    const params = { bvid };
    if (input.cid) {
      params.cid = input.cid;
    }
    const response = await httpGet("api/lyric", params);
    const body = response.data;
    if (body && body.code === 0 && body.lrc) {
      return { rawLrc: body.lrc };
    }
  } catch (e) {
    // 失败返回 null
  }
  return null;
}

/**
 * 获取视频评论
 * @param {{aid?: string, bvid?: string}} media 视频对象
 */
async function getMusicComments(media) {
  const input = media || {};
  const params = {};
  if (input.aid) {
    params.aid = input.aid;
  } else if (input.bvid) {
    params.bvid = input.bvid;
  }

  let items = [];
  if (Object.keys(params).length > 0) {
    try {
      const response = await httpGet("api/comment", params);
      const body = response.data;
      items =
        body && body.code === 0 && Array.isArray(body.data.items)
          ? body.data.items
          : [];
    } catch (e) {
      // 失败返回空列表
    }
  }

  return { isEnd: true, data: items };
}

module.exports = {
  platform: "Z·哔哩哔哩",
  appVersion: ">=0.0",
  version: "0.1.0",
  author: "Super Z",
  cacheControl: "no-cache",
  srcUrl: "http://ws.suol.cc/qq/wbl.js",
  description:
    "基于自建 B 站网关：搜索视频/UP主、分P专辑、UP主作品、排行榜、收藏夹、歌词与评论，播放走服务器转码 mp3",
  primaryKey: ["id", "aid", "bvid", "cid"],
  hints: {
    importMusicSheet: [
      "bilibili 移动端：APP点击我的，空间，右上角分享，复制链接，浏览器打开切换桌面版网站，点击播放全部视频，复制链接",
      "bilibili H5/PC端：复制收藏夹URL，或者直接输入ID即可",
      "非公开收藏夹无法导入，编辑收藏夹改为公开即可",
      "导入时间和歌单大小有关，请耐心等待",
    ],
  },
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
    return { isEnd: true, data: [] };
  },

  getMediaSource,
  getAlbumInfo,
  getArtistWorks,
  getTopLists,
  getTopListDetail,
  importMusicSheet,
  getLyric,
  getMusicComments,
};
