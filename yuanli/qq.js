/**
 * qq.js — 元力QQ QQ音乐插件
 * ------------------------------------------------------------------
 * 适用宿主：MusicFree / 同类插件系统
 * 平台标识：元力QQ
 * 原作者：微信公众号「元力菌」（原始混淆版）
 * 反编译 + 变量重命名 + 注释 by Super Z
 * ------------------------------------------------------------------
 * 架构特点：
 *   - 元数据接口（搜索 / 专辑 / 歌手 / 歌单 / 歌词 / 榜单 / 推荐歌单）
 *     直连 QQ 音乐官方 CGI：
 *       · u.y.qq.com/cgi-bin/musicu.fcg  （搜索 / 专辑 / 歌手 / 榜单）
 *       · c.y.qq.com/lyric/fcgi-bin/...   （歌词）
 *       · c.y.qq.com/splcloud/fcgi-bin/...（歌单分类 / 推荐）
 *       · i.y.qq.com/qzone/fcg-bin/...    （歌单详情）
 *     这些接口无需加密，直接 GET / POST 即可，但部分响应是 JSONP
 *     包装（callback(...) / MusicJsonCallback(...) / jsonCallback(...)），
 *     需要去掉外层括号后才能 JSON.parse
 *   - 播放 URL 走第三方代理
 *     http://175.27.166.236/kgqq1/qq.php?id=<songmid>&type=json&level=<level>
 *     （绕过 QQ 音乐版权限制）
 *   - 歌词是 base64 编码，需要 CryptoJs 解码 + he 反转义
 *   - 歌单导入：支持三种 URL 形式 + 纯数字 ID
 * ------------------------------------------------------------------
 * 依赖：axios / crypto-js / he
 */

'use strict';

Object.defineProperty(exports, "__esModule", { value: true });

const axios = require("axios");
const CryptoJs = require("crypto-js");
const he = require("he");

// ============== 通用常量 ==============

/** 每页条数（搜索 / 歌手作品分页都用这个） */
const PAGE_SIZE = 20;

/**
 * QQ 音乐搜索类型映射
 * key   = 传给 CGI 的 search_type 数字
 * value = 返回 JSON 里 body 下对应的字段名
 *   0  → song     歌曲
 *   1  → singer   歌手
 *   2  → album    专辑
 *   3  → songlist 歌单
 *   7  → song     歌词（命中的歌曲，body.song 里带 content 字段）
 *   12 → mv       MV（本插件未使用）
 */
const SEARCH_TYPE_MAP = {
  "0": "song",
  "2": "album",
  "1": "singer",
  "3": "songlist",
  "7": "song",
  "12": "mv",
};

/** 通用请求头（伪装浏览器 + 空 uin） */
const COMMON_HEADERS = {
  referer: "https://y.qq.com",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36",
  Cookie: "uin=",
};

/**
 * 音质档位映射：把 MusicFree 的 low/standard/high/super 转成
 * 第三方代理 qq.php 接受的 level 字段
 *   - low / standard / high 都映射到 exhigh（高品质 MP3）
 *   - super 映射到 lossless（无损 FLAC）
 */
const QUALITY_LEVELS = {
  low: "exhigh",
  standard: "exhigh",
  high: "exhigh",
  super: "lossless",
};

/**
 * 文件类型 → 文件名前缀 + 扩展名映射（本插件目前未直接使用，
 * 原始混淆代码里保留是为了后续可以直接拼 vkey URL）
 */
const TYPE_MAP = {
  m4a: { s: "C400", e: ".m4a" },
  "128": { s: "M500", e: ".mp3" },
  "320": { s: "M800", e: ".mp3" },
  ape: { s: "A000", e: ".ape" },
  flac: { s: "F000", e: ".flac" },
};

// ============== 数据格式化 ==============

/**
 * 把 QQ 音乐原始歌曲对象归一化成 MusicFree 通用结构
 * QQ 音乐的字段命名经常有两种形式（如 songid / id、songmid / mid），
 * 这里统一做了兼容
 * @param {object} raw QQ 音乐原始歌曲对象
 * @returns {object} MusicFree 通用歌曲结构
 */
