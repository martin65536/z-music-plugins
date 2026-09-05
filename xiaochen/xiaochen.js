/**
 * xiaochen.js — 云云音乐插件
 * ------------------------------------------------------------------
 * 适用宿主：MusicFree / 同类插件系统
 * 平台标识：云云音乐
 * 原作者：小橙（QQ群 1077835447）
 * 反编译 + 变量重命名 + 注释 by Super Z
 * ------------------------------------------------------------------
 * 架构特点：
 *   - 后端 BASE_URL = http://121.196.228.123:8979（自建代理，阿里云）
 *   - 大部分接口（搜索 / 歌单 / 专辑 / 播放 / 歌词 / 榜单详情）走自建代理
 *   - 少部分接口（歌单分类 / 按标签筛选歌单）直连网易云官方 EAPI
 *   - 内置了大量写死的榜单列表、推荐歌单列表、推荐专辑列表（避免每次都请求后端）
 *   - 有风控机制：60秒内 >5 次 /song 请求会封 IP（12h / 24h / 永久）
 * ------------------------------------------------------------------
 * EAPI 加密算法（网易云官方）：
 *   1. 拼接 [path, JSON.stringify(params)] 数组
 *   2. 计算 MD5("nobody" + path + "use" + JSON + "md5forencrypt")
 *   3. 把 [path, JSON, md5] 用 "-" 分隔，再用 AES-ECB 加密（key="e82ckenh8dichen8"）
 *   4. 密文 hex 大写后作为 params POST 给 interface3.music.163.com/e<path>
 *   5. Cookie 里塞一个默认 MUSIC_U（未登录态），但 env.getUserVariables() 能覆盖
 * ------------------------------------------------------------------
 * ⚠️ 注意：原文件里 getRecommendSheetTags / getRecommendSheetsByTag 被
 *    定义了两次，后一个会覆盖前一个（JS 函数声明提升机制）。
 *    这个"bug"在原混淆版里就存在，本反编译版原样保留。
 * ------------------------------------------------------------------
 * 依赖：axios / crypto-js / dayjs
 */

const axios = require("axios");
const CryptoJs = require("crypto-js");
const dayjs = require("dayjs");

// 后端代理基础地址
const BASE_URL = "http://121.196.228.123:8979";

// 通用请求头
const headers = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// axios 通用配置
const axiosConfig = {
  timeout: 60000,
  maxRedirects: 5,
  maxContentLength: 10485760,
  validateStatus: function (status) {
    return status >= 200 && status < 600;
  },
};

const PAGE_SIZE = 30;

// ============== 网易云 EAPI 加密相关 ==============

// AES-ECB 固定 key（网易写死在前端）
const EAPI_AES_KEY = "e82ckenh8dichen8";

// 默认未登录态 MUSIC_U（用于 EAPI 请求的 Cookie）
const DEFAULT_MUSIC_U =
  "0034B44F9926BE9F1DD236BFB146E0FEB27696AD0802E2DD8D8062B036AD87CE" +
  "EEB49D3141C00C103A8B110C944E6DFA2909843C098EB2515B513BC1AA0A7974" +
  "866D653BEA27F81BF15700FB398CB95ABE260EDA0E71900A46296E8E9C069B6C" +
  "6A3509D1FDE9F41DCEF55B07BEE0990EE13F8A461098536FF86896E76892551C" +
  "C5B8C6C2063E605639146CEF24D2904725876F53C57B442653EA13ACFE9F2653" +
  "B512A23BABE01680F2E953AF4BE1602B38B39B38B1D6D5C50E1F84AAF323D841" +
  "A717DECDF9E0834EF1703C1D4A37DE7DB3AC49FA2A2C397B3418C34FAF191ED0" +
  "64E4F266D94A281B0C08947F339929EE1896350C37FE1E007D32BE2E0C1970DD" +
  "2161A0D87F4A95CEA5B111289EC1064555149DBEEFBF73A1397D5B24EB5B429D" +
  "81C8CBDB2A7DF61BECFAB3DBA3BD165167";

/**
 * MD5 取 hex
 * @param {string} text
 * @returns {string}
 */
function MD5(text) {
  return CryptoJs.MD5(text).toString(CryptoJs.enc.Hex);
}

/**
 * AES-ECB 加密，返回 hex 字符串
 * @param {string} plaintext 待加密文本
 * @returns {string} hex 密文
 */
function AES(plaintext) {
  const keyBytes = CryptoJs.enc.Utf8.parse(EAPI_AES_KEY);
  const plainBytes = CryptoJs.enc.Utf8.parse(plaintext);
  return CryptoJs.AES.encrypt(plainBytes, keyBytes, {
    mode: CryptoJs.mode.ECB,
    padding: CryptoJs.pad.Pkcs7,
  }).ciphertext.toString(CryptoJs.enc.Hex);
}

/**
 * 调用网易云 EAPI 接口
 * 算法：
 *   1. data = [path, JSON.stringify(params)]
 *   2. data.push(MD5("nobody" + data.join("use") + "md5forencrypt"))
 *   3. params = AES(data.join("-36cd479b6b5-")).toUpperCase()
 *   4. POST https://interface3.music.163.com/e<path>
 *
 * Cookie 里的 MUSIC_U 优先取自 env.getUserVariables()（宿主注入的环境变量），
 * 取不到就用默认的未登录态 MUSIC_U
 *
 * @param {string} path   接口路径，如 "/api/playlist/catalogue/v1"
 * @param {object} params 请求参数
 * @returns {Promise<object>} 网易云返回的 JSON
 */
async function EAPI(path, params = {}) {
  let arr = [path, JSON.stringify(params)];
  arr.push(MD5("nobody" + arr.join("use") + "md5forencrypt"));
  const encParams = AES(arr.join("-36cd479b6b5-"));

  // 尝试从宿主环境拿 MUSIC_U
  let musicU = "";
  if (typeof env !== "undefined") {
    try {
      const userVars = env.getUserVariables();
      musicU = userVars.music_u;
    } catch (e) {
      // 忽略
    }
  }

  // 从 musicU 里抽出 MUSIC_U 的值（兼容 "MUSIC_U=xxx" 和纯值两种形式）
  const musicUMatch = String(musicU || "").match(/(MUSIC_[UA]=|^)([^;]+)/i);
  const cookieValue = musicUMatch
    ? "MUSIC_U=" + musicUMatch[1]
    : "MUSIC_U=" + DEFAULT_MUSIC_U;

  const cookie = "os=pc; appver=9.0.25; " + cookieValue;

  const response = await axios({
    url: path.replace("/", "https://interface3.music.163.com/e"),
    method: "POST",
    data: "params=" + encParams.toUpperCase(),
    headers: {
      authority: "music.163.com",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/84.0.4147.135 Safari/537.36",
      Cookie: cookie,
    },
    xsrfCookieName: "XSRF-TOKEN",
    withCredentials: true,
  });
  return response.data;
}

// ============== 数据格式化 ==============

/**
 * 把网易云歌单对象归一化
 * 兼容两种数据来源：playlist detail 接口 和 recommend sheet 接口
 * @param {object} raw 网易云原始歌单对象
 */
function formatSheetItemWy(raw) {
  raw = raw.baseInfo || raw;
  return {
    type: "2",
    id: raw.id || raw.resourceId,
    title: raw.name || raw.title,
    artist:
      (raw.artist && raw.artist.name) ||
      (raw.creator && raw.creator.nickname),
    artwork:
      raw.coverImgUrl || raw.picUrl || raw.coverImg || raw.coverUrl,
    description: raw.description || raw.updateFrequency,
    worksNum: raw.trackCount || (raw.artist && raw.artist.musicSize),
    playCount: raw.playCount,
    date: dayjs
      .unix((raw.updateTime || raw.publishTime) / 1000)
      .format("YYYY-MM-DD"),
    createUserId: raw.userId,
    createTime: raw.createTime,
    content: 2,
  };
}

