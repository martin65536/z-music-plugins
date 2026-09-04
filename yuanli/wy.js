/**
 * wy.js — 元力WY 网易云音乐插件
 * ------------------------------------------------------------------
 * 适用宿主：MusicFree / 同类插件系统
 * 平台标识：元力WY
 * 原作者：微信公众号「元力菌」（原始混淆版）
 * 反编译 + 变量重命名 + 注释 by Super Z
 * ------------------------------------------------------------------
 * 架构特点：
 *   - 元数据接口（搜索 / 专辑 / 歌单 / 歌词 / 榜单）直连网易云官方 weapi
 *     接口，使用标准的 AES + RSA 双重加密（与 NeteaseCloudMusicApi 项目里
 *     的 weapi 算法完全一致）
 *   - 播放 URL 走第三方代理 175.27.166.236/wy1/wy.php（绕过网易云版权限制）
 *   - 歌单导入：先 /api/v3/playlist/detail 拿 trackIds，再分批 200 条一组
 *     调 /api/song/detail 拿详情
 *   - 榜单列表：抓 music.163.com/discover/toplist 的 HTML 用 cheerio 解析
 * ------------------------------------------------------------------
 * 加密算法（weapi 标准）：
 *   1. 生成 16 位随机 secretKey
 *   2. 用固定 key "0CoJUm6Qyw8W8jud" 对 params 做 AES-CBC 加密 → 得到 enc1
 *   3. 用 secretKey 对 enc1 再做一次 AES-CBC 加密 → 得到 params
 *   4. 把 secretKey 反转后做 RSA(pubkey=010001, modulus=00e0b5...) → encSecKey
 *   5. POST application/x-www-form-urlencoded 两个字段：params + encSecKey
 * ------------------------------------------------------------------
 * 依赖：axios / crypto-js / qs / big-integer / dayjs / cheerio
 */

'use strict';

Object.defineProperty(exports, "__esModule", { value: true });

const axios = require("axios");
const CryptoJs = require("crypto-js");
const qs = require("qs");
const bigInt = require("big-integer");
const dayjs = require("dayjs");
const cheerio = require("cheerio");

// ============== weapi 加密相关 ==============

// AES IV（固定值，网易云写死在前端）
const AES_IV = "0102030405060708";

// 第一轮 AES 用的固定 key
const AES_KEY_1 = "0CoJUm6Qyw8W8jud";

// RSA 公钥指数和模数（网易写死在前端）
const RSA_PUBKEY_E = "010001";
const RSA_PUBKEY_N =
  "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b7251" +
  "52b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ec" +
  "bda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d8" +
  "13cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";

// 字符集：生成 16 位随机 secretKey 用
const SECRET_CHARSET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * 生成 16 位随机 secretKey
 * 网易云前端每次请求都生成一个新的随机 key
 * @returns {string} 16 位随机字符串
 */
function createSecretKey() {
  let key = "";
  for (let i = 0; i < 16; i++) {
    const idx = Math.floor(Math.random() * SECRET_CHARSET.length);
    key += SECRET_CHARSET.charAt(idx);
  }
  return key;
}

/**
 * AES-CBC 加密
 * @param {string} plaintext  待加密文本
 * @param {string} key        密钥（16 字节）
 * @returns {string} base64 编码的密文
 */
function aesEncrypt(plaintext, key) {
  const keyBytes = CryptoJs.enc.Utf8.parse(key);
  const ivBytes = CryptoJs.enc.Utf8.parse(AES_IV);
  const plainBytes = CryptoJs.enc.Utf8.parse(plaintext);
  const encrypted = CryptoJs.AES.encrypt(plainBytes, keyBytes, {
    iv: ivBytes,
    mode: CryptoJs.mode.CBC,
  });
  return encrypted.toString();
}

/**
 * RSA 加密（实为模幂运算，无 padding）
 * 算法：把字符串反转后转成 hex 大整数，再 modPow(e, n)
 * @param {string} text 待加密文本（通常是 secretKey）
 * @returns {string} 256 位 hex 字符串（左侧补 0 到 256 位）
 */
function rsaEncrypt(text) {
  // 反转字符串
  const reversed = text.split("").reverse().join("");
  // 转成 hex
  const hex = reversed
    .split("")
    .map((ch) => ch.charCodeAt(0).toString(16))
    .join("");
  // 大整数模幂
  const result = bigInt(hex, 16)
    .modPow(bigInt(RSA_PUBKEY_E, 16), bigInt(RSA_PUBKEY_N, 16))
    .toString(16);
  // 左侧补 0 到 256 位
  return Array(256 - result.length).fill("0").join("") + result;
}

