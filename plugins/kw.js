/**
 * kw.js — Z·酷我 插件
 * ------------------------------------------------------------------
 * 适用宿主：MusicFree / 同类插件系统
 * 平台标识：Z·酷我
 * 原作者：温（原始混淆版）
 * 反编译 + 变量重命名 + 注释 by Super Z
 * ------------------------------------------------------------------
 * 通过 ws.suol.cc 中转的酷我音乐接口，提供：
 *   1. 关键字搜索歌曲（一次返回 20 条，不支持分页）
 *   2. 多音质播放（flac / 320 / 128）
 *   3. LRC 歌词获取
 *   4. 单曲元信息补全
 * ------------------------------------------------------------------
 * 字段约定：返回的歌曲对象统一为 MusicFree 通用 schema
 *   { id, platform, title, artist, album, artwork, duration }
 * 其中 duration 单位为毫秒。
 *
 * ⚠️ 反诈提示：后端 ws.suol.cc 只支持 HTTP，国内运营商会拦截。
 * 部署 cloudflare-worker/ 里的 Worker 后，把下面 BASE_URL
 * 改成你的 Worker HTTPS 地址即可。
 */

const axios = require("axios");

// 后端代理基础地址（HTTP，国内需走 Cloudflare Worker 反代）
// 部署 Worker 后把这里改成："https://你的Worker.workers.dev/kuwo/api"
const BASE_URL = "http://ws.suol.cc/kuwo/api";
const API = BASE_URL;

// 播放音频时需要带上的 UA 与 Referer，否则 CDN 会返回 403
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/134.0 Safari/537.36";

/**
 * 音质映射：把宿主统一的音质档位（super/high/standard/low）
 * 转成酷我后端识别的字符串
 */
const QUALITY_MAP = {
  super: "flac", // 无损 FLAC
  high: "320", // 320 kbps MP3
  standard: "128", // 128 kbps MP3
  low: "128", // 低音质同样落到 128
};

/**
 * 把后端返回的歌曲原始对象归一化成 MusicFree 通用结构
 * 酷我搜索接口可能返回 song_name 或 name；歌手字段也可能是 singers 或 artist
 * 部分歌曲的 title 是 "歌手 - 歌名" 格式，需要拆分
 * @param {object} raw 后端原始歌曲对象
 * @returns {object} 归一化后的歌曲对象
 */
function normalizeSong(raw) {
  let title = String(raw.song_name || raw.name || "未知歌曲").trim();
  let artist = String(raw.singers || raw.artist || "").trim();

  // 处理 "歌手 - 歌名" 形式的标题
  const splitMatch = title.match(/^(.+?)\s*-\s*(.+)$/);
  if (splitMatch && (splitMatch[1].trim() === artist || !artist)) {
    if (!artist) {
      artist = splitMatch[1].trim();
    }
    title = splitMatch[2].trim();
  }

  return {
    id: String(raw.id || ""),
    platform: "Z·酷我",
    title: title || "未知歌曲",
    artist: artist || "未知歌手",
    album: raw.album || "",
    artwork: raw.cover_url || raw.cover || "",
    duration: (raw.duration_s || 0) * 1000, // s → ms
  };
}

module.exports = {
  platform: "Z·酷我",
  version: "0.1.1",
  author: "Super Z",
  description: "酷我音乐：搜索/多音质播放/歌词",
  updateURL: "http://ws.suol.cc/qq/kw.js",
  cacheControl: "no-cache",
  supportedSearchType: ["music"],

  /**
   * 关键字搜索歌曲
   * @param {string} keyword  搜索关键字
   * @param {number} pageNo   页码（后端不实际分页，这里只用作占位）
   * @param {string} type     搜索类型，本插件仅支持 music
   * @returns {{isEnd: boolean, data: Array}}
   */
  async search(keyword, pageNo, type) {
    const response = await axios.get(API + "/search", {
      params: { msg: keyword, num: 20 },
      timeout: 20000,
    });
    const body = response.data;

    if (!body || !body.ok || !body.data || !Array.isArray(body.data.items)) {
      return { isEnd: true, data: [] };
    }
    return { isEnd: true, data: body.data.items.map(normalizeSong) };
  },

  /**
   * 获取播放地址
   * @param {{id: string}} song      歌曲对象
   * @param {string}       quality   音质档位 super/high/standard/low
   * @returns {{url: string, headers: object}}
   */
  async getMediaSource(song, quality) {
    const qualityCode = QUALITY_MAP[quality] || "128";
    const response = await axios.get(
      API + "/song/" + encodeURIComponent(song.id) + "/url",
      {
        params: { quality: qualityCode },
        timeout: 25000,
      }
    );
    const body = response.data;

    if (!body || !body.ok || !body.data || !body.data.url) {
      throw new Error("获取播放链接失败");
    }

    return {
      url: body.data.url,
      headers: {
        "User-Agent": UA,
        Referer: "http://www.kuwo.cn/",
      },
    };
  },

  /**
   * 获取 LRC 歌词
   * @param {{id: string}} song 歌曲对象
   * @returns {{rawLrc: string} | null}
   */
  async getLyric(song) {
    const response = await axios.get(
      API + "/song/" + encodeURIComponent(song.id) + "/lrc",
      { timeout: 15000 }
    );
    const body = response.data;

    if (!body || !body.ok || !body.data || !body.data.lrc) {
      return null;
    }
    return { rawLrc: body.data.lrc };
  },

  /**
   * 获取单曲元信息（用于宿主刷新歌曲详情）
   * @param {{id: string, title?: string, artist?: string}} song 已知部分信息的歌曲
   * @returns {object | null}
   */
  async getMusicInfo(song) {
    const response = await axios.get(
      API + "/song/" + encodeURIComponent(song.id),
      { timeout: 25000 }
    );
    const body = response.data;
    if (!body || !body.ok || !body.data) {
      return null;
    }
    const data = body.data;
    return {
      id: String(data.id || song.id),
      platform: "Z·酷我",
      title: data.song_name || song.title || "未知歌曲",
      artist: data.singers || song.artist || "未知歌手",
      album: data.album || "",
      artwork: data.cover_url || "",
      duration: (data.duration_s || 0) * 1000,
    };
  },
};