/**
 * 把歌曲对象归一化成 MusicFree 通用结构
 * 兼容网易云（ar/al/dt）和后端代理（artists/album/duration）两种字段
 * @param {object} raw 原始歌曲对象
 */
function formatMusicItem(raw) {
  const duration = raw.duration || raw.dt || raw.time || 0;
  const item = {
    id: String(raw.id),
    artwork: raw.picUrl || "",
    title: raw.name,
    artist:
      (Array.isArray(raw.ar)
        ? raw.ar.map((a) => a.name).join("/")
        : null) ||
      (Array.isArray(raw.artists)
        ? raw.artists.map((a) => a.name).join("/")
        : null) ||
      (typeof raw.artists === "string" ? raw.artists : null) ||
      raw.artist_string ||
      "未知",
    album:
      (raw.album && raw.album.name ? raw.album.name : null) ||
      (raw.al && raw.al.name ? raw.al.name : null) ||
      (typeof raw.album === "string" ? raw.album : "未知"),
    url: null,
  };
  if (duration > 0) {
    item.duration = duration / 1000;
  }
  return item;
}

/**
 * 把专辑对象归一化
 * @param {object} raw 原始专辑对象
 */
function formatAlbumItem(raw) {
  return {
    id: String(raw.id || raw.playlistId),
    artwork: raw.coverImgUrl || raw.picUrl,
    title: raw.name,
    artist: raw.artist || raw.creator,
    description: raw.description,
    date: raw.publishTime
      ? new Date(raw.publishTime).toISOString().split("T")[0]
      : null,
    worksNum: raw.trackCount || (raw.songs && raw.songs.length) || 0,
  };
}

// ============== 通用请求封装 ==============

/**
 * 调用自建代理后端
 * @param {string} path     路径，如 "/search"
 * @param {object} data     请求体
 * @param {string} method   "post" 或 "get"
 * @returns {Promise<object>} 后端返回的 JSON
 */
async function apiRequest(path, data, method = "post") {
  try {
    const response = await axios({
      method,
      url: "" + BASE_URL + path,
      data,
      headers,
      ...axiosConfig,
    });
    if (response.status < 200 || response.status >= 300) {
      const msg = response.data?.message || "HTTP " + response.status;
      throw new Error(
        "服务器错误: " + msg + " (" + response.status + ")"
      );
    }
    let body = response.data;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body.trim());
      } catch (e) {
        console.warn("[云云音乐] 响应解析并非常规JSON:", e.message);
      }
    }
    return body;
  } catch (err) {
    if (err.code === "ECONNABORTED") {
      throw new Error(
        "请求超时: " + path + " (" + axiosConfig.timeout + "ms)"
      );
    } else if (err.code === "ENOTFOUND") {
      throw new Error("无法连接到服务器: " + BASE_URL);
    } else if (err.response) {
      const status = err.response.status;
      const msg = err.response.data?.message || "HTTP " + status;
      throw new Error("服务器错误: " + msg + " (" + status + ")");
    } else if (err.request) {
      throw new Error("网络错误: 无法连接到服务器");
    } else {
      throw new Error("请求失败: " + err.message);
    }
  }
}

// ============== 搜索 ==============

/**
 * 搜索基础函数
 * @param {string} keyword 关键字
 * @param {number} page    页码（目前后端未实际分页，一次返回所有结果）
 * @param {number} type    搜索类型：1=歌曲 10=专辑 1000=歌单
 */
async function searchBase(keyword, page, type) {
  const params = {
    keywords: keyword,
    limit: PAGE_SIZE,
    type: type || 1,
  };
  try {
    const result = await apiRequest("/search", params);
    if (result && result.success) {
      return {
        data: result.data || [],
        total: (result.data && result.data.length) || 0,
      };
    }
    return { data: [], total: 0 };
  } catch (e) {
    console.error("[云云音乐] 搜索失败: " + e.message);
    throw e;
  }
}

/** 搜歌曲 */
async function searchMusic(keyword, page) {
  const result = await searchBase(keyword, page, 1);
  const data = result.data || [];
  return {
    isEnd:
      page * PAGE_SIZE >= data.length || data.length < PAGE_SIZE,
    data: data.map(formatMusicItem),
  };
}

/** 搜专辑 */
async function searchAlbum(keyword, page) {
  const result = await searchBase(keyword, page, 10);
  const data = result.data || [];
  return {
    isEnd:
      page * PAGE_SIZE >= data.length || data.length < PAGE_SIZE,
    data: data.map(formatAlbumItem),
  };
}

/** 搜歌单 */
async function searchMusicSheet(keyword, page) {
  const result = await searchBase(keyword, page, 1000);
  const data = result.data || [];
  return {
    isEnd:
      page * PAGE_SIZE >= data.length || data.length < PAGE_SIZE,
    data: data.map((p) => ({
      id: String(p.id),
      title: p.name,
      artwork: p.coverImgUrl || p.picUrl,
      artist: (p.creator && p.creator.nickname) || "未知",
      description: p.description,
      worksNum: p.trackCount || 0,
      playCount: p.playCount || 0,
    })),
  };
}

// ============== 歌手作品 ==============

/**
 * 获取歌手作品（歌曲或专辑）
 * 实现方式：用歌手名当关键字去搜索，再过滤出 artist 字段匹配的歌曲
 * 注意：本插件没有真正的「按歌手 ID 查作品」接口，是通过搜索回查实现的
 * @param {{name: string}} artist   歌手对象
 * @param {number}        page     页码
 * @param {string}        category "music" 或 "album"
 */
async function getArtistWorks(artist, page, category) {
  const result = await searchBase(artist.name, page, 1);
  const allSongs = result.data || [];

  // 过滤出 artist 字段里包含歌手名的歌
  const matched = allSongs.filter((song) => {
    const artists = (song.artists || song.artist_string || "").split("/");
    return artists.some((name) => name.trim() === artist.name);
  });

  if (category === "music") {
    return {
      isEnd: page * PAGE_SIZE >= matched.length,
      data: matched.map(formatMusicItem),
    };
  } else if (category === "album") {
    // 把歌曲按 album 字段分组，聚合成专辑列表
    const albumMap = new Map();
    matched.forEach((song) => {
      const albumName = song.album;
      if (!albumMap.has(albumName)) {
        albumMap.set(albumName, {
          id: song.id,
          name: albumName,
          artist: artist.name,
          picUrl: song.picUrl,
          trackCount: 1,
          songs: [song],
        });
      } else {
        const entry = albumMap.get(albumName);
        entry.trackCount++;
        entry.songs.push(song);
      }
    });
    return {
      isEnd: page * PAGE_SIZE >= albumMap.size,
      data: Array.from(albumMap.values()).map(formatAlbumItem),
    };
  }
  return { isEnd: true, data: [] };
}

// ============== 歌单详情 ==============

/**
 * 获取歌单详情（旧版实现，被 getMusicSheetInfoNew 覆盖）
 * 本函数在文件里被定义但未被导出使用（导出时用了 getMusicSheetInfoNew）
 * @param {{id: string}} sheet  歌单对象
 * @param {number}       page   页码
 */
