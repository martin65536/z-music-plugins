/**
 * kg.js — Z·酷狗 插件
 * ------------------------------------------------------------------
 * 适用宿主：MusicFree / 同类插件系统
 * 平台标识：Z·酷狗
 * 原作者：温（原始混淆版）
 * 反编译 + 变量重命名 + 注释 by Super Z
 * ------------------------------------------------------------------
 * 通过 ws.suol.cc/kg/kg.php 中转的酷狗概念版接口，支持：
 *   1. 关键字搜索歌曲
 *   2. 多音质播放（flac / 320 / 128）
 *   3. LRC 歌词获取
 *   4. 单曲元信息补全
 *   5. 推荐位：每日推荐 / 最近收听 / 我的云盘 / 我的歌单
 *   6. 歌单导入：支持 gcid / 歌单 ID / 分享短链三种形式
 *   7. 专辑详情：复用歌单接口（listid = albumId）
 * ------------------------------------------------------------------
 * 后端约定：返回体 { code: 0, data: ... } 表示成功
 * 后端 baseUrl: http://ws.suol.cc/kg/kg.php
 *
 * ⚠️ 反诈提示：后端 ws.suol.cc 只支持 HTTP，国内运营商会拦截。
 * 部署 cloudflare-worker/ 里的 Worker 后，把下面 BASE_URL
 * 改成你的 Worker HTTPS 地址即可。
 */

const axios = require("axios");

// 后端代理基础地址（HTTP，国内需走 Cloudflare Worker 反代）
// 部署 Worker 后把这里改成："https://你的Worker.workers.dev/kg/kg.php"
const BASE_URL = "http://ws.suol.cc/kg/kg.php";
const API = BASE_URL;

// 播放时需要带上的 UA 与 Referer
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/134.0 Safari/537.36";

/**
 * 音质映射：把宿主统一的音质档位转成酷狗后端识别的字符串
 */
const QUALITY_MAP = {
  super: "flac",
  high: "320",
  standard: "128",
  low: "128",
};

/**
 * 把后端返回的歌曲原始对象归一化成 MusicFree 通用结构
 * 处理点：
 *   1. title 可能是 "歌手 - 歌名" 形式，需要拆分
 *   2. title 末尾可能带 .mp3 / .flac 等扩展名，去掉
 *   3. 字段名兼容：name / filename / artist / singer / cover / pic
 * @param {object} raw 后端原始歌曲对象
 * @returns {object} 归一化后的歌曲对象
 */
function normalizeSong(raw) {
  let title = String(raw.name || raw.filename || "未知歌曲").trim();
  let artist = raw.artist || raw.singer || "";

  // 拆 "歌手 - 歌名"
  const splitMatch = title.match(/^(.+?)\s*-\s*(.+)$/);
  if (splitMatch && (splitMatch[1].trim() === artist || !artist)) {
    if (!artist) {
      artist = splitMatch[1].trim();
    }
    title = splitMatch[2].trim();
  }

  // 去掉文件扩展名
  title = title.replace(/\.(mp3|flac|wav|m4a|aac|ogg|ape)$/i, "");

  return {
    id: String(raw.id || ""),
    platform: "Z·酷狗",
    title: title || "未知歌曲",
    artist: artist || "未知歌手",
    album: raw.album || "",
    artwork: raw.cover || raw.pic || "",
    duration: raw.duration || 0,
  };
}

