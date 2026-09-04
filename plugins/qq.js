/**
 * qq.js — QQ 音乐全功能插件
 * ------------------------------------------------------------------
 * 适用宿主：MusicFree / 同类插件系统
 * 平台标识：温Q
 * 作者：温
 * 反编译 + 变量重命名 + 注释 by 逆向工具链
 * ------------------------------------------------------------------
 * 通过 ws.suol.cc/qq/qq_php.php 中转的 QQ 音乐接口，支持：
 *   1. 多类型搜索：歌曲 / 专辑 / 歌手 / 歌单
 *   2. 多音质播放：flac / 320 / 128 / m4a
 *   3. LRC 歌词获取
 *   4. 专辑 / 歌单详情
 *   5. 歌手作品（歌曲或专辑）
 *   6. 榜单列表 + 榜单详情
 *   7. 推荐歌单分类标签 + 按标签筛选歌单
 *   8. 单曲 / 歌单 / 专辑分享链接导入
 * ------------------------------------------------------------------
 * 数据模型关键点：
 *   - QQ 音乐用 songmid 作为主键（字符串，14 位左右）
 *   - 数字 songId 在分享链接里更常见，但播放接口要的是 songmid
 *     → 通过 resolveSongBySongId() 做转换（带内存缓存）
 *   - mediaId（strMediaMid）和 songmid 是两套东西，部分歌曲需要同时提供
 * ------------------------------------------------------------------
 * 后端约定：返回体 { result: 100, data: ... } 表示成功
 */

const axios = require("axios");

// 后端代理地址
const API = "http://ws.suol.cc/qq/qq_php.php";

// 平台标识
const PLATFORM = "温Q";

// 播放时需要的 UA 与 Referer
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

/**
 * 音质映射：把宿主统一的音质档位转成 QQ 音乐后端识别的字符串
 */
const QUALITY_MAP = {
  super: "flac",
  high: "320",
  standard: "128",
  low: "m4a",
};

/**
 * 搜索类型映射：把宿主的字符串分类转成 QQ 音乐后端的 t 参数数字
 */
const SEARCH_TYPE_T = {
  music: 0,
  album: 8,
  artist: 9,
  sheet: 2,
};

/**
 * 把 QQ 音乐的 albummid / albumMid 字段补全成完整封面 URL
 * 已是完整 URL 的直接返回；纯 mid 则拼成 QQ 音乐标准 CDN 路径
 * @param {string} midOrUrl 专辑 mid 或完整 URL
 * @returns {string}
 */
function buildCoverUrl(midOrUrl) {
  if (!midOrUrl) {
    return "";
  }
  const str = String(midOrUrl);
  if (/^https?:\/\//i.test(str)) {
    return str;
  }
  // 提取 mid：可能形如 M000abc.jpg.jpg 或纯 mid
  const midMatch = str.match(/M000([^.]+)\.jpg$/);
  const mid = midMatch ? midMatch[1] : str;
  return (
    "https://y.qq.com/music/photo_new/T002R300x300M000" + mid + ".jpg"
  );
}

/**
 * 从搜索/列表响应中抽出歌曲数组
 * QQ 音乐不同接口返回字段不一致，有 list / songlist / songList 三种写法
 * @param {object} body 接口返回的整个 body
 * @returns {Array}
 */
function extractSongList(body) {
  if (!body || body.result !== 100) {
    return [];
  }
  const data = body.data || {};
  if (Array.isArray(data.list)) {
    return data.list;
  }
  if (Array.isArray(data.songlist)) {
    return data.songlist;
  }
  if (Array.isArray(data.songList)) {
    return data.songList;
  }
  return [];
}

/**
 * 把 QQ 音乐原始歌曲对象归一化成 MusicFree 通用结构
 * 字段兼容性极强：搜索/榜单/歌单/专辑接口返回的歌曲字段都有差异
 * @param {object} raw QQ 音乐原始歌曲对象
 * @returns {object | null}
 */