async function getPlaylistDetail(sheet, page) {
  try {
    if (!sheet || !sheet.id) {
      throw new Error("歌单项缺少ID");
    }
    const params = { id: String(sheet.id) };
    console.log("[云云音乐] 请求歌单详情: ID=" + params.id);

    const result = await apiRequest("/playlist", params);
    console.log(
      "[云云音乐] API响应: success=" +
        result.success +
        ", status=" +
        result.status
    );

    // 兼容两种返回结构
    let playlist = null;
    if (result && result.success && result.data && result.data.playlist) {
      playlist = result.data.playlist;
    } else if (result && result.success && result.data && result.data.id) {
      playlist = result.data;
    }

    if (!playlist) {
      console.error(
        "[云云音乐] 无法解析歌单数据，响应内容:",
        JSON.stringify(result).substring(0, 200)
      );
      throw new Error("无法解析歌单数据: ID=" + params.id);
    }

    // 解析 creator 字段（可能是字符串或对象）
    let creatorName = "";
    let creatorId = "unknown";
    if (typeof playlist.creator === "string") {
      creatorName = playlist.creator;
    } else if (playlist.creator && typeof playlist.creator === "object") {
      creatorName = playlist.creator.nickname || playlist.creator.name || "未知";
      creatorId = String(playlist.creator.userId || playlist.creator.id || "unknown");
    } else {
      creatorName = "未知";
    }

    // 格式化歌曲列表
    const musicList = (playlist.tracks || []).map((track) => {
      const duration = track.dt || track.time || 0;
      const item = {
        id: String(track.id),
        title: track.name,
        artist:
          track.artists ||
          track.artist_string ||
          (track.ar ? track.ar.map((a) => a.name).join("/") : null) ||
          "未知",
        album:
          track.album ||
          (track.al ? track.al.name : null) ||
          "未知",
        artwork: track.picUrl || (track.al ? track.al.picUrl : null) || "",
      };
      if (duration > 0) {
        item.duration = duration / 1000;
      }
      return item;
    });

    console.log(
      "[云云音乐] 获取歌单成功: " +
        playlist.name +
        ", 歌曲" +
        musicList.length +
        "首"
    );

    return {
      isEnd: true,
      musicList,
      detail: {
        id: String(playlist.id),
        name: playlist.name || "未知歌单",
        coverImg: playlist.coverImgUrl || playlist.coverImg || "",
        coverImgUrl: playlist.coverImgUrl || playlist.coverImg || "",
        description: playlist.description || "",
        creator: { name: creatorName, id: creatorId },
        trackCount: playlist.trackCount || musicList.length,
        playCount: playlist.playCount || 0,
        createTime: playlist.createTime || 0,
        tags: playlist.tags || [],
        subscribedCount: playlist.subscribedCount || 0,
        commentCount: playlist.commentCount || 0,
      },
    };
  } catch (e) {
    console.error("[云云音乐] 获取歌单详情失败:", e.message);
    console.error("[云云音乐] 错误堆栈:", e.stack);
    return { isEnd: true, musicList: [] };
  }
}

// ============== 专辑详情 ==============

/**
 * 获取专辑详情
 * @param {{id: string}} album  专辑对象
 * @param {number}       page   页码（专辑一次性返回所有，不分页）
 */
async function getAlbumInfo(album, page) {
  try {
    if (!album || !album.id) {
      throw new Error("专辑项缺少ID");
    }
    const params = { id: String(album.id) };
    console.log("[云云音乐] 获取专辑详情: ID=" + params.id);

    const response = await axios.post(BASE_URL + "/album", params, {
      headers,
    });
    const body = response.data;

    let albumData = null;
    let songs = null;
    if (body && body.success && body.data && body.data.album) {
      albumData = body.data.album;
      songs = albumData.songs || body.data.songs || [];
    }

    if (!albumData || !albumData.id) {
      console.error("[云云音乐] 无法解析专辑数据");
      return { isEnd: true, musicList: [] };
    }
    console.log("[云云音乐] 专辑详情获取成功: " + albumData.name);

    if (songs && Array.isArray(songs) && songs.length > 0) {
      const musicList = songs.map((song) => ({
        id: String(song.id),
        title: song.name,
        artist:
          song.artists ||
          (song.ar ? song.ar.map((a) => a.name).join("/") : null) ||
          albumData.artist ||
          "未知",
        album: albumData.name,
        artwork:
          albumData.coverImgUrl ||
          albumData.picUrl ||
          (song.al ? song.al.picUrl : null) ||
          "",
        duration: song.dt
          ? song.dt / 1000
          : song.time
          ? song.time / 1000
          : 0,
      }));
      return { isEnd: true, musicList };
    } else {
      console.warn("[云云音乐] 专辑没有歌曲数据");
      return { isEnd: true, musicList: [] };
    }
  } catch (e) {
    console.error("[云云音乐] 获取专辑详情失败:", e.message);
    return { isEnd: true, musicList: [] };
  }
}

// ============== 播放 URL ==============

/**
 * 获取播放 URL
 * ⚠️ 注意：后端有风控，60秒内调 /song 超过 5 次会被封 IP
 * @param {{id: string, duration?: number}} song    歌曲对象
 * @param {string}                            quality 音质档位
 */
async function getMediaSource(song, quality) {
  try {
    const params = { id: String(song.id) };
    const response = await axios.post(BASE_URL + "/song", params, { headers });
    const body = response.data;

    if (body && body.success && body.data && body.data.url) {
      const data = body.data;
      const result = {
        url: data.url,
        quality: quality || data.level || "standard",
        bitRate: data.bitrate || 0,
        size: data.size || 0,
        level: data.level || quality || "standard",
        quality_name: data.quality_name || "",
        type: data.type || "mp3",
      };
      if (song.duration > 0) {
        result.duration = song.duration;
      }
      return result;
    }

    console.warn(
      "[云云音乐] 无法获取歌曲 " + song.id + " 的播放链接"
    );
    return null;
  } catch (e) {
    console.warn("[云云音乐] 获取播放链接失败", e.message);
    return null;
  }
}

/**
 * 获取单曲详情（复用 /song 接口）
 * @param {{id: string}} song 歌曲对象
 */
async function getSongDetail(song) {
  try {
    const params = { id: String(song.id) };
    const response = await axios.post(BASE_URL + "/song", params, { headers });
    const body = response.data;

    if (body && body.success && body.data) {
      const data = body.data;
      const result = {
        id: String(data.id || song.id),
        title: song.title,
        artist: song.artist,
        album: song.album,
        artwork: song.artwork,
        bitRate: data.bitrate || 0,
        size: data.size || 0,
        level: data.level || "standard",
        quality_name: data.quality_name || "",
        type: data.type || "mp3",
        url: data.url || null,
      };
      if (song.duration > 0) {
        result.duration = song.duration;
      }
      return result;
    }
    return song;
  } catch (e) {
    console.warn("获取歌曲详情失败", e.message);
    return song;
  }
}

// ============== 歌词 ==============

/**
 * 获取歌词（也走 /song 接口，传 type=lyric）
 * 返回包含原文 / 翻译 / 罗马音 / 卡拉OK 四种歌词
 * @param {{id: string}} song 歌曲对象
 */
async function getLyric(song) {
  try {
    const params = { id: String(song.id), type: "lyric" };
    const response = await axios.post(BASE_URL + "/song", params, { headers });
    const body = response.data;

    if (body && body.success && body.data) {
      const data = body.data;
      return {
        rawLrc: (data.lrc && data.lrc.lyric) || "",
        translation:
          (data.tlyric && data.tlyric.lyric) ||
          (data.romalrc && data.romalrc.lyric) ||
          "",
        romalrc: (data.romalrc && data.romalrc.lyric) || "",
        klyric: (data.klyric && data.klyric.lyric) || "",
      };
    }
    return { rawLrc: "", translation: "", romalrc: "", klyric: "" };
  } catch (e) {
    console.warn("[云云音乐] 获取歌词失败", e.message);
    return { rawLrc: "", translation: "", romalrc: "", klyric: "" };
  }
}

