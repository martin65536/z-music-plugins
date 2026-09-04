/**
 * wy.js — Z·网易云 插件
 * ------------------------------------------------------------------
 * 适用宿主：MusicFree / 同类插件系统
 * 平台标识：Z·网易云
 * 原作者：温（原始混淆版）
 * 反编译 + 变量重命名 + 注释 by Super Z
 * ------------------------------------------------------------------
 * 通过 ws.suol.cc/api/wy/wy_php.php/ 中转的网易云音乐接口，
 * 走的是网易云官方 API（NeteaseCloudMusicApi 风格）的字段结构：
 *   - songs[i].ar        歌手数组（每个含 name）
 *   - songs[i].al        专辑对象（含 name 与 picUrl）
 *   - songs[i].dt        时长（毫秒）
 *   - songs[i].br        音质（bitrate）
 * 支持功能：
 *   1. 搜索（仅 music 分类，每页 15 条）
 *   2. 多音质播放：128k / 192k / 320k / 999k（无损）
 *   3. LRC 歌词
 *   4. 单曲详情补全
 *   5. 歌单详情（每页 500 条）
 *   6. 推荐榜单：热歌榜 / 新歌榜 / 原创榜 / 飙升榜 / 欧美榜 / 华语榜
 *   7. 歌单 / 单曲分享链接导入
 * ------------------------------------------------------------------
 * 后端约定：返回体 { code: 200, ... } 表示成功
 *
 * ⚠️ 反诈提示：后端 ws.suol.cc 只支持 HTTP，国内运营商会拦截。
 * 部署 cloudflare-worker/ 里的 Worker 后，把下面 BASE_URL
 * 改成你的 Worker HTTPS 地址即可。
 */

const axios = require("axios");

// 后端代理基础地址（HTTP，国内需走 Cloudflare Worker 反代）
// 部署 Worker 后把这里改成："https://你的Worker.workers.dev/api/wy/wy_php.php/"
const BASE_URL = "http://ws.suol.cc/api/wy/wy_php.php/";
const SERVER = BASE_URL;

/**
 * 音质映射：把宿主统一的音质档位转成网易云的 bitrate（bps）
 */
const BR_MAP = {
  low: 128000,
  standard: 192000,
  high: 320000,
  super: 999000, // FLAC 无损
};

/**
 * 把网易云返回的歌曲对象归一化成 MusicFree 通用结构
 * 注意：网易云用 _songId 字段保留原始 id，避免被宿主转换
 * @param {object} song 网易云原始歌曲对象
 */
function formatSong(song) {
  return {
    id: String(song.id),
    platform: "Z·网易云",
    title: song.name || "未知",
    artist: (song.ar || []).map((a) => a.name).join("/") || "未知歌手",
    album: song.al?.name || "",
    artwork: song.al?.picUrl || "",
    duration: Math.floor((song.dt || 0) / 1000), // ms → s
    _songId: String(song.id), // 防止宿主把 id 转成其他形式后丢失原始 id
  };
}

