/**
 * FM.js — Z·喜马拉雅 插件
 * ------------------------------------------------------------------
 * 适用宿主：MusicFree / 同类插件系统
 * 平台标识：Z·喜马拉雅
 * 原作者：wenshao（原始混淆版）
 * 反编译 + 变量重命名 + 注释 by Super Z
 * ------------------------------------------------------------------
 * 通过 ws.suol.cc/xm/ 中转的喜马拉雅接口，支持：
 *   1. 单集（track）与专辑（album）双分类搜索
 *   2. 专辑详情分页获取（每页 50 条，最多 30 页兜底）
 *   3. 单曲/专辑分享链接导入：先 parse 出 albumId 或 trackId，
 *      再走专辑列表或直接播放
 *   4. 多音质播放：M4A_64 / MP3_64 / MP3_32 / AAC_24
 * ------------------------------------------------------------------
 * 数据模型：
 *   - 单集 track   : { trackId, title, nickname, albumTitle, cover, duration, playCount }
 *   - 专辑 album    : { albumId,  title, nickname, cover,         playCount, tracksCount }
 * 后端 baseUrl: http://ws.suol.cc/xm/
 *
 */

const axios = require("axios");

// 后端代理基础地址
const BASE_URL = "http://ws.suol.cc/xm/";
const API = BASE_URL;

// 播放音频时需要带上的 UA（喜马拉雅 CDN 校验）
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0";

/**
 * 音质映射：把宿主统一的音质档位转成喜马拉雅后端识别的码率代号
 */
const QUALITY_MAP = {
  super: "M4A_64", // 64 kbps M4A（最高）
  high: "MP3_64", // 64 kbps MP3
  standard: "MP3_32", // 32 kbps MP3
  low: "AAC_24", // 24 kbps AAC（最低，省流量）
};