// ============== 内置榜单/推荐数据 ==============
// 这部分数据是写死的，不走后端，避免每次都请求

/**
 * 内置推荐歌单列表（10 个固定歌单）
 * 这些数据写死在代码里，避免每次都请求后端
 */
async function getBuiltInPlaylists() {
  const playlists = [
    {
      id: "2809577409",
      name: "网易云欧美新歌榜",
      coverImgUrl:
        "https://p1.music.126.net/0lPWpI9Ejn1OiW2LSbg-qw==/109951167430863224.jpg",
      creator: "网易云音乐",
      description:
        "网易云用户一周内收听所有欧美新歌（一月内最新发行）官方TOP排行榜，每天更新。",
      trackCount: 100,
    },
    {
      id: "71385702",
      name: "网易云ACG榜",
      coverImgUrl:
        "https://p1.music.126.net/na1kEeCS1iZEkzOrs9r_9g==/109951167976973667.jpg",
      creator: "网易云音乐",
      description:
        "网易云用户一周内收听所有ACG音乐官方TOP排行榜，每周四更新。",
      trackCount: 100,
    },
    {
      id: "112504",
      name: "中国TOP排行榜（港台榜）",
      coverImgUrl:
        "https://p1.music.126.net/JPh-zekmt0sW2Z3TZMsGzA==/18967675090783713.jpg",
      creator: "中国TOP排行榜",
      description: "中国TOP排行榜分成内地榜及港台榜，每周一更新。",
      trackCount: 12,
    },
    {
      id: "3812895",
      name: "Beatport全球电子舞曲榜",
      coverImgUrl:
        "https://p1.music.126.net/oT-RHuPBJiD7WMoU7WG5Rw==/109951166093489621.jpg",
      creator: "云音乐电音星球",
      description: "Beatport全球电子舞曲排行榜TOP100（本榜每周三更新）",
      trackCount: 92,
    },
    {
      id: "2809513713",
      name: "网易云欧美热歌榜",
      coverImgUrl:
        "https://p1.music.126.net/70_EO_Dc7NT_hhfvsapzcQ==/109951167430862162.jpg",
      creator: "网易云音乐",
      description:
        "网易云用户一周内收听所有欧美歌曲官方TOP排行榜，每周四更新。",
      trackCount: 200,
    },
    {
      id: "745956260",
      name: "网易云韩语榜",
      coverImgUrl:
        "https://p1.music.126.net/5oN9YaFznwNGXkmi8i2Ytw==/109951167430864741.jpg",
      creator: "网易云音乐",
      description:
        "网易云用户一周内收听所有韩语歌曲官方TOP排行榜，每周四更新。",
      trackCount: 100,
    },
    {
      id: "991319590",
      name: "网易云中文说唱榜",
      coverImgUrl:
        "https://p1.music.126.net/GgHbgDfGXHpE2YTchU7IvA==/109951171510498108.jpg",
      creator: "网易云音乐",
      description: "网易云原创说唱音乐人作品官方榜单，每周五更新。",
      trackCount: 50,
    },
    {
      id: "2617766278",
      name: "新声榜",
      coverImgUrl:
        "https://p1.music.126.net/XbjRDARP1xv5a-40ZDOy6A==/109951163785427934.jpg",
      creator: "LOOK直播官方频道",
      description:
        "LOOK直播 - 「LOOK新声代2」活动官方榜单，旨在推介超人气单曲和小众优质原创～",
      trackCount: 36,
    },
  ];

  return playlists.map((p) => ({
    id: String(p.id),
    artwork: p.coverImgUrl,
    title: p.name,
    artist: p.creator,
    description: p.description,
    date: null,
    worksNum: p.trackCount,
  }));
}

/**
 * 内置榜单列表（官方榜 + 全球榜）
 * @returns {{official: Array, global: Array}}
 */
async function getBuiltInTopLists() {
  const official = [
    {
      id: "19723756",
      name: "飙升榜",
      coverImgUrl:
        "https://p1.music.126.net/rIi7Qzy2i2Y_1QD7cd0MYA==/109951170048506929.jpg",
      creator: "网易云音乐",
      description: "云音乐中每天热度上升最快的100首单曲，每日更新。",
      trackCount: 100,
    },
    {
      id: "3779629",
      name: "新歌榜",
      coverImgUrl:
        "https://p1.music.126.net/5guhqPBTcIrrhLBotgaT6w==/109951170048511751.jpg",
      creator: "网易云音乐",
      description:
        "云音乐新歌榜：云音乐用户一周内收听所有新歌（一月内最新发行）官方TOP排行榜，每天更新。",
      trackCount: 100,
    },
    {
      id: "2884035",
      name: "原创榜",
      coverImgUrl:
        "https://p1.music.126.net/BaP9nrocNTL3gGThysv4eQ==/109951170091896587.jpg",
      creator: "网易云音乐",
      description:
        "云音乐独立原创音乐人作品官方榜单，以推荐优秀原创作品为目的。每周四网易云音乐首发。",
      trackCount: 100,
    },
    {
      id: "3778678",
      name: "热歌榜",
      coverImgUrl:
        "https://p1.music.126.net/0SUEG8yDACfx0Bw2MYFv4Q==/109951170048519512.jpg",
      creator: "网易云音乐",
      description:
        "云音乐热歌榜：云音乐用户一周内收听所有线上歌曲官方TOP排行榜，每日更新。",
      trackCount: 200,
    },
  ];

  const global = [
    {
      id: "60198",
      name: "美国Billboard榜",
      coverImgUrl:
        "https://p1.music.126.net/rwRsVIJHQ68gglhA6TNEYA==/109951165611413732.jpg",
      creator: "网易云音乐",
      description: "美国Billboard排行榜",
      trackCount: 87,
    },
    {
      id: "3812895",
      name: "Beatport全球电子舞曲榜",
      coverImgUrl:
        "https://p1.music.126.net/oT-RHuPBJiD7WMoU7WG5Rw==/109951166093489621.jpg",
      creator: "网易云音乐",
      description: "Beatport全球电子舞曲排行榜TOP100（本榜每周三更新）",
      trackCount: 92,
    },
    {
      id: "60131",
      name: "日本Oricon榜",
      coverImgUrl:
        "https://p1.music.126.net/aXUPgImt8hhf4cMUZEjP4g==/109951165611417794.jpg",
      creator: "网易云音乐",
      description: "日本Oricon数字单曲周榜，每周三更新，欢迎关注。",
      trackCount: 34,
    },
    {
      id: "2809577409",
      name: "网易云欧美新歌榜",
      coverImgUrl:
        "https://p1.music.126.net/0lPWpI9Ejn1OiW2LSbg-qw==/109951167430863224.jpg",
      creator: "网易云音乐",
      description:
        "网易云用户一周内收听所有欧美新歌（一月内最新发行）官方TOP排行榜，每天更新。",
      trackCount: 100,
    },
    {
      id: "2809513713",
      name: "网易云欧美热歌榜",
      coverImgUrl:
        "https://p1.music.126.net/70_EO_Dc7NT_hhfvsapzcQ==/109951167430862162.jpg",
      creator: "网易云音乐",
      description:
        "网易云用户一周内收听所有欧美歌曲官方TOP排行榜，每周四更新。",
      trackCount: 200,
    },
    {
      id: "745956260",
      name: "网易云韩语榜",
      coverImgUrl:
        "https://p1.music.126.net/5oN9YaFznwNGXkmi8i2Ytw==/109951167430864741.jpg",
      creator: "网易云音乐",
      description:
        "网易云用户一周内收听所有韩语歌曲官方TOP排行榜，每周四更新。",
      trackCount: 100,
    },
    {
      id: "2617766278",
      name: "新声榜",
      coverImgUrl:
        "https://p1.music.126.net/XbjRDARP1xv5a-40ZDOy6A==/109951163785427934.jpg",
      creator: "网易云音乐",
      description:
        "LOOK直播 - 「LOOK新声代2」活动官方榜单，旨在推介超人气单曲和小众优质原创～",
      trackCount: 36,
    },
    {
      id: "71385702",
      name: "网易云ACG榜",
      coverImgUrl:
        "https://p1.music.126.net/na1kEeCS1iZEkzOrs9r_9g==/109951167976973667.jpg",
      creator: "网易云音乐",
      description:
        "网易云用户一周内收听所有ACG音乐官方TOP排行榜，每周四更新。",
      trackCount: 100,
    },
    {
      id: "991319590",
      name: "网易云中文说唱榜",
      coverImgUrl:
        "https://p1.music.126.net/GgHbgDfGXHpE2YTchU7IvA==/109951171510498108.jpg",
      creator: "网易云音乐",
      description: "网易云原创说唱音乐人作品官方榜单，每周五更新。",
      trackCount: 50,
    },
  ];

  return { official, global };
}