function formatMusicItem(raw) {
  const albumId = raw.albumid || raw.album?.id;
  const albumMid = raw.albummid || raw.album?.mid;
  const albumName = raw.albumname || raw.album?.title;
  return {
    id: raw.id || raw.songid,
    songmid: raw.mid || raw.songmid,
    title: raw.title || raw.songname,
    artist: raw.singer.map((s) => s.name).join(", "),
    artwork: albumMid
      ? "https://y.gtimg.cn/music/photo_new/T002R800x800M000" +
        albumMid +
        ".jpg"
      : undefined,
    album: albumName,
    lrc: raw.lyric || undefined,
    albumid: albumId,
    albummid: albumMid,
  };
}

/**
 * 把 QQ 音乐原始专辑对象归一化成 MusicFree 通用结构
 * @param {object} raw QQ 音乐原始专辑对象
 * @returns {object} MusicFree 通用专辑结构
 */
function formatAlbumItem(raw) {
  return {
    id: raw.albumID || raw.albumid,
    albumMID: raw.albumMID || raw.album_mid,
    title: raw.albumName || raw.album_name,
    artwork:
      raw.albumPic ||
      "https://y.gtimg.cn/music/photo_new/T002R800x800M000" +
        (raw.albumMID || raw.album_mid) +
        ".jpg",
    date: raw.publicTime || raw.pub_time,
    singerID: raw.singerID || raw.singer_id,
    artist: raw.singerName || raw.singer_name,
    singerMID: raw.singerMID || raw.singer_mid,
    description: raw.desc,
  };
}

/**
 * 把 QQ 音乐原始歌手对象归一化成 MusicFree 通用结构
 * @param {object} raw QQ 音乐原始歌手对象
 * @returns {object} MusicFree 通用歌手结构
 */
function formatArtistItem(raw) {
  return {
    name: raw.singerName,
    id: raw.singerID,
    singerMID: raw.singerMID,
    avatar: raw.singerPic,
    worksNum: raw.songNum,
  };
}

// ============== URL 工具函数 ==============

/**
 * 从 URL 里取查询参数
 * @param {string|null} key    要取的字段名；传 null 表示取全部
 * @param {string}      url    完整 URL
 * @returns {string|object|undefined}
 *   - 传 key 且命中：返回字符串
 *   - 传 key 未命中 / 出错：返回 ""（注意是空串）
 *   - 不传 key：返回 { field: value } 对象
 *   - 不传 key 且 URL 没有 query 段：返回 {}
 */
function getQueryFromUrl(key, url) {
  try {
    const segments = url.split("?");
    let queryStr = "";
    if (segments.length > 1) {
      queryStr = segments[1];
    } else if (key) {
      return undefined;
    } else {
      return {};
    }
    const pairs = queryStr.split("&");
    const query = {};
    pairs.forEach((pair) => {
      const [k, v] = pair.split("=");
      query[k] = decodeURIComponent(v);
    });
    if (key) {
      return query[key];
    } else {
      return query;
    }
  } catch (e) {
    if (key) {
      return "";
    } else {
      return {};
    }
  }
}

/**
 * 把一个 query 对象合并进已有 URL，覆盖同名字段
 * 值为 undefined / "" 的字段会被丢弃
 * @param {object} query 要合并的 query 对象
 * @param {string} url   原 URL
 * @returns {string} 合并后的新 URL
 */
function changeUrlQuery(query, url) {
  const existing = getQueryFromUrl(null, url);
  const baseUrl = url.split("?")[0];
  const merged = Object.assign(Object.assign({}, existing), query);
  const pairs = [];
  Object.keys(merged).forEach((k) => {
    if (merged[k] !== undefined && merged[k] !== "") {
      pairs.push(k + "=" + encodeURIComponent(merged[k]));
    }
  });
  return (baseUrl + "?" + pairs.join("&")).replace(/\?$/, "");
}

// ============== 搜索相关 ==============