function normalizeSong(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  // 歌手：可能是数组 [{name}, ...]、字符串、或 singerName 兜底
  const artist = Array.isArray(raw.singer)
    ? raw.singer
        .map((s) => s && (s.name || s.title) || "")
        .filter(Boolean)
        .join(" / ")
    : typeof raw.singer === "string"
    ? raw.singer
    : raw.singerName || "未知歌手";

  // 专辑：可能是对象或纯字符串
  const albumObj =
    raw.album && typeof raw.album === "object" ? raw.album : {};
  const albumMid = raw.albummid || raw.albumMid || albumObj.mid || "";

  // songmid 是主键，mid 是历史字段
  const songmid = String(raw.songmid || raw.mid || "");

  return {
    id: songmid || String(raw.songId || raw.songid || ""),
    songId: String(raw.songId || raw.songid || ""), // 保留数字 songId 用于回查
    platform: PLATFORM,
    title: raw.songname || raw.name || raw.title || "未知",
    artist,
    album: raw.albumname || albumObj.name || albumObj.title || "",
    albumId: String(albumMid),
    mediaId: String(
      raw.strMediaMid ||
        raw.media_mid ||
        (raw.file && raw.file.media_mid) ||
        songmid
    ),
    duration: raw.interval || raw.duration || 0,
    artwork: buildCoverUrl(albumMid || raw.cover || raw.albumPic),
  };
}

/**
 * 把 QQ 音乐原始歌手对象归一化
 */
function normalizeArtist(raw) {
  return {
    id: String(raw.singerMID || ""),
    platform: PLATFORM,
    title: raw.singerName || "未知歌手",
    artist: raw.singerName || "未知歌手",
    artwork: buildCoverUrl(raw.singerPic),
    description: raw.songNum ? raw.songNum + " 首歌曲" : "",
  };
}

/**
 * 把 QQ 音乐原始歌单对象归一化
 */
function normalizeSheet(raw) {
  const creatorName =
    raw.creator && typeof raw.creator === "object" ? raw.creator.name || "" : "";
  const sheetId = raw.content_id || raw.dissid || raw.tid || "";
  const cover = buildCoverUrl(raw.imgurl || raw.diss_cover || raw.cover);
  return {
    id: String(sheetId),
    platform: PLATFORM,
    title: raw.dissname || raw.title || "未知歌单",
    artist: creatorName,
    coverImg: cover,
    artwork: cover,
    description:
      raw.introduction ||
      (raw.song_cnt ? raw.song_cnt + " 首" : "") ||
      (raw.listen_num ? "播放 " + raw.listen_num : ""),
  };
}

/**
 * 把 QQ 音乐原始专辑对象归一化
 */
function normalizeAlbum(raw) {
  const albumMid =
    raw.albumMID ||
    raw.mid ||
    raw.albummid ||
    raw.album_mid ||
    raw.albumid ||
    "";
  const artist =
    raw.singerName ||
    raw.singer_name ||
    (Array.isArray(raw.singer) && raw.singer[0] ? raw.singer[0].name : "") ||
    "未知歌手";
  return {
    id: String(albumMid),
    platform: PLATFORM,
    title:
      raw.albumName ||
      raw.album_name ||
      raw.name ||
      raw.title ||
      "未知专辑",
    artist,
    artwork: buildCoverUrl(
      raw.albumPic || raw.pic || raw.picUrl || raw.album_pic_mid
    ),
    isAlbum: true,
  };
}

/**
 * 通用 GET 请求封装：自动拼 path 参数并提取 data 字段
 * @param {string} path     后端 action 名
 * @param {object} params   业务参数
 * @param {number} timeout  超时（毫秒）
 * @returns {Promise<object>} 接口返回的 body
 */
function callApi(path, params, timeout) {
  return axios
    .get(API, {
      params: Object.assign({ path }, params),
      timeout: timeout || 10000,
    })
    .then((resp) => resp.data);
}

// songId → songmid 的内存缓存（避免对同一首歌反复回查搜索接口）
const songIdResolveCache = {};

/**
 * 把数字 songId 转成 songmid（后端 song/url 接口只认 songmid）
 * 实现方式：用歌曲标题去搜索，再从结果里找到 songid 匹配的那一首
 * @param {{songId?: string, id?: string, title?: string, name?: string}} song
 * @returns {Promise<{songmid: string, mediaId: string} | null>}
 */
async function resolveSongBySongId(song) {
  const songId = String(song.songId || song.id || "");
  if (!songId) {
    return null;
  }

  // 命中缓存
  if (songIdResolveCache[songId]) {
    return songIdResolveCache[songId];
  }

  const title = song.title || song.name || "";
  if (!title) {
    return null;
  }

  // 回查搜索接口（取前 10 条）
  const searchBody = await callApi(
    "search",
    { key: title, pageNo: 1, pageSize: 10, t: 0 },
    10000
  );
  const candidates = extractSongList(searchBody);

  // 优先找 songid 严格匹配的
  let matched = null;
  for (const c of candidates) {
    if (String(c.songid || c.songId || "") === songId) {
      matched = c;
      break;
    }
  }
  // 退而求其次用第一条
  if (!matched && candidates.length) {
    matched = candidates[0];
  }
  if (!matched) {
    return null;
  }

  const result = {
    songmid: String(matched.songmid || matched.mid || ""),
    mediaId: String(
      matched.strMediaMid ||
        matched.media_mid ||
        (matched.file && matched.file.media_mid) ||
        ""
    ),
  };

  if (result.songmid) {
    songIdResolveCache[songId] = result;
  }
  return result;
}