/**
 * 内置推荐歌单（15 个，写死）
 * 注意：这些歌单 ID 看起来是新注册账号的私人歌单，不是官方推荐位
 */
async function getRecommendPlaylists(page) {
  const playlists = [
    {
      id: "17735435372",
      name: "新年舞曲派对 | 一键开启新年狂欢模式",
      coverImgUrl:
        "http://p1.music.126.net/uohkI810frZqLXR5razTOg==/109951172718659600.jpg",
      creator: "云音乐每时每刻",
      description: "播放量: 13764",
      worksNum: 100,
    },
    {
      id: "14303468640",
      name: "2016伤感热播 | 和郭顶一起聆听2016凄美情歌",
      coverImgUrl:
        "http://p1.music.126.net/OiBNf44L17CZ5QVJI5IlaA==/109951172032225131.jpg",
      creator: "云音乐每时每刻",
      description: "播放量: 13万",
      worksNum: 100,
    },
    {
      id: "8151167145",
      name: "听李荣浩热门精选",
      coverImgUrl:
        "http://p1.music.126.net/2Ezh9WK8vIAXHI9hMJj4SQ==/109951168608930118.jpg",
      creator: "云音乐艺人精选",
      description: "播放量: 479万",
      worksNum: 100,
    },
    {
      id: "8497844200",
      name: "重返2015 | 从林俊杰开启2015聆听之旅",
      coverImgUrl:
        "http://p1.music.126.net/LxZ5HpNhSscZai_uW-HaIQ==/109951172153010313.jpg",
      creator: "云音乐经典专区",
      description: "播放量: 58万",
      worksNum: 100,
    },
    {
      id: "17735570368",
      name: "2025宝岛热播 | 从张震岳开始畅听2025宝岛热歌",
      coverImgUrl:
        "http://p1.music.126.net/dIqHTT5gwn6YHNMm3Hqi8Q==/109951172702578129.jpg",
      creator: "云村听见宝岛",
      description: "播放量: 1828",
      worksNum: 100,
    },
    {
      id: "9364024209",
      name: "KTV必唱金曲 | 经典流行 陪你畅歌一整天",
      coverImgUrl:
        "http://p1.music.126.net/iKITgbbs5zCHjq2PhMnyEg==/109951171535890911.jpg",
      creator: "云音乐经典专区",
      description: "播放量: 208万",
      worksNum: 50,
    },
    {
      id: "14303883649",
      name: "重返2022 | 从邓紫棋开始回顾那年热播",
      coverImgUrl:
        "http://p1.music.126.net/-kUP0s8S0r7Fw5dESvWzSQ==/109951172236541481.jpg",
      creator: "云音乐经典专区",
      description: "播放量: 71764",
      worksNum: 100,
    },
    {
      id: "6957248137",
      name: "重返1998 | 王菲那英与你相约一九九八",
      coverImgUrl:
        "http://p1.music.126.net/zb0ryzXrOXRXfo2YBaxqcg==/109951170927280927.jpg",
      creator: "云音乐经典专区",
      description: "播放量: 70万",
      worksNum: 100,
    },
    {
      id: "7694448425",
      name: "听王心凌热门精选",
      coverImgUrl:
        "http://p1.music.126.net/A75Qy9RBCpHb8ItfFC6Siw==/109951172068967152.jpg",
      creator: "云音乐艺人精选",
      description: "播放量: 85万",
      worksNum: 100,
    },
    {
      id: "17535575426",
      name: "新年接暴富 | 八方来财！高能招财显化曲",
      coverImgUrl:
        "http://p1.music.126.net/F0pG8if6Dt170BMgKO84aA==/109951172459186085.jpg",
      creator: "云音乐官方歌单",
      description: "播放量: 53470",
      worksNum: 30,
    },
    {
      id: "14432833653",
      name: "走路听老歌 | 带上快乐的经典旋律出发",
      coverImgUrl:
        "http://p1.music.126.net/OnphdXUr3JSMXzuGGGedsg==/109951172174682620.jpg",
      creator: "云音乐经典专区",
      description: "播放量: 20万",
      worksNum: 80,
    },
    {
      id: "9085528202",
      name: "日落飞车 | 让松弛旋律和惬意晚风陪伴归途",
      coverImgUrl:
        "http://p1.music.126.net/NvdZE9sSjS2bRLIHoh8k2g==/109951172413587482.jpg",
      creator: "云音乐官方歌单",
      description: "播放量: 16万",
      worksNum: 50,
    },
    {
      id: "7308142944",
      name: "浪漫因子 | 可以邀请你和我一起去春天吗",
      coverImgUrl:
        "http://p1.music.126.net/45DQTB5MuaF5nG8HOB7ciA==/109951168605304414.jpg",
      creator: "云音乐官方歌单",
      description: "播放量: 854万",
      worksNum: 60,
    },
    {
      id: "2829883282",
      name: "华语私人雷达 | 最懂你的华语推荐 每日更新35首",
      coverImgUrl:
        "http://p1.music.126.net/NaSOolKiCwxsljTiMWImTg==/109951169058725193.jpg",
      creator: "云音乐官方歌单",
      description: "播放量: 25.2亿",
      worksNum: 35,
    },
    {
      id: "8497858200",
      name: "重返2014 | 和徐佳莹一起重回2014",
      coverImgUrl:
        "http://p1.music.126.net/bcy5bOfo-ti2-PwdBVykqQ==/109951170963208385.jpg",
      creator: "云音乐经典专区",
      description: "播放量: 38万",
      worksNum: 100,
    },
  ];

  return {
    isEnd: true,
    data: playlists.map((p) => ({
      id: String(p.id),
      artwork: p.coverImgUrl,
      title: p.name,
      artist: p.creator,
      description: p.description,
      worksNum: p.worksNum,
    })),
  };
}

/**
 * 内置推荐专辑（4 张周杰伦专辑，写死）
 */