/**
 * 搜索基础函数：调用 musicu.fcg 的 DoSearchForQQMusicDesktop
 * @param {string} keyword     关键字
 * @param {number} page        页码（从 1 开始）
 * @param {number} searchType  搜索类型数字（见 SEARCH_TYPE_MAP）
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function searchBase(keyword, page, searchType) {
  const param = {
    num_per_page: PAGE_SIZE,
    page_num: page,
    query: keyword,
    search_type: searchType,
  };
  const requestOptions = {
    url: "https://u.y.qq.com/cgi-bin/musicu.fcg",
    method: "POST",
    data: {},
    headers: COMMON_HEADERS,
    xsrfCookieName: "XSRF-TOKEN",
    withCredentials: true,
  };
  requestOptions.data.req_1 = {
    method: "DoSearchForQQMusicDesktop",
    module: "music.search.SearchCgiService",
    param,
  };
  const response = await axios(requestOptions);
  const result = response.data;
  return {
    isEnd: result.req_1.data.meta.sum <= page * PAGE_SIZE,
    data: result.req_1.data.body[SEARCH_TYPE_MAP[searchType]].list,
  };
}

/**
 * 搜歌曲
 * @param {string} keyword 关键字
 * @param {number} page    页码
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function searchMusic(keyword, page) {
  const result = await searchBase(keyword, page, 0);
  return {
    isEnd: result.isEnd,
    data: result.data.map(formatMusicItem),
  };
}

/**
 * 搜专辑
 * @param {string} keyword 关键字
 * @param {number} page    页码
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function searchAlbum(keyword, page) {
  const result = await searchBase(keyword, page, 2);
  return {
    isEnd: result.isEnd,
    data: result.data.map(formatAlbumItem),
  };
}

/**
 * 搜歌手
 * @param {string} keyword 关键字
 * @param {number} page    页码
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function searchArtist(keyword, page) {
  const result = await searchBase(keyword, page, 1);
  return {
    isEnd: result.isEnd,
    data: result.data.map(formatArtistItem),
  };
}

/**
 * 搜歌单
 * @param {string} keyword 关键字
 * @param {number} page    页码
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function searchMusicSheet(keyword, page) {
  const result = await searchBase(keyword, page, 3);
  return {
    isEnd: result.isEnd,
    data: result.data.map((item) => ({
      title: item.dissname,
      createAt: item.createtime,
      description: item.introduction,
      playCount: item.listennum,
      worksNums: item.song_count,
      artwork: item.imgurl,
      id: item.dissid,
      artist: item.creator.name,
    })),
  };
}

/**
 * 搜歌词
 * 搜索类型 7 返回的仍是歌曲列表，但每首歌带 content 字段（命中的歌词文本）
 * @param {string} keyword 关键字
 * @param {number} page    页码
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function searchLyric(keyword, page) {
  const result = await searchBase(keyword, page, 7);
  return {
    isEnd: result.isEnd,
    data: result.data.map((item) =>
      Object.assign(Object.assign({}, formatMusicItem(item)), {
        rawLrcTxt: item.content,
      })
    ),
  };
}

// ============== 专辑详情 ==============

/**
 * 获取专辑下所有歌曲
 * 调用 music.musichallAlbum.AlbumSongList.GetAlbumSongList
 * 一次拉 999 条（基本能覆盖整张专辑）
 * @param {{albumMID: string}} album 专辑对象（用 albumMID 字段）
 * @returns {Promise<{musicList: Array}>}
 */
async function getAlbumInfo(album) {
  const param = {
    albumMid: album.albumMID,
    albumID: 0,
    begin: 0,
    num: 999,
    order: 2,
  };
  const url = changeUrlQuery(
    {
      data: JSON.stringify({
        comm: { ct: 24, cv: 10000 },
        albumSonglist: {
          method: "GetAlbumSongList",
          param,
          module: "music.musichallAlbum.AlbumSongList",
        },
      }),
    },
    "https://u.y.qq.com/cgi-bin/musicu.fcg?g_tk=5381&format=json&inCharset=utf8&outCharset=utf-8"
  );
  const response = await axios({
    url,
    headers: COMMON_HEADERS,
    xsrfCookieName: "XSRF-TOKEN",
    withCredentials: true,
  });
  const result = response.data;
  return {
    musicList: result.albumSonglist.data.songList.map((entry) => {
      return formatMusicItem(entry.songInfo);
    }),
  };
}

// ============== 歌手作品 ==============