module.exports = {
  platform: "Z·喜马拉雅",
  version: "0.1.1",
  author: "Super Z",
  description: "xmFM有声书播放源，支持单集/专辑搜索、专辑详情与多音质播放",
  cacheControl: "no-cache",
  supportedSearchType: ["music", "album"],

  /**
   * 搜索：根据 searchType 决定走专辑搜索还是单集搜索
   * @param {string} keyword    搜索关键字
   * @param {number} page       页码
   * @param {string} searchType "album" 表示搜专辑，其它一律按单集搜
   * @returns {{isEnd: boolean, data: Array}}
   */
  async search(keyword, page, searchType) {
    const core = searchType === "album" ? "album" : "track";

    const response = await axios.get(API + "search", {
      params: { kw: keyword, page, core },
      timeout: 10000,
    });
    const body = response.data;

    if (!body || !Array.isArray(body.results)) {
      return { isEnd: true, data: [] };
    }

    const items = body.results.map((item) => {
      if (core === "album") {
        return {
          id: String(item.albumId),
          title: item.title || "未知专辑",
          artist: item.nickname || "未知主播",
          album: item.title || "",
          artwork: item.cover || "",
          playCount: item.playCount,
          tracksCount: item.tracksCount,
        };
      }
      // 单集
      return {
        id: String(item.trackId),
        title: item.title || "未知",
        artist: item.nickname || "未知主播",
        album: item.albumTitle || "",
        artwork: item.cover || "",
        albumId: String(item.albumId || ""),
        playCount: item.playCount,
        duration: item.duration,
      };
    });

    // 后端固定每页 30 条，少于 30 视为末页
    return { isEnd: items.length < 30, data: items };
  },

  /**
   * 获取专辑详情：分页拉取专辑下的所有单集
   * @param {{albumId?: string, id?: string, artwork?: string, title?: string, artist?: string}} album
   * @param {number} page 页码，从 1 开始
   */
  async getAlbumInfo(album, page) {
    const albumId = album.albumId || album.id;
    const response = await axios.get(API + "album", {
      params: { aid: albumId, page, size: 50 },
      timeout: 10000,
    });
    const body = response.data;

    if (!body || !Array.isArray(body.results)) {
      return { isEnd: true, albumItem: {}, musicList: [] };
    }

    const tracks = body.results.map((item) => ({
      id: String(item.trackId),
      platform: "Z·喜马拉雅",
      title: item.title || "未知",
      artist: body.nickname || "未知主播",
      album: body.albumTitle || "",
      artwork: album.artwork || "",
      albumId: String(albumId),
    }));

    return {
      isEnd: page >= (body.maxPage || 1),
      albumItem: {
        id: String(albumId),
        platform: "Z·喜马拉雅",
        title: body.albumTitle || album.title || "未知专辑",
        artist: body.nickname || album.artist || "未知主播",
        description: body.albumTitle || "",
      },
      musicList: tracks,
    };
  },

  /**
   * 导入分享链接或纯 ID
   *   - http(s) 链接 → 先调 /parse 解析出类型（album 或 sound）
   *       · album  : 走分页拉取所有单集
   *       · sound  : 直接调 /play 返回单集
   *   - 纯数字    : 视为 albumId
   * @param {string} input 用户粘贴的内容
   * @returns {Array<object> | null}
   */
  async importMusicSheet(input) {
    const text = String(input == null ? "" : input).trim();
    if (!text) {
      return null;
    }

    let albumId = null;
    let trackId = null;

    if (/^https?:\/\//i.test(text)) {
      // 分享链接：让后端解析
      const parseResp = await axios.get(API + "parse", {
        params: { url: text },
        timeout: 10000,
      });
      const parsed = parseResp.data;
      if (parsed && parsed.type === "album") {
        albumId = String(parsed.albumId);
      } else if (parsed && parsed.type === "sound") {
        trackId = String(parsed.trackId);
      }
    } else {
      // 纯数字直接当 albumId
      const numMatch = text.match(/\d+/);
      if (numMatch) {
        albumId = numMatch[0];
      }
    }

    // 单集分支：直接拉播放信息返回单条
    if (trackId) {
      const playResp = await axios.get(API + "play", {
        params: { tid: trackId },
        timeout: 15000,
      });
      const playData = playResp.data;
      if (!playData || playData.error || !playData.urls) {
        return null;
      }
      return [
        {
          id: trackId,
          platform: "Z·喜马拉雅",
          title: playData.title || "未知",
          artist: "未知主播",
          artwork: (playData.cover || "").replace(/^http:/, "https:"),
          albumId: trackId,
        },
      ];
    }

    if (!albumId) {
      return null;
    }

    // 专辑分支：循环分页拉取所有单集（最多 30 页兜底，防止死循环）
    const allTracks = [];
    let albumTitle = "";
    let nickname = "";
    let currentPage = 1;

    while (true) {
      const pageResp = await axios.get(API + "album", {
        params: { aid: albumId, page: currentPage, size: 50 },
        timeout: 10000,
      });
      const pageData = pageResp.data;
      if (
        !pageData ||
        !Array.isArray(pageData.results) ||
        !pageData.results.length
      ) {
        break;
      }

      albumTitle = pageData.albumTitle || albumTitle;
      nickname = pageData.nickname || nickname;

      for (const item of pageData.results) {
        allTracks.push({
          id: String(item.trackId),
          platform: "Z·喜马拉雅",
          title: item.title || "未知",
          artist: nickname,
          album: albumTitle,
          albumId,
          duration: item.duration,
        });
      }

      // 拉完或达到最大页数则停止
      if (
        allTracks.length >= (pageData.total || 0) ||
        currentPage >= (pageData.maxPage || 1)
      ) {
        break;
      }
      currentPage += 1;
      if (currentPage > 30) {
        break;
      }
    }

    return allTracks.length ? allTracks : null;
  },

  /**
   * 获取播放地址
   * 后端 /play 接口返回 urls 对象，含多种音质 key
   * 优先用 QUALITY_MAP[quality]，找不到就降级到 MP3_64，再不行取第一个可用
   * @param {{id: string}} song    歌曲对象
   * @param {string}       quality 音质档位
   * @returns {{url: string, headers: object}}
   */
  async getMediaSource(song, quality) {
    const qualityCode = QUALITY_MAP[quality] || "MP3_64";

    const response = await axios.get(API + "play", {
      params: { tid: song.id },
      timeout: 15000,
    });
    const body = response.data;
    if (!body || body.error || !body.urls) {
      throw new Error((body && body.error) || "无法获取播放链接");
    }

    // 优先选请求的音质，降级到 MP3_64，再降级到第一个可用音质
    let url = body.urls[qualityCode] || body.urls.MP3_64;
    if (!url) {
      const keys = Object.keys(body.urls);
      url = keys.length ? body.urls[keys[0]] : "";
    }
    if (!url) {
      throw new Error("无可用音质");
    }

    return {
      url,
      headers: { "User-Agent": UA },
    };
  },
};