/**
 * weapi 加密入口：把任意对象加密成 {params, encSecKey}
 * @param {object} data 待加密的请求体
 * @returns {{params: string, encSecKey: string}}
 */
function weapiEncrypt(data) {
  const json = JSON.stringify(data);
  // 第一轮：用固定 key 加密
  const enc1 = aesEncrypt(json, AES_KEY_1);
  // 第二轮：用随机 key 加密
  const secretKey = createSecretKey();
  const params = aesEncrypt(enc1, secretKey);
  // 用 RSA 加密随机 key
  const encSecKey = rsaEncrypt(secretKey);
  return { params, encSecKey };
}

// ============== 通用请求头 ==============

const COMMON_HEADERS = {
  authority: "music.163.com",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/84.0.4147.135 Safari/537.36",
  "content-type": "application/x-www-form-urlencoded",
  accept: "*/*",
  origin: "https://music.163.com",
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
  referer: "https://music.163.com/",
  "accept-language": "zh-CN,zh;q=0.9",
};

const LYRIC_HEADERS = {
  Referer: "https://y.music.163.com/",
  Origin: "https://y.music.163.com/",
  authority: "music.163.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/84.0.4147.135 Safari/537.36",
  "Content-Type": "application/x-www-form-urlencoded",
};

const SONG_DETAIL_HEADERS = {
  Referer: "https://y.music.163.com/",
  Origin: "https://y.music.163.com/",
  authority: "music.163.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/84.0.4147.135 Safari/537.36",
};

// ============== 数据格式化 ==============

/**
 * 把网易云歌曲对象归一化成 MusicFree 通用结构
 * 注意：url 字段直接拼成 share.duanx.cn 的代理 URL，但实际播放走 getMediaSource
 * @param {object} song 网易云原始歌曲对象
 */
function formatMusicItem(song) {
  const album = song.al || song.album;
  return {
    id: song.id,
    artwork: album?.picUrl,
    title: song.name,
    artist: (song.ar || song.artists)[0].name,
    album: album?.name,
    // 这个 URL 只是占位，实际播放走 getMediaSource
    url: "https://share.duanx.cn/url/wy/" + song.id + "/128k",
    qualities: {
      low: { size: (song.l || {}).size },
      standard: { size: (song.m || {}).size },
      high: { size: (song.h || {}).size },
      super: { size: (song.sq || {}).size },
    },
    copyrightId: song?.copyrightId,
  };
}

/**
 * 把专辑对象归一化
 */
function formatAlbumItem(album) {
  return {
    id: album.id,
    artist: album.artist.name,
    title: album.name,
    artwork: album.picUrl,
    description: "",
    date: dayjs.unix(album.publishTime / 1000).format("YYYY-MM-DD"),
  };
}

// ============== 搜索相关 ==============

const PAGE_SIZE = 30;

/**
 * 搜索基础函数：调用 weapi/search/get
 * @param {string} keyword 关键字
 * @param {number} page    页码
 * @param {number} type    搜索类型：1=歌曲 10=专辑 100=歌手 1000=歌单 1006=歌词
 * @returns {Promise<object>} 网易云返回的完整 result 对象
 */
async function searchBase(keyword, page, type) {
  const reqBody = {
    s: keyword,
    limit: PAGE_SIZE,
    type,
    offset: (page - 1) * PAGE_SIZE,
    csrf_token: "",
  };
  const encrypted = weapiEncrypt(reqBody);
  const formData = qs.stringify(encrypted);

  const response = await axios({
    method: "post",
    url: "https://music.163.com/weapi/search/get",
    headers: COMMON_HEADERS,
    data: formData,
  });
  return response.data;
}

/** 搜歌曲 */
async function searchMusic(keyword, page) {
  const result = await searchBase(keyword, page, 1);
  return {
    isEnd: result.result.songCount <= page * PAGE_SIZE,
    data: result.result.songs.map(formatMusicItem),
  };
}

/** 搜专辑 */
async function searchAlbum(keyword, page) {
  const result = await searchBase(keyword, page, 10);
  return {
    isEnd: result.result.albumCount <= page * PAGE_SIZE,
    data: result.result.albums.map(formatAlbumItem),
  };
}