/**
 * 获取歌手的歌曲（分页）
 * 调用 music.web_singer_info_svr.get_singer_detail_info
 * @param {{singerMID: string}} artist 歌手对象（用 singerMID 字段）
 * @param {number}              page   页码
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function getArtistSongs(artist, page) {
  const url = changeUrlQuery(
    {
      data: JSON.stringify({
        comm: { ct: 24, cv: 0 },
        singer: {
          method: "get_singer_detail_info",
          param: {
            sort: 5,
            singermid: artist.singerMID,
            sin: (page - 1) * PAGE_SIZE,
            num: PAGE_SIZE,
          },
          module: "music.web_singer_info_svr",
        },
      }),
    },
    "http://u.y.qq.com/cgi-bin/musicu.fcg"
  );
  const response = await axios({
    url,
    method: "get",
    headers: COMMON_HEADERS,
    xsrfCookieName: "XSRF-TOKEN",
    withCredentials: true,
  });
  const result = response.data;
  return {
    isEnd: result.singer.data.total_song <= page * PAGE_SIZE,
    data: result.singer.data.songlist.map(formatMusicItem),
  };
}

/**
 * 获取歌手的专辑（分页）
 * 调用 music.web_singer_info_svr.get_singer_album
 * @param {{singerMID: string}} artist 歌手对象（用 singerMID 字段）
 * @param {number}              page   页码
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function getArtistAlbums(artist, page) {
  const url = changeUrlQuery(
    {
      data: JSON.stringify({
        comm: { ct: 24, cv: 0 },
        singerAlbum: {
          method: "get_singer_album",
          param: {
            singermid: artist.singerMID,
            order: "time",
            begin: (page - 1) * PAGE_SIZE,
            num: PAGE_SIZE / 1,
            exstatus: 1,
          },
          module: "music.web_singer_info_svr",
        },
      }),
    },
    "http://u.y.qq.com/cgi-bin/musicu.fcg"
  );
  const response = await axios({
    url,
    method: "get",
    headers: COMMON_HEADERS,
    xsrfCookieName: "XSRF-TOKEN",
    withCredentials: true,
  });
  const result = response.data;
  return {
    isEnd: result.singerAlbum.data.total <= page * PAGE_SIZE,
    data: result.singerAlbum.data.list.map(formatAlbumItem),
  };
}

/**
 * 获取歌手作品（按类型分派到 getArtistSongs / getArtistAlbums）
 * @param {{singerMID: string}} artist   歌手对象
 * @param {number}              page     页码
 * @param {string}              category "music" 或 "album"
 * @returns {Promise<{isEnd: boolean, data: Array}|undefined>}
 */
async function getArtistWorks(artist, page, category) {
  if (category === "music") {
    return getArtistSongs(artist, page);
  }
  if (category === "album") {
    return getArtistAlbums(artist, page);
  }
}

// ============== 歌词 ==============

/**
 * 获取 LRC 歌词
 * QQ 音乐的歌词接口返回的是 JSONP，且 lyric / trans 都是 base64 编码
 * @param {{songmid: string}} song 歌曲对象（用 songmid 字段）
 * @returns {Promise<{rawLrc: string, translation?: string}>}
 */