async function getRecommendAlbums(page) {
  const albums = [
    {
      id: "34720827",
      name: "周杰伦的床边故事",
      artist: "周杰伦",
      coverImgUrl:
        "https://p3.music.126.net/cUTk0ewrQtYGP2YpPZoUng==/3265549553028224.jpg",
      description: "2016年发行，共10首歌曲",
      publishTime: 1466697600007,
      trackCount: 10,
    },
    {
      id: "3812895",
      name: "周杰伦的杰作",
      artist: "周杰伦",
      coverImgUrl:
        "https://p4.music.126.net/cUTk0ewrQtYGP2YpPZoUng==/3265549553028224.jpg",
      description: "经典专辑精选",
      publishTime: 0,
      trackCount: 20,
    },
    {
      id: "32311",
      name: "叶惠美",
      artist: "周杰伦",
      coverImgUrl:
        "https://p2.music.126.net/cUTk0ewrQtYGP2YpPZoUng==/3265549553028224.jpg",
      description: "2003年发行，共11首歌曲",
      publishTime: 1057574400000,
      trackCount: 11,
    },
    {
      id: "347230",
      name: "魔杰座",
      artist: "周杰伦",
      coverImgUrl:
        "https://p1.music.126.net/cUTk0ewrQtYGP2YpPZoUng==/3265549553028224.jpg",
      description: "2008年发行，共11首歌曲",
      publishTime: 1228089600000,
      trackCount: 11,
    },
  ];
  return {
    isEnd: true,
    data: albums.map(formatAlbumItem),
  };
}

// ============== 榜单 ==============

/**
 * 获取榜单分组列表（官方榜 + 全球榜）
 */
async function getTopLists() {
  const { official, global } = await getBuiltInTopLists();
  const officialList = official.map((t) => ({
    type: "3",
    id: String(t.id),
    title: t.name,
    coverImg: t.coverImgUrl,
    artist: t.creator,
    description: t.description,
    worksNum: 100,
  }));
  const globalList = global.map((t) => ({
    type: "3",
    id: String(t.id),
    title: t.name,
    coverImg: t.coverImgUrl,
    artist: t.creator,
    description: t.description,
    worksNum: 100,
  }));
  return [
    { title: "官方榜", data: officialList },
    { title: "全球榜", data: globalList },
  ];
}

/**
 * 获取榜单详情：复用 getPlaylistDetail（榜单在网易云内部就是特殊歌单）
 * @param {{id: string, title?: string}} topList 榜单对象
 */
async function getTopListDetail(topList) {
  try {
    console.log(
      "[云云音乐] 获取榜单详情: " + (topList.title || topList.id)
    );
    if (!topList || !topList.id) {
      throw new Error("榜单项缺少ID");
    }
    const detail = await getPlaylistDetail(topList, 1);
    if (!detail || !detail.detail) {
      throw new Error(
        "获取榜单详情失败（ID: " + topList.id + "）"
      );
    }
    console.log("[云云音乐] 榜单详情获取成功: " + detail.detail.name);

    return {
      topListItem: {
        id: detail.detail.id,
        title: detail.detail.name,
        name: detail.detail.name,
        coverImg:
          detail.detail.coverImgUrl || detail.detail.coverImg || "",
        coverImgUrl:
          detail.detail.coverImgUrl || detail.detail.coverImg || "",
        type: "3",
        artist: (detail.detail.creator && detail.detail.creator.name) || "未知",
        description: detail.detail.description || "",
        trackCount: detail.detail.trackCount || 0,
        updateFrequency: "",
        updateTime: detail.detail.updateTime || 0,
      },
      musicList: detail.musicList || [],
      tracks: detail.musicList || [],
      isEnd: detail.isEnd !== false,
    };
  } catch (e) {
    console.error("[云云音乐] 获取榜单详情失败:", e.message);
    console.error("[云云音乐] 错误堆栈:", e.stack);
    throw e;
  }
}

// ============== 搜索入口 ==============

/**
 * 搜索入口：按 type 路由到具体实现
 * @param {string} keyword    关键字
 * @param {number} page       页码
 * @param {string} searchType "music" / "album" / "artist" / "sheet"
 */
async function search(keyword, page, searchType) {
  switch (searchType) {
    case "music":
      return await searchMusic(keyword, page);
    case "album":
      return await searchAlbum(keyword, page);
    case "artist":
      return await searchArtist(keyword, page);
    default:
      return await searchMusic(keyword, page);
  }
}

/**
 * 搜歌手（实现简陋：复用歌曲搜索，把结果按 artist 聚合）
 * 注意：原代码里没有单独定义 searchArtist，这里靠搜索歌曲后聚合实现
 */
async function searchArtist(keyword, page) {
  const result = await searchBase(keyword, page, 1);
  const songs = result.data || [];
  const artistMap = new Map();
  songs.forEach((song) => {
    const artists = (song.artists || song.artist_string || "").split("/");
    artists.forEach((name) => {
      const trimmed = name.trim();
      if (trimmed && !artistMap.has(trimmed)) {
        artistMap.set(trimmed, {
          id: String(song.id),
          name: trimmed,
          avatar: song.picUrl,
          worksNum: 1,
        });
      } else if (artistMap.has(trimmed)) {
        artistMap.get(trimmed).worksNum++;
      }
    });
  });
  return {
    isEnd: page * PAGE_SIZE >= artistMap.size,
    data: Array.from(artistMap.values()),
  };
}

// ============== 链接解析与导入 ==============

/**
 * 解析网易云分享链接
 * 支持识别 4 种 URL 形式：
 *   - /playlist?id=xxx  歌单
 *   - /song?id=xxx      歌曲
 *   - /album?id=xxx     专辑
 *   - /artist?id=xxx    歌手
 * @param {string} url 用户输入的 URL
 * @returns {{id: string, type: string, originalUrl: string} | null}
 */
function parseNeteaseUrl(url) {
  if (!url || typeof url !== "string") {
    console.error("[云云音乐] 无效的URL:", url);
    return null;
  }
  const patterns = [
    { regex: /\/playlist\?id=(\d+)/, type: "playlist" },
    { regex: /\/song\?id=(\d+)/, type: "song" },
    { regex: /\/album\?id=(\d+)/, type: "album" },
    { regex: /\/artist\?id=(\d+)/, type: "artist" },
  ];
  for (const { regex, type } of patterns) {
    const match = url.match(regex);
    if (match && match[1]) {
      console.log("[云云音乐] 解析成功: " + type + ", ID=" + match[1]);
      return { id: match[1], type, originalUrl: url };
    }
  }
  console.error("[云云音乐] 无法解析URL:", url);
  return null;
}

/**
 * 导入歌单
 * 支持两种输入：
 *   1. 纯数字（如 2809577409）
 *   2. 网易云歌单 URL（含 music.163.com）
 * @param {string} input
 */
async function importMusicSheet(input) {
  try {
    console.log("[云云音乐] 开始导入歌单: " + input);

    // 先尝试纯数字
    let sheetId = (input.match(/^(\d+)$/) || [])[1];

    // 不是纯数字且不含 music.163.com → 无法识别
    if (!sheetId && !input.match(/music\.163\.com/i)) {
      console.error("[云云音乐] 无法识别的链接格式");
      return false;
    }

    // 从 URL 里抽 playlist ID
    if (!sheetId) {
      sheetId = (
        input.match(/playlist(\/|.*?[\?\&]id=)(\d+)/i) || []
      )[2];
    }

    if (!sheetId) {
      console.error("[云云音乐] 无法提取歌单ID");
      return false;
    }

    console.log("[云云音乐] 歌单ID: " + sheetId);

    try {
      const { musicList } = await getMusicSheetInfoNew({ id: sheetId }, 1);
      if (musicList && musicList.length > 0) {
        console.log(
          "[云云音乐] 导入成功: 歌曲" + musicList.length + "首"
        );
        return musicList;
      } else {
        console.error("[云云音乐] 导入失败: 未获取到歌曲");
        return false;
      }
    } catch (e) {
      console.error("[云云音乐] 导入失败:", e.message);
      return false;
    }
  } catch (e) {
    console.error("[云云音乐] 导入歌单失败:", e.message);
    return false;
  }
}