module.exports = {
  platform: "Z·网易云",
  version: "0.0.2",
  author: "Super Z",
  description: "基于第三方代理 API 的网易云音乐插件",
  supportedSearchType: ["music", "artist", "album", "sheet"],
  cacheControl: "no-cache",

  /**
   * 搜索歌曲
   * 注意：声明了 4 种搜索类型，但实际只实现了 music，其他类型直接返回空
   * @param {string} keyword    搜索关键字
   * @param {number} pageNo     页码（从 1 开始）
   * @param {string} searchType 搜索类型
   */
  async search(keyword, pageNo, searchType) {
    if (searchType !== "music") {
      return { isEnd: true, data: [] };
    }

    const limit = 15;
    const offset = (pageNo - 1) * limit;

    const response = await axios.get(SERVER + "cloudsearch", {
      params: { keywords: keyword, type: 1, limit, offset },
      timeout: 15000,
    });
    if (!response.data || response.data.code !== 200) {
      throw new Error(response.data?.message || "搜索失败");
    }

    const result = response.data.result || {};
    const songs = result.songs || [];
    const totalCount = result.songCount || 0;

    return {
      isEnd: pageNo * limit >= totalCount,
      data: songs.map(formatSong),
    };
  },

  /**
   * 获取播放地址
   * @param {{_songId?: string, id: string}} song    歌曲对象
   * @param {string}                           quality 音质档位
   */
  async getMediaSource(song, quality) {
    const songId = song._songId || song.id;
    const br = BR_MAP[quality] || 320000;

    const response = await axios.get(SERVER + "song/url", {
      params: { id: songId, br },
      timeout: 15000,
    });
    const data = (response.data && response.data.data) || [];
    const url = data[0]?.url;
    if (!url) {
      throw new Error("该歌曲暂无音源（可能需 VIP 或已下架）");
    }
    return {
      url,
      headers: {
        Referer: "https://music.163.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    };
  },

  /**
   * 获取 LRC 歌词
   * @param {{_songId?: string, id: string}} song
   */
  async getLyric(song) {
    const songId = song._songId || song.id;
    const response = await axios.get(SERVER + "lyric", {
      params: { id: songId },
      timeout: 15000,
    });
    if (!response.data || response.data.code !== 200) {
      return { rawLrc: "" };
    }
    return { rawLrc: response.data.lrc?.lyric || "" };
  },

  /**
   * 获取单曲详情（用于宿主刷新歌曲的封面 / 专辑 / 时长）
   * 失败时返回空对象而非抛错，避免阻塞 UI
   * @param {{_songId?: string, id: string, artwork?: string, album?: string, duration?: number}} song
   */
  async getMusicInfo(song) {
    const songId = song._songId || song.id;
    try {
      const response = await axios.get(SERVER + "song/detail", {
        params: { ids: songId },
        timeout: 15000,
      });
      const detail = (response.data?.songs || [])[0];
      if (!detail) {
        return {};
      }
      return {
        artwork: detail.al?.picUrl || song.artwork,
        album: detail.al?.name || song.album,
        duration: Math.floor((detail.dt || 0) / 1000) || song.duration,
      };
    } catch (e) {
      return {};
    }
  },

  /**
   * 获取歌单详情
   *   - 每页 500 条（一次性拉很多，减少翻页开销）
   *   - 仅第一页时附加拉取歌单元信息（标题 / 创建者 / 封面 / 描述）
   * @param {{_uid?: string, id?: string, _topId?: string, title?: string, artist?: string, artwork?: string}} sheet
   * @param {number} page 页码
   */
  async getMusicSheetInfo(sheet, page) {
    const sheetId = sheet._uid || sheet.id || sheet._topId;
    if (!sheetId) {
      throw new Error("无法识别歌单 ID");
    }

    const limit = 500;
    const offset = (page - 1) * limit;

    const response = await axios.get(SERVER + "playlist/track/all", {
      params: { id: sheetId, limit, offset },
      timeout: 20000,
    });
    if (!response.data || response.data.code !== 200) {
      throw new Error(response.data?.message || "获取歌单失败");
    }

    const songs = response.data.songs || [];
    const result = {
      isEnd: songs.length < limit,
      musicList: songs.map((s) => ({
        id: String(s.id),
        platform: "Z·网易云",
        title: s.name || "未知",
        artist: (s.ar || []).map((a) => a.name).join("/") || "未知歌手",
        album: s.al?.name || "",
        artwork: s.al?.picUrl || "",
        duration: Math.floor((s.dt || 0) / 1000),
        _songId: String(s.id),
      })),
    };

    // 第一页时顺便拉歌单元信息
    if (page === 1) {
      try {
        const detailResp = await axios.get(SERVER + "playlist/detail", {
          params: { id: sheetId },
          timeout: 15000,
        });
        const detail = detailResp.data?.playlist;
        if (detail) {
          result.sheetItem = {
            title: detail.name || sheet.title,
            artist: detail.creator?.nickname || sheet.artist,
            artwork: detail.coverImgUrl || sheet.artwork,
            description: detail.description || "",
          };
        }
      } catch (e) {
        // 元信息失败不影响主流程
      }
    }

    return result;
  },

  /**
   * 推荐榜单列表（写死的 6 个固定榜单 ID）
   */
  async getTopLists() {
    const FIXED_TOPS = [
      { id: "3778678", title: "热歌榜", description: "网易云音乐热歌榜" },
      { id: "3779629", title: "新歌榜", description: "网易云音乐新歌榜" },
      { id: "2884035", title: "原创榜", description: "网易云音乐原创榜" },
      { id: "19723756", title: "飙升榜", description: "网易云音乐飙升榜" },
      { id: "2250011882", title: "欧美榜", description: "网易云音乐欧美榜" },
      { id: "60198", title: "华语榜", description: "网易云音乐华语榜" },
    ];
    return [
      {
        title: "网易云音乐排行榜",
        data: FIXED_TOPS.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          _topId: t.id, // 供 getTopListDetail 复用
        })),
      },
    ];
  },

  /**
   * 榜单详情：复用 getMusicSheetInfo
   * 把榜单当歌单拉就行
   */
  async getTopListDetail(top, page) {
    const topId = top._topId || top.id;
    const fakeSheet = { id: topId, title: top.title, _uid: topId };
    return this.getMusicSheetInfo(fakeSheet, page);
  },

  /**
   * 导入歌单
   * 支持两种输入：
   *   1. https://music.163.com/playlist?id=xxx  → 抽出数字 id
   *   2. 纯数字                                 → 直接当 id
   * 循环分页拉取所有歌曲，超过 20000 首强制截断（防止极端歌单卡死）
   * @param {string} input 用户输入
   * @returns {Array<object>}
   */
  async importMusicSheet(input) {
    const text = String(input == null ? "" : input).trim();

    let sheetId = null;
    // 从 URL 抽取 playlist 数字 id
    const urlMatch = text.match(/playlist[^\d]*(\d+)/);
    if (urlMatch) {
      sheetId = urlMatch[1];
    } else if (/^\d+$/.test(text)) {
      // 纯数字
      sheetId = text;
    }
    if (!sheetId) {
      throw new Error(
        "无法识别的歌单链接格式，请使用网易云歌单链接或歌单 ID"
      );
    }

    const allSongs = [];
    let offset = 0;
    const limit = 500;

    while (true) {
      const response = await axios.get(SERVER + "playlist/track/all", {
        params: { id: sheetId, limit, offset },
        timeout: 20000,
      });
      if (!response.data || response.data.code !== 200) {
        throw new Error(response.data?.message || "获取歌单失败");
      }
      const songs = response.data.songs || [];
      if (!songs.length) {
        break;
      }
      allSongs.push(
        ...songs.map((s) => ({
          id: String(s.id),
          platform: "Z·网易云",
          title: s.name || "未知",
          artist: (s.ar || []).map((a) => a.name).join("/") || "未知歌手",
          album: s.al?.name || "",
          artwork: s.al?.picUrl || "",
          duration: Math.floor((s.dt || 0) / 1000),
          _songId: String(s.id),
        }))
      );
      // 一页没拉满 = 已经到底
      if (songs.length < limit) {
        break;
      }
      offset += limit;
      // 兜底：超过 2 万首强制截断
      if (offset > 20000) {
        break;
      }
    }
    return allSongs;
  },

  /**
   * 导入单曲
   * 支持两种输入：
   *   1. https://music.163.com/song?id=xxx  → 抽出数字 id
   *   2. 纯数字                              → 直接当 id
   * @param {string} input 用户输入
   * @returns {object} 标准化的歌曲对象
   */
  async importMusicItem(input) {
    const text = String(input).trim();
    let songId = input;

    const urlMatch = text.match(/song[\/=](\d+)/);
    if (urlMatch) {
      songId = urlMatch[1];
    } else if (/^\d+$/.test(text)) {
      songId = text;
    } else {
      throw new Error(
        "无法识别的歌曲链接格式，请使用网易云歌曲链接或歌曲 ID"
      );
    }

    const response = await axios.get(SERVER + "song/detail", {
      params: { ids: songId },
      timeout: 15000,
    });
    const detail = (response.data?.songs || [])[0];
    if (!detail) {
      throw new Error("获取歌曲信息失败");
    }
    return {
      id: String(detail.id || songId),
      title: detail.name || "未知歌曲",
      artist: (detail.ar || []).map((a) => a.name).join("/") || "未知歌手",
      album: detail.al?.name || "",
      artwork: detail.al?.picUrl || "",
      duration: Math.floor((detail.dt || 0) / 1000),
      _songId: String(detail.id || songId),
    };
  },
};