/** 搜歌手 */
async function searchArtist(keyword, page) {
  const result = await searchBase(keyword, page, 100);
  return {
    isEnd: result.result.artistCount <= page * PAGE_SIZE,
    data: result.result.artists.map((a) => ({
      name: a.name,
      id: a.id,
      avatar: a.img1v1Url,
      worksNum: a.albumSize,
    })),
  };
}

/** 搜歌单 */
async function searchMusicSheet(keyword, page) {
  const result = await searchBase(keyword, page, 1000);
  return {
    isEnd: result.result.playlistCount <= page * PAGE_SIZE,
    data: result.result.playlists.map((p) => ({
      title: p.name,
      id: p.id,
      coverImg: p.coverImgUrl,
      artist: p.creator?.nickname,
      playCount: p.playCount,
      worksNum: p.trackCount,
    })),
  };
}

/** 搜歌词（返回带 rawLrcTxt 字段的歌曲列表） */
async function searchLyric(keyword, page) {
  const result = await searchBase(keyword, page, 1006);
  const data = (result.result.songs || []).map((s) => ({
    title: s.name,
    artist: s.ar?.map((a) => a.name).join(", "),
    id: s.id,
    artwork: s.al?.picUrl,
    album: s.al?.name,
    rawLrcTxt: s.lyrics?.join("\n"),
  }));
  return {
    isEnd: result.result.songCount <= page * PAGE_SIZE,
    data,
  };
}

// ============== 歌手作品 ==============

/**
 * 获取歌手作品（歌曲或专辑）
 * @param {{id: string}} artist  歌手对象
 * @param {number}       page    页码（网易云一次返回 50 条，不分页）
 * @param {string}       category "music" 或 "album"
 */
async function getArtistWorks(artist, page, category) {
  const reqBody = { csrf_token: "" };
  const formData = qs.stringify(weapiEncrypt(reqBody));

  if (category === "music") {
    const response = await axios({
      method: "post",
      url: "https://music.163.com/weapi/v1/artist/" + artist.id + "?csrf_token=",
      headers: COMMON_HEADERS,
      data: formData,
    });
    return {
      isEnd: true,
      data: response.data.hotSongs.map(formatMusicItem),
    };
  } else if (category === "album") {
    const response = await axios({
      method: "post",
      url: "https://music.163.com/weapi/artist/albums/" + artist.id + "?csrf_token=",
      headers: COMMON_HEADERS,
      data: formData,
    });
    return {
      isEnd: true,
      data: response.data.hotAlbums.map(formatAlbumItem),
    };
  }
}

// ============== 榜单 ==============

/**
 * 获取榜单列表：抓 HTML 页面解析
 * 网易云的 toplist 页面是服务端渲染，直接 cheerio 解析即可
 */
async function getTopLists() {
  const response = await axios.get("https://music.163.com/discover/toplist", {
    headers: {
      referer: "https://music.163.com/",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36 Edg/108.0.1462.54",
    },
  });
  const $ = cheerio.load(response.data);
  const children = $(".n-minelst").children();

  const groups = [];
  let currentGroup = {};
  for (const el of children) {
    if (el.tagName === "h2") {
      // 标题：开新分组
      if (currentGroup.title) {
        groups.push(currentGroup);
      }
      currentGroup = { title: $(el).text(), data: [] };
    } else if (el.tagName === "ul") {
      // 列表项：填充当前分组
      currentGroup.data = $(el)
        .children()
        .map((_, li) => {
          const $li = $(li);
          return {
            id: $li.attr("data-res-id"),
            coverImg: $li
              .find("img")
              .attr("src")
              .replace(/(\.jpg\?).*/, ".jpg?param=800y800"),
            title: $li.find("p.name").text(),
            description: $li.find("p.s-fc4").text(),
          };
        })
        .toArray();
    }
  }
  if (currentGroup.title) {
    groups.push(currentGroup);
  }
  return groups;
}

/**
 * 获取榜单详情：复用 getSheetMusicById（榜单在网易云内部就是特殊歌单）
 */
async function getTopListDetail(topList) {
  const musicList = await getSheetMusicById(topList.id);
  return Object.assign({}, topList, { musicList });
}

// ============== 歌词 / 单曲详情 ==============

/**
 * 获取 LRC 歌词
 * @param {{id: string}} song 歌曲对象
 */
async function getLyric(song) {
  const reqBody = { id: song.id, lv: -1, tv: -1, csrf_token: "" };
  const formData = qs.stringify(weapiEncrypt(reqBody));

  const response = await axios({
    method: "post",
    url: "https://interface.music.163.com/weapi/song/lyric?csrf_token=",
    headers: LYRIC_HEADERS,
    data: formData,
  });
  return { rawLrc: response.data.lrc.lyric };
}