/**
 * 导入单曲
 * @param {string} input URL 或纯数字 ID
 */
async function importMusicItem(input) {
  try {
    const parsed = parseNeteaseUrl(input);
    if (!parsed) {
      console.error("[云云音乐] 无效的链接");
      return false;
    }

    if (parsed.type === "song") {
      // 抽歌曲 ID
      const songId = (
        input.match(/song(.*?[\?\&]id=|\/)(\d+)/i) || []
      )[2];
      if (!songId) {
        return false;
      }
      const detail = await getSongDetail({ id: songId });
      return [detail];
    } else if (parsed.type === "playlist") {
      // 歌单链接走 importMusicSheet
      return await importMusicSheet(input);
    } else {
      console.error("[云云音乐] 暂不支持导入此类型链接");
      return false;
    }
  } catch (e) {
    console.error("[云云音乐] 导入歌曲失败:", e.message);
    return false;
  }
}

// ============== 歌单分类标签（第一版定义，会被后面的覆盖）==============

/**
 * ⚠️ 注意：本函数在文件后面又被重新定义了一次，由于 JS 函数声明提升机制
 * 后一个定义会覆盖本定义。本函数实际不会被执行。
 * 保留是为了让代码与原混淆版结构一致。
 */
async function getRecommendSheetTags() {
  const pinned = [
    { title: "推荐", id: "_SPECIAL_CLOUD_VILLAGE_PLAYLIST" },
    { title: "官方", id: "官方" },
    { title: "雷达", id: "_RADAR" },
    { title: "原创", id: "_SPECIAL_ORIGIN_SONG_LOCATION" },
    { title: "心情", id: "_FEELING_PLAYLIST_LOCATION" },
    { title: "场景", id: "_SCENE_PLAYLIST_LOCATION" },
    { title: "专属", id: "_COMBINATION" },
    { title: "全部", id: "全部歌单" },
    { title: "新热", id: "_NEW_SONG_AND_ALBUM" },
    { title: "影视", id: "_FIRM_PLAYLIST" },
    { title: "奖项", id: "_AWARDS_PLAYLIST" },
  ];

  const groups = [
    { title: "语种", data: [] },
    { title: "风格", data: [] },
    { title: "场景", data: [] },
    { title: "情感", data: [] },
    { title: "主题", data: [] },
  ];

  // 语种
  groups[0].data = [
    { title: "华语", id: "华语" },
    { title: "欧美", id: "欧美" },
    { title: "日语", id: "日语" },
    { title: "韩语", id: "韩语" },
    { title: "粤语", id: "粤语" },
  ];
  // 风格
  groups[1].data = [
    { title: "流行", id: "流行" },
    { title: "摇滚", id: "摇滚" },
    { title: "民谣", id: "民谣" },
    { title: "电子", id: "电子" },
    { title: "说唱", id: "说唱" },
    { title: "轻音乐", id: "轻音乐" },
    { title: "古典", id: "古典" },
    { title: "爵士", id: "爵士" },
    { title: "R&B", id: "R&B" },
    { title: "古风", id: "古风" },
    { title: "二次元", id: "二次元" },
  ];
  // 场景
  groups[2].data = [
    { title: "运动", id: "运动" },
    { title: "通勤", id: "通勤" },
    { title: "工作", id: "工作" },
    { title: "学习", id: "学习" },
    { title: "睡前", id: "睡前" },
  ];
  // 情感
  groups[3].data = [
    { title: "快乐", id: "快乐" },
    { title: "伤感", id: "伤感" },
    { title: "治愈", id: "治愈" },
    { title: "怀旧", id: "怀旧" },
    { title: "浪漫", id: "浪漫" },
  ];
  // 主题
  groups[4].data = [
    { title: "影视", id: "影视" },
    { title: "动漫", id: "动漫" },
    { title: "游戏", id: "游戏" },
    { title: "节日", id: "节日" },
    { title: "旅行", id: "旅行" },
  ];

  return { pinned, data: groups };
}

/**
 * ⚠️ 注意：本函数也会被后面的定义覆盖
 */
async function getRecommendSheetsByTag(tag, page) {
  const all = await getBuiltInPlaylists();
  const filtered = all.filter((item) => {
    if (!tag) return true;
    const text = item.title || item.description || "";
    return text.includes(tag);
  });
  return {
    isEnd: true,
    data: filtered.slice(0, 10),
  };
}

// ============== 歌单详情（新版实现，被导出使用）==============

/**
 * 获取歌单详情（新版实现，替代 getPlaylistDetail）
 * 后端一次性返回所有 tracks，所以第一页返回全部，后续页返回空
 * @param {{id: string}} sheet  歌单对象
 * @param {number}        page  页码
 */
async function getMusicSheetInfoNew(sheet, page = 1) {
  try {
    console.log(
      "[云云音乐] getMusicSheetInfo: ID=" + sheet.id + ", page=" + page
    );

    const params = { id: String(sheet.id) };
    const result = await apiRequest("/playlist", params);

    if (result) {
      console.log("[DEBUG] result keys: " + Object.keys(result));
      if (result.data) {
        console.log(
          "[DEBUG] result.data keys: " + Object.keys(result.data)
        );
      }
    } else {
      console.log("[DEBUG] result is null");
    }

    // 兼容两种返回结构
    let playlist = null;
    if (result && result.success && result.data && result.data.playlist) {
      playlist = result.data.playlist;
    } else if (result && result.success && result.data && result.data.id) {
      playlist = result.data;
    }

    if (!playlist) {
      console.error("[云云音乐] 无法解析歌单数据");
      return { isEnd: true, sheetItem: {}, musicList: [] };
    }

    const trackCount = playlist.trackCount || 0;
    const trackIds = playlist.trackIds || [];
    const tracks = playlist.tracks || [];
    console.log(
      "[云云音乐] 歌单统计: trackCount=" +
        trackCount +
        ", trackIds=" +
        trackIds.length +
        ", tracks=" +
        tracks.length
    );

    let isEnd = false;
    let musicList = [];

    if (tracks.length > 0) {
      if (page === 1) {
        // 一次性返回所有歌曲
        musicList = tracks.map(formatMusicItem);
        isEnd = true;
        console.log(
          "[云云音乐] 一次性返回所有歌曲: " + musicList.length + "首"
        );
      } else {
        // 后续页返回空（已在 page=1 返回完）
        musicList = [];
        isEnd = true;
        console.log(
          "[云云音乐] page=" + page + ": 已在page=1返回所有歌曲，返回空列表"
        );
      }
    } else {
      console.warn(
        "[云云音乐] 后端未返回tracks数据，trackIds=" + trackIds.length
      );
      isEnd = true;
    }

    // 解析 creator
    let creatorName = "未知";
    let creatorId = "unknown";
    if (typeof playlist.creator === "string") {
      creatorName = playlist.creator;
    } else if (playlist.creator && typeof playlist.creator === "object") {
      creatorName = playlist.creator.nickname || playlist.creator.name || "未知";
      creatorId = String(
        playlist.creator.userId || playlist.creator.id || "unknown"
      );
    }

    const sheetItem = {
      type: "2",
      id: String(playlist.id),
      title: playlist.name || "未知歌单",
      artist: creatorName,
      artwork: playlist.coverImgUrl || playlist.coverImg || "",
      coverImg: playlist.coverImgUrl || playlist.coverImg || "",
      coverImgUrl: playlist.coverImgUrl || playlist.coverImg || "",
      description: playlist.description || "",
      worksNum: trackCount,
      playCount: playlist.playCount || 0,
      createUserId: playlist.userId || creatorId,
      createTime: playlist.createTime || 0,
    };

    console.log(
      "[云云音乐] getMusicSheetInfo 完成: 歌曲" +
        musicList.length +
        "首, isEnd=" +
        isEnd
    );

    return { isEnd, sheetItem, musicList };
  } catch (e) {
    console.error("[云云音乐] getMusicSheetInfo 失败:", e.message);
    throw e;
  }
}