async function getLyric(song) {
  const response = await axios({
    url:
      "http://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=" +
      song.songmid +
      "&pcachetime=" +
      new Date().getTime() +
      "&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8" +
      "&notice=0&platform=yqq&needNewCode=0",
    headers: {
      Referer: "https://y.qq.com",
      Cookie: "uin=",
    },
    method: "get",
    xsrfCookieName: "XSRF-TOKEN",
    withCredentials: true,
  });
  const raw = response.data;
  // 去掉 JSONP 外层 callback(...)
  const parsed = JSON.parse(
    raw.replace(/callback\(|MusicJsonCallback\(|jsonCallback\(|\)$/g, "")
  );
  let translation;
  if (parsed.trans) {
    translation = he.decode(
      CryptoJs.enc.Base64.parse(parsed.trans).toString(CryptoJs.enc.Utf8)
    );
  }
  return {
    rawLrc: he.decode(
      CryptoJs.enc.Base64.parse(parsed.lyric).toString(CryptoJs.enc.Utf8)
    ),
    translation,
  };
}

// ============== 歌单导入与详情 ==============

/**
 * 导入歌单：从用户输入里解析出歌单 ID 并拉取歌曲列表
 * 支持的输入形式：
 *   1. https://i.y.qq.com/n2/m/share/details/taoge.html?id=123
 *   2. https://y.qq.com/n/ryqq/playlist/123
 *   3. 纯数字 123
 * @param {string} input 用户输入
 * @returns {Promise<Array<object>|undefined>} 歌曲列表；解析不出 ID 时返回 undefined
 */
async function importMusicSheet(input) {
  let sheetId;
  if (!sheetId) {
    sheetId = (
      input.match(
        /https?:\/\/i\.y\.qq\.com\/n2\/m\/share\/details\/taoge\.html\?.*id=([0-9]+)/
      ) || []
    )[1];
  }
  if (!sheetId) {
    sheetId = (
      input.match(/https?:\/\/y\.qq\.com\/n\/ryqq\/playlist\/([0-9]+)/) || []
    )[1];
  }
  if (!sheetId) {
    sheetId = (input.match(/^(\d+)$/) || [])[1];
  }
  if (!sheetId) {
    return;
  }
  const response = await axios({
    url:
      "http://i.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&utf8=1&disstid=" +
      sheetId +
      "&loginUin=0",
    headers: {
      Referer: "https://y.qq.com/n/yqq/playlist",
      Cookie: "uin=",
    },
    method: "get",
    xsrfCookieName: "XSRF-TOKEN",
    withCredentials: true,
  });
  const raw = response.data;
  // 去掉 JSONP 外层 callback(...)
  const parsed = JSON.parse(
    raw.replace(/callback\(|MusicJsonCallback\(|jsonCallback\(|\)$/g, "")
  );
  return parsed.cdlist[0].songlist.map(formatMusicItem);
}

// ============== 榜单 ==============

/**
 * 获取所有榜单分组
 * 调用 musicToplist.ToplistInfoServer.GetAll
 * 返回形如 [{title: "巅峰榜", data: [{id, title, ...}]}, ...]
 * @returns {Promise<Array<{title: string, data: Array}>>}
 */
async function getTopLists() {
  const requestOptions = {
    url:
      "https://u.y.qq.com/cgi-bin/musicu.fcg?_=1577086820633&data=" +
      "%7B%22comm%22%3A%7B%22g_tk%22%3A5381%2C%22uin%22%3A123456%2C%22format%22%3A%22json%22%2C%22inCharset%22%3A%22utf-8%22%2C%22outCharset%22%3A%22utf-8%22%2C%22notice%22%3A0%2C%22platform%22%3A%22h5%22%2C%22needNewCode%22%3A1%2C%22ct%22%3A23%2C%22cv%22%3A0%7D%2C%22topList%22%3A%7B%22module%22%3A%22musicToplist.ToplistInfoServer%22%2C%22method%22%3A%22GetAll%22%2C%22param%22%3A%7B%7D%7D%7D",
    method: "get",
    headers: {},
    xsrfCookieName: "XSRF-TOKEN",
    withCredentials: true,
  };
  requestOptions.headers.Cookie = "uin=";
  const response = await axios(requestOptions);
  return response.data.topList.data.group.map((group) => ({
    title: group.groupName,
    data: group.toplist.map((item) => ({
      id: item.topId,
      description: item.intro,
      title: item.title,
      period: item.period,
      coverImg: item.headPicUrl || item.frontPicUrl,
    })),
  }));
}

/**
 * 获取榜单详情（榜单下歌曲列表）
 * 调用 musicToplist.ToplistInfoServer.GetDetail
 * @param {{id: string|number, period?: string}} topList 榜单对象
 * @returns {Promise<object>} 原 topList 对象 + musicList 字段
 */
async function getTopListDetail(topList) {
  const response = await axios({
    url:
      "https://u.y.qq.com/cgi-bin/musicu.fcg?g_tk=5381&data=" +
      "%7B%22detail%22%3A%7B%22module%22%3A%22musicToplist.ToplistInfoServer%22%2C%22method%22%3A%22GetDetail%22%2C%22param%22%3A%7B%22topId%22%3A" +
      topList.id +
      "%2C%22offset%22%3A0%2C%22num%22%3A100%2C%22period%22%3A%22" +
      (topList.period ?? "") +
      "%22%7D%7D%2C%22comm%22%3A%7B%22ct%22%3A24%2C%22cv%22%3A0%7D%7D",
    method: "get",
    headers: { Cookie: "uin=" },
    xsrfCookieName: "XSRF-TOKEN",
    withCredentials: true,
  });
  return Object.assign(Object.assign({}, topList), {
    musicList: response.data.detail.data.songInfoList.map(formatMusicItem),
  });
}

// ============== 歌单分类与推荐 ==============

/**
 * 获取推荐歌单的分类标签
 * 调用 c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg
 * 返回 {pinned: [热门标签], data: [分类组]}
 * @returns {Promise<{pinned: Array, data: Array}>}
 */
async function getRecommendSheetTags() {
  const response = await axios.get(
    "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_tag_conf.fcg?format=json&inCharset=utf8&outCharset=utf-8",
    { headers: { referer: "https://y.qq.com/" } }
  );
  const categories = response.data.data.categories;
  // 第 0 项是"全部"之类的占位分类，跳过
  const groups = categories.slice(1).map((category) => ({
    title: category.categoryGroupName,
    data: category.items.map((item) => ({
      id: item.categoryId,
      title: item.categoryName,
    })),
  }));
  // pinned：每个分类组取第一项作为热门标签
  const pinned = [];
  for (const group of groups) {
    if (group.data.length) {
      pinned.push(group.data[0]);
    }
  }
  return { pinned, data: groups };
}

/**
 * 按标签拉取推荐歌单（分页）
 * 调用 c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg
 * 响应是 JSONP，需要去掉 callback 外层
 * @param {{id?: string}} tag  标签对象（tag.id 是分类 ID）
 * @param {number}        page 页码
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function getRecommendSheetsByTag(tag, page) {
  const pageSize = 20;
  const response = await axios.get(
    "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg",
    {
      headers: { referer: "https://y.qq.com/" },
      params: {
        inCharset: "utf8",
        outCharset: "utf-8",
        sortId: 5,
        categoryId: tag?.id || "10000000",
        sin: pageSize * (page - 1),
        ein: page * pageSize - 1,
      },
    }
  );
  const raw = response.data;
  const parsed = JSON.parse(
    raw.replace(/callback\(|MusicJsonCallback\(|jsonCallback\(|\)$/g, "")
  ).data;
  const isEnd = parsed.sum <= page * pageSize;
  const data = parsed.list.map((item) => ({
    id: item.dissid,
    createTime: item.createTime,
    title: item.dissname,
    artwork: item.imgurl,
    description: item.introduction,
    playCount: item.listennum,
    artist: item.creator?.name ?? "",
  }));
  return { isEnd, data };
}

/**
 * 获取歌单详情（歌曲列表）
 * 内部直接复用 importMusicSheet 拉全部歌曲
 * @param {{id: string}} sheet  歌单对象（id 字段是 URL 或纯数字 ID）
 * @param {number}       page   页码（本实现一次性返回全部，page 不参与切片）
 * @returns {Promise<{isEnd: boolean, musicList: Array}>}
 */
async function getMusicSheetInfo(sheet, page) {
  const musicList = await importMusicSheet(sheet.id);
  return { isEnd: true, musicList };
}

// ============== 播放 URL ==============

/**
 * 获取播放 URL
 * 走第三方代理 http://175.27.166.236/kgqq1/qq.php（绕过 QQ 音乐版权限制）
 * @param {{songmid: string}} song    歌曲对象（用 songmid 字段）
 * @param {string}            quality 音质档位：low / standard / high / super
 * @returns {Promise<{url: string}>}
 */
async function getMediaSource(song, quality) {
  const response = await axios.get(
    "http://175.27.166.236/kgqq1/qq.php?id=" +
      song.songmid +
      "&type=json&level=" +
      QUALITY_LEVELS[quality]
  );
  return { url: response.data.data.url };
}

// ============== 模块导出 ==============

module.exports = {
  platform: "元力QQ",
  author: "微信公众号:元力菌",
  version: "1.2.0",
  srcUrl: "https://13413.kstore.vip/yuanli/qq.js",
  cacheControl: "no-cache",
  hints: {
    importMusicSheet: [
      "QQ音乐APP：自建歌单-分享-分享到微信好友/QQ好友；然后点开并复制链接，直接粘贴即可",
      "H5：复制URL并粘贴，或者直接输入纯数字歌单ID即可",
      "导入时间和歌单大小有关，请耐心等待",
    ],
  },
  primaryKey: ["id", "songmid"],
  supportedSearchType: ["music", "album", "sheet", "artist", "lyric"],

  /**
   * 统一搜索入口（按 type 分派）
   * @param {string} keyword 关键字
   * @param {number} page    页码
   * @param {string} type    搜索类型：music / album / sheet / artist / lyric
   * @returns {Promise<{isEnd: boolean, data: Array}|undefined>}
   */
  async search(keyword, page, type) {
    if (type === "music") return await searchMusic(keyword, page);
    if (type === "album") return await searchAlbum(keyword, page);
    if (type === "artist") return await searchArtist(keyword, page);
    if (type === "sheet") return await searchMusicSheet(keyword, page);
    if (type === "lyric") return await searchLyric(keyword, page);
  },

  getMediaSource,
  getLyric,
  getAlbumInfo,
  getArtistWorks,
  importMusicSheet,
  getTopLists,
  getTopListDetail,
  getRecommendSheetTags,
  getRecommendSheetsByTag,
  getMusicSheetInfo,
};