/**
 * 获取单曲详情（主要用于补全封面图）
 * @param {{id: string}} song 歌曲对象
 */
async function getMusicInfo(song) {
  const response = await axios.get("http://music.163.com/api/song/detail", {
    headers: LYRIC_HEADERS,
    params: { id: song.id, ids: "[" + song.id + "]" },
  });
  return { artwork: response.data.songs[0].album.picUrl };
}

// ============== 专辑详情 ==============

/**
 * 获取专辑详情（专辑下所有歌曲）
 * @param {{id: string}} album 专辑对象
 */
async function getAlbumInfo(album) {
  const reqBody = {
    resourceType: 3,
    resourceId: album.id,
    limit: 15,
    csrf_token: "",
  };
  const formData = qs.stringify(weapiEncrypt(reqBody));

  const response = await axios({
    method: "post",
    url: "https://interface.music.163.com/weapi/v1/album/" + album.id + "?csrf_token=",
    headers: LYRIC_HEADERS,
    data: formData,
  });
  return {
    albumItem: { description: response.data.album.description },
    musicList: (response.data.songs || []).map(formatMusicItem),
  };
}

// ============== 歌单详情 ==============

/**
 * 批量获取歌曲详情（每批最多 200 首）
 * @param {number[]} songIds 歌曲 ID 数组
 * @returns {Promise<Array>} MusicFree 通用结构数组
 */
async function getValidMusicItems(songIds) {
  try {
    const response = await axios.get(
      "https://music.163.com/api/song/detail/?ids=[" + songIds.join(",") + "]",
      { headers: SONG_DETAIL_HEADERS }
    );
    return response.data.songs.map(formatMusicItem);
  } catch (e) {
    console.error(e);
    return [];
  }
}

/**
 * 通过歌单 ID 拉取所有歌曲
 * 网易云一次返回所有 trackIds，但详情需要分批 200 条一组去拉
 * @param {string} sheetId 歌单 ID
 */
async function getSheetMusicById(sheetId) {
  const response = await axios.get(
    "https://music.163.com/api/v3/playlist/detail?id=" + sheetId + "&n=5000",
    { headers: SONG_DETAIL_HEADERS }
  );
  const allTrackIds = response.data.playlist.trackIds.map((t) => t.id);

  let allSongs = [];
  let batch = 0;
  while (batch * 200 < allTrackIds.length) {
    const start = batch * 200;
    const end = (batch + 1) * 200;
    const songs = await getValidMusicItems(allTrackIds.slice(start, end));
    allSongs = allSongs.concat(songs);
    batch++;
  }
  return allSongs;
}

/**
 * 导入歌单
 * 支持的输入形式：
 *   1. https://y.music.163.com/m/playlist?id=123
 *   2. https://music.163.com/playlist/123/xxx
 *   3. https://music.163.com/#/playlist?id=123
 *   4. https://music.163.com/playlist?id=123
 *   5. 纯数字 123
 * @param {string} input 用户输入
 */