// ============== 歌单分类标签（第二版定义，覆盖第一版）==============

/**
 * 获取歌单分类标签（实际生效的版本）
 * pinned 是写死的 11 个推荐标签
 * data 是 5 个分组（语种 / 风格 / 场景 / 情感 / 主题），
 * 每个分组下的标签先初始化为空，然后尝试调网易云 EAPI 拉真实分类填充
 * EAPI 失败时退化为空分组
 */
async function getRecommendSheetTags() {
  const pinned = [
    { title: "推荐", id: "_SPECIAL_CLOUD_VILLAGE_PLAYLIST" },
    { title: "官方", id: "官方" },
    { title: "雷达", id: "_RADAR" },
    { title: "原创", id: "_SPECIAL_ORIGIN_SONG_LOCATION" },
    { title: "心情", id: "_FEELING_PLAYLIST_LOCATION" },
    { title: "场景", id: "_SCENE_PLAYLIST_LOCATION" },
    { title: "专属", id: "_COMBINATION" },
    { title: "全部", id: "全部歌单" },
    { title: "新热", id: "_NEW_SONG_AND_ALBUM" },
    { title: "影视", id: "_FIRM_PLAYLIST" },
    { title: "奖项", id: "_AWARDS_PLAYLIST" },
  ];

  const groups = ["语种", "风格", "场景", "情感", "主题"].map((title) => ({
    title,
    data: [],
  }));

  try {
    // 调网易云 EAPI 拉真实分类
    const catalog = await EAPI("/api/playlist/catalogue/v1", {});
    if (catalog && catalog.sub) {
      catalog.sub.forEach((sub) => {
        groups[sub.category].data.push({
          title: sub.name,
          id: sub.name,
        });
      });
    }
  } catch (e) {
    console.error("[云云音乐] 获取歌单分类失败", e);
  }

  return { pinned, data: groups };
}

/**
 * 按标签拉取推荐歌单（实际生效的版本）
 * 根据标签 ID 的格式路由到不同的 EAPI 接口：
 *   - 空 / true       → /api/personalized/playlist（每日推荐）
 *   - 以 _ 开头大写   → /api/link/page/rcmd/resource/show（首页区块）
 *   - 其他（中文标签）→ /api/playlist/list（按分类筛选）
 * @param {{id?: string} | null} tag  标签对象
 * @param {number}               page 页码
 */
async function getRecommendSheetsByTag(tag, page) {
  let tagId =
    tag === null || tag === undefined || (tag && tag.id);
  let result;

  if (tagId === "" || tagId === true) {
    // 推荐位（无具体标签）
    result = await EAPI("/api/personalized/playlist", { limit: 30 });
  } else if (/^_[A-Z]+/.test(tagId)) {
    // 特殊标签（_开头大写）：从首页区块拉
    const blockResp = await EAPI("/api/link/page/rcmd/resource/show", {
      pageCode: "HOME_RECOMMEND_PAGE",
      isFirstScreen: "false",
      cursor: "6",
      refresh: "true",
      blockCodeOrderList: '["PAGE_RECOMMEND' + tagId + '"]',
    });
    const dslData = blockResp.data.blocks[0].dslData;
    result = (
      dslData.home_page_common_playlist_module_d1r94fwj80 ||
      dslData.home_page_scene_playlist_module_w5rp24j0x2 ||
      dslData.home_page_scene_playlist_module_rsoa9pd6fn ||
      dslData
    ).blockResource;
  } else {
    // 普通中文标签：按分类筛选
    result = await EAPI("/api/playlist/list", {
      cat: tagId || "全部",
      order: "hot",
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      total: true,
      csrf_token: "",
    });
  }

  const playlists =
    result.result || result.playlists || result.resources || [];
  const total = result.total || page * PAGE_SIZE - PAGE_SIZE + playlists.length;

  return {
    isEnd: result.more !== true || total <= page * PAGE_SIZE,
    data: playlists.map(formatSheetItemWy),
  };
}

// ============== 模块导出 ==============

module.exports = {
  platform: "云云音乐",
  author: "小橙QQ群1077835447",
  version: "2.1.0",
  srcUrl: "https://2209.kstore.space/xiaochen.js",
  cacheControl: "no-cache",
  description:
    "## 云云音乐 v2.1.0\n\n" +
    "🎉 **功能更新**\n" +
    "- ✅ 修复歌曲进度条不显示的bug\n" +
    "- ✅ 优化推荐榜单功能\n" +
    "- ✅ 支持搜索专辑、歌单\n" +
    "- ✅ 新增风控公告说明\n" +
    "- ✅ 补充 `dolby` 音质支持\n" +
    "- 🔧 修复已知 Bug，优化接口稳定性\n\n" +
    "⚠️ **注意事项**\n" +
    "- 接口滥用将封禁 IP，请合理使用\n" +
    "- 已知问题：搜索歌单概率飘移\n\n" +
    "📢 **风控公告**\n" +
    "- 为保障接口稳定运行，现启用风控封禁机制\n" +
    "- 单个 IP 在 60 秒内请求 `/song` 或 `/download` 超过 5 次：第一次封禁 12 小时，第二次封禁 24 小时，第三次永久封禁\n" +
    "- 单个 IP 在 7 天内累计请求超过 10000 次：封禁 7 天\n" +
    "- 封禁后将不再返回正常解析结果，而是返回提示音频\n\n" +
    "📢 **更多资讯**\n" +
    "- 加群获取最新版本与资讯QQ群1077835447\n" +
    "- 有问题可以联系反馈",

  hints: {
    importMusicSheet: [
      "网易云：APP点击分享，然后复制链接",
      "也支持直接输入歌单ID（如：2809577409）",
    ],
    importMusicItem: [
      "网易云：APP点击分享，然后复制链接",
      "也支持直接输入歌曲ID",
    ],
  },
  supportedSearchType: ["music", "album", "sheet"],
  searchAlbum,
  searchMusicSheet,
  supportedGetMediaSourceQuality: [
    "standard",
    "exhigh",
    "lossless",
    "hires",
    "sky",
    "jyeffect",
    "jymaster",
    "dolby",
  ],

  search,
  getMediaSource,
  getLyric,
  getAlbumInfo,
  getArtistWorks,
  getPlaylistDetail: getMusicSheetInfoNew,
  getMusicSheetInfo: getMusicSheetInfoNew,
  getMusicInfo: getSongDetail,
  getSongDetail,
  getRecommendPlaylists,
  getRecommendAlbums,
  getTopLists,
  getTopListDetail,
  importMusicSheet,
  importMusicItem,
  getRecommendSheetTags,
  getRecommendSheetsByTag,
};