module.exports = {
  platform: "Z·酷狗",
  version: "0.3.1",
  author: "Super Z",
  description:
    "酷狗概念版全接口：搜索/多音质播放/歌词/每日推荐/我的歌单/最近收听/云盘/歌单导入(gcid/分享短链)",
  updateURL: "http://ws.suol.cc/qq/kg.js",
  cacheControl: "no-cache",
  supportedSearchType: ["music"],

  /**
   * 关键字搜索歌曲
   * @param {string} keyword 搜索关键字
   * @returns {{isEnd: boolean, data: Array}}
   */
  async search(keyword) {
    const response = await axios.get(API, {
      params: { msg: keyword, num: 20 },
      timeout: 20000,
    });
    const body = response.data;
    if (!body || body.code !== 0 || !Array.isArray(body.data)) {
      return { isEnd: true, data: [] };
    }
    return { isEnd: true, data: body.data.map(normalizeSong) };
  },

  /**
   * 获取播放地址
   * @param {{id: string}} song    歌曲对象（id 实为酷狗 hash）
   * @param {string}       quality 音质档位
   */
  async getMediaSource(song, quality) {
    const qualityCode = QUALITY_MAP[quality] || "128";
    const response = await axios.get(API, {
      params: { id: song.id, quality: qualityCode },
      timeout: 25000,
    });
    const body = response.data;
    if (!body || body.code !== 0 || !body.data || !body.data.url) {
      throw new Error("获取播放链接失败");
    }
    return {
      url: body.data.url,
      headers: { "User-Agent": UA, Referer: "http://www.kugou.com/" },
    };
  },

  /**
   * 获取 LRC 歌词
   * @param {{id: string}} song 歌曲对象
   */
  async getLyric(song) {
    const response = await axios.get(API, {
      params: { action: "lyric", hash: song.id },
      timeout: 15000,
    });
    const body = response.data;
    if (!body || body.code !== 0 || !body.data || !body.data.lyric) {
      return null;
    }
    return { rawLrc: body.data.lyric };
  },

  /**
   * 获取单曲元信息
   * @param {{id: string, title?: string, artist?: string}} song
   */
  async getMusicInfo(song) {
    const response = await axios.get(API, {
      params: { id: song.id },
      timeout: 25000,
    });
    const body = response.data;
    if (!body || body.code !== 0 || !body.data) {
      return null;
    }
    const data = body.data;
    return {
      id: String(data.id || song.id),
      platform: "Z·酷狗",
      title: data.name || song.title || "未知歌曲",
      artist: data.artist || song.artist || "未知歌手",
      album: data.album || "",
      artwork: data.cover || "",
      duration: data.duration || 0,
    };
  },

  /**
   * 返回推荐位分组：
   *   - 「个性推荐」：每日推荐 30 首
   *   - 「我的音乐」：最近收听 / 我的云盘 + 用户自建歌单列表（需登录态）
   * 注意：未登录情况下 user_playlist 接口可能失败，此时只返回个性推荐
   */
  async getTopLists() {
    const groups = [
      {
        title: "个性推荐",
        data: [
          {
            title: "每日推荐",
            id: "recom",
            description: "酷狗概念版每日推荐 30 首",
          },
        ],
      },
    ];

    // 尝试拉取用户歌单（需要登录态，失败则跳过）
    const response = await axios.get(API, {
      params: { action: "user_playlist", page: 1, pagesize: 30 },
      timeout: 15000,
    });
    const body = response.data;
    if (
      body &&
      body.code === 0 &&
      body.data &&
      Array.isArray(body.data.list) &&
      body.data.list.length
    ) {
      groups.push({
        title: "我的音乐",
        data: [
          {
            title: "最近收听",
            id: "history",
            description: "酷狗概念版最近收听",
          },
          {
            title: "我的云盘",
            id: "cloud",
            description: "酷狗概念版我的云盘",
          },
        ].concat(
          body.data.list.map((pl) => ({
            title: pl.name || "未命名歌单",
            id: "pl:" + String(pl.id),
            description: "共 " + (pl.count || 0) + " 首",
            coverImg: pl.pic || "",
          }))
        ),
      });
    }
    return groups;
  },

  /**
   * 推荐位详情：根据 sheetId 类型路由
   *   - "recom"               每日推荐
   *   - "history"             最近收听
   *   - "cloud"               我的云盘
   *   - "pl:<listid>"         用户歌单（分页拉取，最多 10 页兜底）
   */
  async getTopListDetail(sheet) {
    const sheetId = String(sheet.id || "");

    // —— 每日推荐 ——
    if (sheetId === "recom") {
      const response = await axios.get(API, {
        params: { action: "recom" },
        timeout: 25000,
      });
      const body = response.data;
      if (
        !body ||
        body.code !== 0 ||
        !body.data ||
        !Array.isArray(body.data.songs)
      ) {
        return { isEnd: true, musicList: [] };
      }
      return {
        title: sheet.title || "每日推荐",
        id: sheetId,
        description: sheet.description || "",
        musicList: body.data.songs.map(normalizeSong),
      };
    }

    // —— 最近收听 ——
    if (sheetId === "history") {
      const response = await axios.get(API, {
        params: { action: "user_history" },
        timeout: 15000,
      });
      const body = response.data;
      if (
        !body ||
        body.code !== 0 ||
        !body.data ||
        !Array.isArray(body.data.songs)
      ) {
        return { isEnd: true, musicList: [] };
      }
      // 最近收听里只返回 name + artist + hash，需要过滤掉 hash 为空的脏数据
      const songs = body.data.songs
        .map((s) => ({
          id: String(s.hash || ""),
          platform: "Z·酷狗",
          title: s.name || "未知歌曲",
          artist: s.artist || "未知歌手",
          duration: 0,
        }))
        .filter((s) => s.id !== "");
      return {
        title: "最近收听",
        id: sheetId,
        description: sheet.description || "",
        musicList: songs,
      };
    }

    // —— 我的云盘 ——
    if (sheetId === "cloud") {
      const response = await axios.get(API, {
        params: { action: "user_cloud", page: 1, pagesize: 50 },
        timeout: 15000,
      });
      const body = response.data;
      if (
        !body ||
        body.code !== 0 ||
        !body.data ||
        !Array.isArray(body.data.songs)
      ) {
        return { isEnd: true, musicList: [] };
      }
      const songs = body.data.songs
        .map((s) => ({
          id: String(s.hash || ""),
          platform: "Z·酷狗",
          title: s.name || "未知歌曲",
          artist: s.artist || "未知歌手",
          album: s.album || "",
          artwork: s.cover || "",
          duration: s.duration || 0,
        }))
        .filter((s) => s.id !== "");
      return {
        title: "我的云盘",
        id: sheetId,
        description: sheet.description || "",
        musicList: songs,
      };
    }

    // —— 用户歌单（"pl:<listid>"）——
    if (sheetId.indexOf("pl:") === 0) {
      const listid = sheetId.slice(3);
      const allSongs = [];
      let page = 1;
      while (true) {
        const response = await axios.get(API, {
          params: {
            action: "playlist_songs",
            listid,
            page,
            pagesize: 50,
          },
          timeout: 20000,
        });
        const body = response.data;
        if (
          !body ||
          body.code !== 0 ||
          !body.data ||
          !Array.isArray(body.data.songs) ||
          !body.data.songs.length
        ) {
          break;
        }
        allSongs.push(...body.data.songs.map(normalizeSong));
        // 拉满总数或 10 页就停（10 页 = 500 首）
        if (allSongs.length >= (body.data.total || 0) || page >= 10) {
          break;
        }
        page += 1;
      }
      return {
        title: sheet.title || "酷狗歌单",
        id: sheetId,
        description: sheet.description || "",
        musicList: allSongs,
      };
    }

    return { isEnd: true, musicList: [] };
  },

  /**
   * 导入歌单 / 专辑 / 单曲分享
   * 支持三种输入：
   *   1. https://t.kugou.com/xxx  分享短链
   *      - 优先匹配 gcid_xxx 直接走 playlist_gcid
   *      - 否则匹配 special/single/数字 id 走 playlist_songs
   *      - 都匹配不到就调 resolve_share 让后端解析
   *   2. gcid_xxxxxx              直接当 gcid 用
   *   3. 纯数字                   直接当 listid 用
   * @param {string} input 用户输入
   * @returns {Array<object> | null}
   */
  async importMusicSheet(input) {
    const text = String(input == null ? "" : input).trim();
    if (!text) {
      return null;
    }

    let gcid = "";
    let listid = "";

    if (/^https?:\/\//i.test(text)) {
      // 链接形式
      // 先尝试从 URL 里直接抽出 gcid
      const gcidMatch = text.match(/(gcid_[A-Za-z0-9_]+)/);
      if (gcidMatch) {
        gcid = gcidMatch[1];
      } else {
        // 再尝试抽出 listid（数字）
        const listidMatch =
          text.match(/special\/single\/(\d+)/) ||
          text.match(/plist\/list\/(\d+)/) ||
          text.match(/[?&](?:id|specialid|listid)=(\d+)/);
        if (listidMatch) {
          listid = listidMatch[1];
        }
      }
      // 仍然没有就调后端解析短链
      if (!gcid && !listid) {
        try {
          const response = await axios.get(API, {
            params: { action: "resolve_share", url: text },
            timeout: 25000,
          });
          const body = response.data;
          if (body && body.status === 1 && body.data) {
            gcid = body.data.gcid || "";
            listid = body.data.listid || "";
          }
        } catch (e) {
          // 解析失败忽略，下面会返回 null
        }
      }
    } else if (/^gcid_/i.test(text)) {
      // 形如 gcid_xxx
      gcid = text;
    } else {
      // 纯数字当 listid
      const numMatch = text.match(/\d+/);
      if (numMatch) {
        listid = numMatch[0];
      }
    }

    if (!gcid && !listid) {
      return null;
    }

    // 循环分页拉取歌曲列表（gcid 和 listid 走不同的 action）
    const allSongs = [];
    let page = 1;
    while (true) {
      const response = await axios.get(API, {
        params: gcid
          ? {
              action: "playlist_gcid",
              gcid,
              page,
              pagesize: 50,
            }
          : {
              action: "playlist_songs",
              listid,
              page,
              pagesize: 50,
            },
        timeout: 20000,
      });
      const body = response.data;
      if (
        !body ||
        body.code !== 0 ||
        !body.data ||
        !Array.isArray(body.data.songs) ||
        !body.data.songs.length
      ) {
        break;
      }
      allSongs.push(...body.data.songs.map(normalizeSong));
      if (allSongs.length >= (body.data.total || 0) || page >= 10) {
        break;
      }
      page += 1;
    }

    return allSongs.length ? allSongs : null;
  },

  /**
   * 获取专辑详情：直接复用 playlist_songs 接口
   * （酷狗概念版里专辑 ≈ 特殊歌单）
   * @param {{id?: string, albumId?: string, title?: string, artist?: string, artwork?: string}} album
   * @param {number} page 页码
   */
  async getAlbumInfo(album, page) {
    const albumId = album.id || album.albumId || "";
    const response = await axios.get(API, {
      params: {
        action: "playlist_songs",
        listid: String(albumId),
        page: page || 1,
        pagesize: 50,
      },
      timeout: 20000,
    });
    const body = response.data;
    if (
      !body ||
      body.code !== 0 ||
      !body.data ||
      !Array.isArray(body.data.songs)
    ) {
      return { isEnd: true, albumItem: {}, musicList: [] };
    }
    return {
      isEnd: true,
      albumItem: {
        id: String(albumId),
        platform: "Z·酷狗",
        title: album.title || "酷狗歌单",
        artist: album.artist || "",
        artwork: album.artwork || "",
      },
      musicList: body.data.songs.map(normalizeSong),
    };
  },
};