async function importMusicSheet(input) {
  const match = input.match(
    /(?:https:\/\/y\.music\.163.com\/m\/playlist\?id=([0-9]+))|(?:https?:\/\/music\.163\.com\/playlist\/([0-9]+)\/.*)|(?:https?:\/\/music.163.com(?:\/#)?\/playlist\?id=(\d+))|(?:^\s*(\d+)\s*$)/
  );
  const sheetId = match[1] || match[2] || match[3] || match[4];
  return getSheetMusicById(sheetId);
}

// ============== 歌单分类与推荐 ==============

/**
 * 获取歌单分类标签
 * 调用 weapi/playlist/catalogue，返回 {pinned: [], data: []}
 */
async function getRecommendSheetTags() {
  const reqBody = { csrf_token: "" };
  const formData = qs.stringify(weapiEncrypt(reqBody));

  const response = await axios({
    method: "post",
    url: "https://music.163.com/weapi/playlist/catalogue",
    headers: COMMON_HEADERS,
    data: formData,
  });
  const data = response.data;

  // categories 是 {0: "华语", 1: "流行", ...} 形式
  const categoryMap = {};
  const groups = Object.entries(data.categories).map(([key, title]) => {
    const group = { title, data: [] };
    categoryMap[key] = group;
    return group;
  });

  // pinned（热门标签）
  const pinned = [];
  data.sub.forEach((sub) => {
    const tag = { id: sub.name, title: sub.name };
    if (sub.hot) {
      pinned.push(tag);
    }
    categoryMap[sub.category].data.push(tag);
  });

  return { pinned, data: groups };
}

/**
 * 按标签拉取推荐歌单
 * @param {{id: string}} tag  标签对象（tag.id 是标签名，如"华语"）
 * @param {number}      page 页码
 */
async function getRecommendSheetsByTag(tag, page) {
  const pageSize = 30;
  const reqBody = {
    cat: tag.id,
    order: "hot",
    limit: pageSize,
    offset: (page - 1) * pageSize,
    total: true,
    csrf_token: "",
  };
  const formData = qs.stringify(weapiEncrypt(reqBody));

  const response = await axios({
    method: "post",
    url: "https://music.163.com/weapi/playlist/list",
    headers: COMMON_HEADERS,
    data: formData,
  });
  return {
    isEnd: response.data.more !== true,
    data: response.data.playlists.map((p) => ({
      id: p.id,
      artist: p.creator.nickname,
      title: p.name,
      artwork: p.coverImgUrl,
      playCount: p.playCount,
      createUserId: p.userId,
      createTime: p.createTime,
      description: p.description,
    })),
  };
}

/**
 * 获取歌单详情（分页）
 * 第一次访问时先拉全部 trackIds 缓存到 _trackIds 字段
 * 后续分页直接用缓存的 trackIds 切片
 * @param {{id?: string, _trackIds?: number[]}} sheet  歌单对象
 * @param {number}                              page   页码（每页 40 条）
 */
async function getMusicSheetInfo(sheet, page) {
  let trackIds = sheet._trackIds;
  if (!trackIds) {
    const response = await axios.get(
      "https://music.163.com/api/v3/playlist/detail?id=" + sheet.id + "&n=5000",
      { headers: SONG_DETAIL_HEADERS }
    );
    trackIds = response.data.playlist.trackIds.map((t) => t.id);
  }

  const PAGE = 40;
  const slice = trackIds.slice((page - 1) * PAGE, page * PAGE);
  const musicList = await getValidMusicItems(slice);

  // 第一页时把 trackIds 缓存到返回对象里，宿主会带着它请求下一页
  const extra = page <= 1 ? { _trackIds: trackIds } : {};
  return Object.assign(
    { isEnd: trackIds.length <= page * PAGE, musicList },
    extra
  );
}

// ============== 播放 URL ==============

/**
 * 音质档位映射：把 MusicFree 的 low/standard/high/super 转成网易云的 level 字段
 * 注意：网易云 level 实际是 standard / exhigh / lossless / hires 等
 */
const QUALITY_LEVELS = {
  low: "standard",
  standard: "exhigh",
  high: "lossless",
  super: "lossless",
};

/**
 * 获取播放 URL
 * 注意：这里走的是 175.27.166.236 第三方代理（绕过网易云版权限制）
 * @param {{id: string}} song    歌曲对象
 * @param {string}       quality 音质档位
 */
async function getMediaSource(song, quality) {
  const response = await axios.get(
    "http://175.27.166.236/wy1/wy.php?id=" +
      song.id +
      "&level=" +
      QUALITY_LEVELS[quality]
  );
  return { url: response.data.data.url };
}

// ============== 模块导出 ==============

module.exports = {
  platform: "元力WY",
  author: "微信公众号:元力菌",
  version: "1.2.0",
  srcUrl: "https://13413.kstore.vip/yuanli/wy.js",
  cacheControl: "no-store",
  hints: {
    importMusicSheet: [
      "网易云：APP点击分享，然后复制链接",
      "默认歌单无法导入，先新建一个空白歌单复制过去再导入新歌单即可",
    ],
  },
  supportedSearchType: ["music", "album", "sheet", "artist", "lyric"],

  async search(keyword, page, type) {
    if (type === "music") return await searchMusic(keyword, page);
    if (type === "album") return await searchAlbum(keyword, page);
    if (type === "artist") return await searchArtist(keyword, page);
    if (type === "sheet") return await searchMusicSheet(keyword, page);
    if (type === "lyric") return await searchLyric(keyword, page);
  },

  getMediaSource,
  getMusicInfo,
  getAlbumInfo,
  getLyric,
  getArtistWorks,
  importMusicSheet,
  getTopLists,
  getTopListDetail,
  getRecommendSheetTags,
  getMusicSheetInfo,
  getRecommendSheetsByTag,
};