module.exports = {
  platform: PLATFORM,
  author: "温",
  version: "0.4.0",
  srcUrl: "http://ws.suol.cc/qq/qq.js",
  cacheControl: "no-cache",
  primaryKey: ["id", "mediaId"],
  supportedSearchType: ["music", "album", "artist", "sheet"],
  hints: {
    importMusicSheet: [
      "支持 QQ 音乐歌单/专辑分享链接或歌单 ID，例如 https://y.qq.com/n/ryqq/playlist/8075336924",
    ],
    importMusicItem: [
      "支持 QQ 音乐单曲分享链接或 songmid，例如 https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV",
    ],
  },

  /**
   * 多类型搜索
   * @param {string} keyword    关键字
   * @param {number} pageNo     页码
   * @param {string} searchType music / album / artist / sheet
   */
  async search(keyword, pageNo, searchType) {
    const t = SEARCH_TYPE_T[searchType] || 0;
    const body = await callApi("search", {
      key: keyword,
      pageNo: pageNo || 1,
      pageSize: 20,
      t,
    });

    if (!body || body.result !== 100) {
      return { isEnd: true, data: [] };
    }

    const list = extractSongList(body);
    let data;
    if (t === 8) {
      data = list.map(normalizeAlbum).filter(Boolean);
    } else if (t === 9) {
      data = list.map(normalizeArtist).filter(Boolean);
    } else if (t === 2) {
      data = list.map(normalizeSheet).filter(Boolean);
    } else {
      data = list.map(normalizeSong).filter(Boolean);
    }
    return { isEnd: true, data };
  },

  /**
   * 获取播放地址
   * 注意：如果传入的 id 是纯数字（说明是 songId 而非 songmid），
   * 需要先调 resolveSongBySongId 转成 songmid 再请求
   * @param {{id: string, mediaId?: string, title?: string}} song
   * @param {string} quality 音质档位
   */
  async getMediaSource(song, quality) {
    const qualityCode = QUALITY_MAP[quality] || "128";
    let songmid = song.id;
    let mediaId = song.mediaId;

    // 数字 id = songId，需要转换
    if (/^\d+$/.test(String(songmid))) {
      const resolved = await resolveSongBySongId(song);
      if (!resolved) {
        throw new Error("无法解析歌曲ID，请稍后重试");
      }
      songmid = resolved.songmid;
      mediaId = resolved.mediaId || songmid;
    }

    const params = {
      path: "song/url",
      id: songmid,
      type: qualityCode,
    };
    if (mediaId && mediaId !== songmid) {
      params.mediaId = mediaId;
    }

    const response = await axios.get(API, { params, timeout: 12000 });
    const body = response.data;
    if (!body || body.result !== 100 || !body.data) {
      throw new Error("无法获取播放链接，请稍后重试");
    }
    return {
      url: body.data,
      headers: { Referer: "https://y.qq.com/", "User-Agent": UA },
    };
  },

  /**
   * 获取 LRC 歌词
   * 同样需要把数字 songId 转成 songmid
   */
  async getLyric(song) {
    let songmid = song.id;
    if (/^\d+$/.test(String(songmid))) {
      const resolved = await resolveSongBySongId(song);
      if (resolved && resolved.songmid) {
        songmid = resolved.songmid;
      }
    }
    const body = await callApi("lyric", { songmid }, 8000);
    if (body && body.result === 100 && body.data && body.data.lyric) {
      return { rawLrc: body.data.lyric };
    }
    throw new Error("未获取到歌词");
  },

  /**
   * 获取专辑详情（专辑下所有歌曲）
   * @param {{albumId?: string, id?: string, title?: string, artist?: string}} album
   */
  async getAlbumInfo(album) {
    const albumMid = album.albumId || album.id;
    const body = await callApi("album/songs", { albummid: albumMid }, 10000);
    if (!body || body.result !== 100) {
      return { isEnd: true, albumItem: {}, musicList: [] };
    }
    const songs = extractSongList(body).map(normalizeSong).filter(Boolean);
    return {
      isEnd: true,
      albumItem: {
        id: String(albumMid),
        platform: PLATFORM,
        title: album.title || "未知专辑",
        artist: album.artist || "",
        description:
          body.data && body.data.total ? "共 " + body.data.total + " 首" : "",
      },
      musicList: songs,
    };
  },

  /**
   * 获取歌单详情：分页拉取歌单内歌曲
   * @param {{id: string, title?: string, coverImg?: string, artwork?: string}} sheet
   * @param {number} page 页码（每页 30 条）
   */
  async getMusicSheetInfo(sheet, page) {
    const begin = ((page || 1) - 1) * 30;
    const body = await callApi(
      "songlist",
      { id: sheet.id, begin, num: 30 },
      15000
    );
    if (
      !body ||
      body.result !== 100 ||
      !body.data ||
      !Array.isArray(body.data.songlist)
    ) {
      return { isEnd: true, musicList: [] };
    }

    const songs = body.data.songlist.map(normalizeSong).filter(Boolean);
    const cover = buildCoverUrl(
      body.data.imgurl || body.data.diss_cover || body.data.picurl
    );
    const totalCount = Number(body.data.total || body.data.total_song_num || 0);
    const hasMore =
      body.data.hasmore === 1 ||
      (totalCount > 0 && begin + 30 < totalCount);

    return {
      isEnd: !hasMore,
      sheetItem: {
        id: String(sheet.id),
        platform: PLATFORM,
        title: body.data.dissname || sheet.title || "未知歌单",
        artist: (body.data.creator && body.data.creator.name) || "",
        coverImg: cover || sheet.coverImg,
        artwork: cover || sheet.artwork,
        description:
          body.data.introduction ||
          (totalCount ? "共 " + totalCount + " 首" : ""),
      },
      musicList: songs,
    };
  },

  /**
   * 获取歌手作品
   * @param {{id: string, artist?: {id: string}}} artist 歌手对象
   * @param {number} page 页码
   * @param {string} category "album" 拉专辑，其他拉歌曲
   */
  async getArtistWorks(artist, page, category) {
    const singerMid = artist.id || (artist.artist && artist.artist.id) || "";
    if (!singerMid) {
      return { isEnd: true, data: [] };
    }

    if (category === "album") {
      const body = await callApi(
        "singer/album",
        { singermid: singerMid, pageNo: page || 1, pageSize: 20 },
        undefined
      );
      const albums = extractSongList(body).map(normalizeAlbum).filter(Boolean);
      return { isEnd: true, data: albums };
    }

    const body = await callApi(
      "singer/songs",
      { singermid: singerMid, num: 20, page: page || 1 },
      undefined
    );
    const songs = extractSongList(body).map(normalizeSong).filter(Boolean);
    return { isEnd: true, data: songs };
  },

  /**
   * 导入单曲
   * 支持两种输入：
   *   1. https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV → 抽出 songmid
   *   2. 纯 songmid 字符串（10~20 位字母数字）
   * 注意：本接口只返回占位元信息（"QQ音乐歌曲"），不调后端拉详情
   *       真正的标题/歌手会在 getMediaSource 阶段被刷新
   * @param {string} input
   */
  async importMusicItem(input) {
    const text = String(input == null ? "" : input).trim();
    if (!text) {
      return null;
    }
    // 匹配 songDetail 路径里的 songmid，或退化匹配任意 10~20 位字母数字串
    const match =
      text.match(/songDetail[/=]([0-9A-Za-z]{10,20})/) ||
      text.match(/\b([0-9A-Za-z]{10,20})\b/);
    if (!match) {
      return null;
    }
    return {
      id: match[1],
      mediaId: match[1],
      platform: PLATFORM,
      title: "QQ音乐歌曲",
      artist: "",
      artwork: "",
    };
  },

  /**
   * 导入歌单 / 专辑
   * 通过多组正则识别输入是歌单 ID（纯数字）还是专辑 mid（字母数字）
   * 支持的 URL 形式：
   *   - /playlist/8075336924
   *   - /taoge.html?id=8075336924
   *   - /songlist/8075336924
   *   - /albumDetail/0039MnYb0qxYhV
   *   - /album.html?albumId=0039MnYb0qxYhV
   * 兜底：纯数字当歌单 ID，纯字母数字当专辑 mid
   * @param {string} input
   */
  async importMusicSheet(input) {
    const text = String(input == null ? "" : input).trim();
    if (!text) {
      return null;
    }

    let albumMid = null;
    let sheetId = null;

    // 一连串正则尝试匹配各种 URL 形式
    let m = text.match(/playlist[/=](\d{6,})/);
    if (m) sheetId = m[1];

    m = text.match(/taoge\.html[^#]*\bid=(\d{6,})/);
    if (m) sheetId = m[1];

    m = text.match(/songlist[/=](\d{6,})/);
    if (m) sheetId = m[1];

    m = text.match(/albumDetail[/=]([0-9A-Za-z]{10,20})/);
    if (m) albumMid = m[1];

    m = text.match(/album\.html[^#]*\balbumId=([0-9A-Za-z]{10,20})/);
    if (m) albumMid = m[1];

    // 兜底：没有明确 URL 标识时按格式推断
    if (!albumMid && !sheetId) {
      const numMatch = text.match(/\d{6,}/);
      const midMatch = text.match(/[0-9A-Za-z]{10,20}/);
      if (midMatch && !numMatch) {
        albumMid = midMatch[0];
      } else if (numMatch) {
        sheetId = numMatch[0];
      }
    }

    if (!albumMid && !sheetId) {
      return null;
    }

    // 走歌单接口
    if (sheetId) {
      const body = await callApi("songlist", { id: sheetId }, 10000);
      if (
        !body ||
        body.result !== 100 ||
        !body.data ||
        !Array.isArray(body.data.songlist)
      ) {
        return null;
      }
      return body.data.songlist.map(normalizeSong).filter(Boolean);
    }

    // 走专辑接口
    const body = await callApi("album/songs", { albummid: albumMid }, 10000);
    if (!body || body.result !== 100) {
      return null;
    }
    return extractSongList(body).map(normalizeSong).filter(Boolean);
  },

  /**
   * 榜单分组列表：调用后端 top/category 拿到所有榜单分类
   */
  async getTopLists() {
    const body = await callApi("top/category");
    if (!body || body.result !== 100 || !Array.isArray(body.data)) {
      return [];
    }
    return body.data.map((group) => ({
      title: group.title || "QQ音乐榜单",
      data: (group.list || []).map((top) => {
        const cover = buildCoverUrl(top.picUrl);
        return {
          id: String(top.topId),
          title: top.label || top.title || "未知榜单",
          coverImg: cover,
          artwork: cover,
          description:
            top.intro || (top.updateTime ? "更新于 " + top.updateTime : ""),
        };
      }),
    }));
  },

  /**
   * 榜单详情：拉取榜单内歌曲（每页 100 条）
   * @param {{id: string|number, title?: string, coverImg?: string, description?: string}} top
   * @param {number} page 页码
   */
  async getTopListDetail(top, page) {
    const body = await callApi(
      "top",
      { id: top.id || 4, pageSize: 100, pageNo: page || 1 },
      undefined
    );
    if (!body || body.result !== 100) {
      return { isEnd: true, musicList: [] };
    }
    const data = body.data || {};
    const songs = (Array.isArray(data.list) ? data.list : [])
      .map(normalizeSong)
      .filter(Boolean);
    return {
      isEnd: true,
      topListItem: {
        id: String(top.id),
        platform: PLATFORM,
        title: top.title || (data.info && data.info.title) || "QQ音乐榜单",
        coverImg: top.coverImg || "",
        description: top.description || "",
      },
      musicList: songs,
    };
  },

  /**
   * 推荐歌单的分类标签
   * 调用 songlist/category，第一组作为 pinned（置顶标签），其余作为分组
   * 后端没有 pinned 时用 "热门" 兜底
   */
  async getRecommendSheetTags() {
    const body = await callApi("songlist/category");
    const categories =
      body && body.result === 100 && Array.isArray(body.data) ? body.data : [];

    const result = { pinned: [], data: [] };
    categories.forEach((cat, index) => {
      const tags = (cat.list || [])
        .map((t) => ({ id: String(t.id), title: t.name || "" }))
        .filter((t) => t.title);

      if (index === 0) {
        // 第一组作为置顶
        result.pinned = tags;
      } else if (tags.length) {
        result.data.push({
          title: cat.type || cat.title || "",
          data: tags,
        });
      }
    });

    if (!result.pinned.length) {
      result.pinned = [{ id: "10000000", title: "热门" }];
    }
    return result;
  },

  /**
   * 按标签拉取推荐歌单
   * @param {{id?: string}} tag 标签对象
   * @param {number} page 页码（每页 20 条）
   */
  async getRecommendSheetsByTag(tag, page) {
    const categoryId = (tag && tag.id) || "10000000";
    const body = await callApi(
      "songlist/list",
      { category: categoryId, pageNo: page || 1, pageSize: 20, sort: 5 },
      undefined
    );
    if (!body || body.result !== 100) {
      return { isEnd: true, data: [] };
    }
    const sheets = extractSongList(body)
      .map(normalizeSheet)
      .filter(Boolean);
    return { isEnd: sheets.length === 0, data: sheets };
  },
};
