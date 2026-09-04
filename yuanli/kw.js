/**
 * kw.js — 元力KW 酷我音乐插件
 * ------------------------------------------------------------------
 * 适用宿主：MusicFree / 同类插件系统
 * 平台标识：元力KW
 * 原作者：微信公众号「元力菌」（原始混淆版）
 * 反编译 + 变量重命名 + 注释 by Super Z
 * ------------------------------------------------------------------
 * 架构特点：
 *   - 元数据接口（搜索 / 专辑 / 歌单 / 歌词 / 歌手作品 / 榜单）直连酷我
 *     官方接口，不走任何代理
 *       * search.kuwo.cn/r.s          通用搜索（歌曲 / 专辑 / 歌手 / 歌单 / 歌手作品 / 专辑详情）
 *       * wapi.kuwo.cn/api/pc/...     PC 端榜单列表、推荐歌单分类与列表
 *       * mobileinterfaces.kuwo.cn    移动端专题歌单（digest != 10000）
 *       * nplserver.kuwo.cn/pl.svc    歌单详情（带分页）
 *       * kbangserver.kuwo.cn/ksong.s 榜单详情
 *       * m.kuwo.cn/newh5/...         H5 单曲信息 + 歌词
 *   - 播放 URL 走第三方代理 music.haitangw.cc/music1/kw.php（绕过酷我版权限制）
 *   - 歌单导入：自动从分享链接 / 纯数字 ID 中提取歌单 ID，按 80 条/页分页
 *     拉取，每页之间随机 sleep 200~300ms 避免限流
 *   - 支持的搜索类型：music / album / sheet / artist（不支持歌词搜索）
 * ------------------------------------------------------------------
 * 字段命名约定（与酷我接口字段名一致）：
 *   - MUSICRID / MUSIC_前缀  酷我歌曲唯一标识
 *   - web_albumpic_short     封面短路径（需 artworkShort2Long 拼成完整 URL）
 *   - FORMATS                可播放音质列表，例如 "mp3|flac|ape"
 *   - digest == "10000"      标签走通用推荐接口；否则走专题接口
 * ------------------------------------------------------------------
 * 依赖：axios / he（HTML 实体解码，酷我搜索结果普遍带 &amp; 之类）
 */

'use strict';

Object.defineProperty(exports, "__esModule", { value: true });

const axios = require("axios");
const he = require("he");

// ============== 通用常量 ==============

/** 搜索 / 分页时每页条数 */
const PAGE_SIZE = 30;

/**
 * 音质档位映射：把 MusicFree 的 low/standard/high/super 映射到酷我代理
 * 接口可识别的 level 字段。low 和 standard 都映射成 exhigh，high 和 super
 * 都映射成 lossless（酷我代理实际只支持这两个档位）。
 */
const QUALITY_LEVELS = {
  low: "exhigh",
  standard: "exhigh",
  high: "lossless",
  super: "lossless",
};

// ============== 数据格式化 ==============

/**
 * 把酷我的封面短路径（如 /300/xx/yy.jpg）补全成 1080 尺寸的完整 URL
 * 酷我搜索接口返回的 web_albumpic_short 只有一段相对路径，需要拼上
 * 固定的 host + /star/albumcover/1080 前缀
 * @param {string|undefined} shortUrl 封面短路径
 * @returns {string|undefined} 完整 URL；若入参不含 "/" 则返回 undefined
 */
function artworkShort2Long(shortUrl) {
  const slashIndex = (shortUrl === null || shortUrl === undefined
    ? undefined
    : shortUrl.indexOf("/")) ?? -1;
  if (slashIndex !== -1) {
    return "https://img4.kuwo.cn/star/albumcover/1080" + shortUrl.slice(slashIndex);
  } else {
    return undefined;
  }
}

/**
 * 把搜索接口返回的歌曲对象归一化成 MusicFree 通用结构
 * 注意：MUSICRID 形如 "MUSIC_12345"，需要把 "MUSIC_" 前缀去掉
 * @param {object} rawMusic 酷我原始歌曲对象
 * @returns {object} MusicFree 通用歌曲结构
 */
function formatMusicItem(rawMusic) {
  return {
    id: rawMusic.MUSICRID.replace("MUSIC_", ""),
    artwork: artworkShort2Long(rawMusic.web_albumpic_short),
    title: he.decode(rawMusic.NAME || ""),
    artist: he.decode(rawMusic.ARTIST || ""),
    album: he.decode(rawMusic.ALBUM || ""),
    albumId: rawMusic.ALBUMID,
    artistId: rawMusic.ARTISTID,
    formats: rawMusic.FORMATS,
  };
}

/**
 * 把搜索 / 专辑列表接口返回的专辑对象归一化
 * 封面优先用 img，其次用 pic 走 artworkShort2Long 补全
 * @param {object} rawAlbum 酷我原始专辑对象
 * @returns {object} MusicFree 通用专辑结构
 */
function formatAlbumItem(rawAlbum) {
  return {
    id: rawAlbum.albumid,
    artist: he.decode(rawAlbum.artist || ""),
    title: he.decode(rawAlbum.name || ""),
    artwork: rawAlbum.img ?? artworkShort2Long(rawAlbum.pic),
    description: he.decode(rawAlbum.info || ""),
    date: rawAlbum.pub,
    artistId: rawAlbum.artistid,
  };
}

/**
 * 把搜索接口返回的歌手对象归一化
 * @param {object} rawArtist 酷我原始歌手对象
 * @returns {object} MusicFree 通用歌手结构
 */
function formatArtistItem(rawArtist) {
  return {
    id: rawArtist.ARTISTID,
    avatar: rawArtist.hts_PICPATH,
    name: he.decode(rawArtist.ARTIST || ""),
    artistId: rawArtist.ARTISTID,
    description: he.decode(rawArtist.desc || ""),
    worksNum: rawArtist.SONGNUM,
  };
}

/**
 * 把搜索接口返回的歌单对象归一化
 * @param {object} rawSheet 酷我原始歌单对象
 * @returns {object} MusicFree 通用歌单结构
 */
function formatMusicSheet(rawSheet) {
  return {
    id: rawSheet.playlistid,
    title: he.decode(rawSheet.name || ""),
    artist: he.decode(rawSheet.nickname || ""),
    artwork: rawSheet.pic,
    playCount: rawSheet.playcnt,
    description: he.decode(rawSheet.intro || ""),
    worksNum: rawSheet.songnum,
  };
}

// ============== 搜索相关 ==============

/**
 * 搜索歌曲
 * @param {string} keyword 关键字
 * @param {number} page    页码（从 1 开始）
 * @returns {Promise<{isEnd: boolean, data: object[]}>}
 */
async function searchMusic(keyword, page) {
  const response = (await axios({
    method: "get",
    url: "http://search.kuwo.cn/r.s",
    params: {
      client: "kt",
      all: keyword,
      pn: page - 1,
      rn: PAGE_SIZE,
      uid: 2574109560,
      ver: "kwplayer_ar_8.5.4.2",
      vipver: 1,
      ft: "music",
      cluster: 0,
      strategy: 2012,
      encoding: "utf8",
      rformat: "json",
      vermerge: 1,
      mobi: 1,
    },
  })).data;
  const musicList = response.abslist.map(formatMusicItem);
  return {
    isEnd: (+response.PN + 1) * +response.RN >= +response.TOTAL,
    data: musicList,
  };
}

/**
 * 搜索专辑
 * @param {string} keyword 关键字
 * @param {number} page    页码（从 1 开始）
 * @returns {Promise<{isEnd: boolean, data: object[]}>}
 */
async function searchAlbum(keyword, page) {
  const response = (await axios({
    method: "get",
    url: "http://search.kuwo.cn/r.s",
    params: {
      all: keyword,
      ft: "album",
      itemset: "web_2013",
      client: "kt",
      pn: page - 1,
      rn: PAGE_SIZE,
      rformat: "json",
      encoding: "utf8",
      pcjson: 1,
    },
  })).data;
  const albumList = response.albumlist.map(formatAlbumItem);
  return {
    isEnd: (+response.PN + 1) * +response.RN >= +response.TOTAL,
    data: albumList,
  };
}

/**
 * 搜索歌手
 * @param {string} keyword 关键字
 * @param {number} page    页码（从 1 开始）
 * @returns {Promise<{isEnd: boolean, data: object[]}>}
 */
async function searchArtist(keyword, page) {
  const response = (await axios({
    method: "get",
    url: "http://search.kuwo.cn/r.s",
    params: {
      all: keyword,
      ft: "artist",
      itemset: "web_2013",
      client: "kt",
      pn: page - 1,
      rn: PAGE_SIZE,
      rformat: "json",
      encoding: "utf8",
      pcjson: 1,
    },
  })).data;
  const artistList = response.abslist.map(formatArtistItem);
  return {
    isEnd: (+response.PN + 1) * +response.RN >= +response.TOTAL,
    data: artistList,
  };
}

/**
 * 搜索歌单
 * @param {string} keyword 关键字
 * @param {number} page    页码（从 1 开始）
 * @returns {Promise<{isEnd: boolean, data: object[]}>}
 */
async function searchMusicSheet(keyword, page) {
  const response = (await axios({
    method: "get",
    url: "http://search.kuwo.cn/r.s",
    params: {
      all: keyword,
      ft: "playlist",
      itemset: "web_2013",
      client: "kt",
      pn: page - 1,
      rn: PAGE_SIZE,
      rformat: "json",
      encoding: "utf8",
      pcjson: 1,
    },
  })).data;
  const sheetList = response.abslist.map(formatMusicSheet);
  return {
    isEnd: (+response.PN + 1) * +response.RN >= +response.TOTAL,
    data: sheetList,
  };
}

// ============== 歌手作品 ==============

/**
 * 获取歌手的所有歌曲（分页）
 * 注意：返回字段用小写（musicrid / name / albumid ...），与搜索接口大写
 * 字段不同，所以不能复用 formatMusicItem，需要单独 map
 * @param {{id: string}} artist 歌手对象
 * @param {number}       page   页码（从 1 开始）
 * @returns {Promise<{isEnd: boolean, data: object[]}>}
 */
async function getArtistMusicWorks(artist, page) {
  const response = (await axios({
    method: "get",
    url: "http://search.kuwo.cn/r.s",
    params: {
      pn: page - 1,
      rn: PAGE_SIZE,
      artistid: artist.id,
      stype: "artist2music",
      sortby: 0,
      alflac: 1,
      show_copyright_off: 1,
      pcmp4: 1,
      encoding: "utf8",
      plat: "pc",
      thost: "search.kuwo.cn",
      vipver: "MUSIC_9.1.1.2_BCS2",
      devid: "38668888",
      newver: 1,
      pcjson: 1,
    },
  })).data;
  const musicList = response.musiclist.map((rawMusic) => {
    return {
      id: rawMusic.musicrid,
      artwork: artworkShort2Long(rawMusic.web_albumpic_short),
      title: he.decode(rawMusic.name || ""),
      artist: he.decode(rawMusic.artist || ""),
      album: he.decode(rawMusic.album || ""),
      albumId: rawMusic.albumid,
      artistId: rawMusic.artistid,
      formats: rawMusic.formats,
    };
  });
  return {
    isEnd: (+response.pn + 1) * PAGE_SIZE >= +response.total,
    data: musicList,
  };
}

/**
 * 获取歌手的所有专辑（分页，按时间倒序 sortby=1）
 * @param {{id: string}} artist 歌手对象
 * @param {number}       page   页码（从 1 开始）
 * @returns {Promise<{isEnd: boolean, data: object[]}>}
 */
async function getArtistAlbumWorks(artist, page) {
  const response = (await axios({
    method: "get",
    url: "http://search.kuwo.cn/r.s",
    params: {
      pn: page - 1,
      rn: PAGE_SIZE,
      artistid: artist.id,
      stype: "albumlist",
      sortby: 1,
      alflac: 1,
      show_copyright_off: 1,
      pcmp4: 1,
      encoding: "utf8",
      plat: "pc",
      thost: "search.kuwo.cn",
      vipver: "MUSIC_9.1.1.2_BCS2",
      devid: "38668888",
      newver: 1,
      pcjson: 1,
    },
  })).data;
  const albumList = response.albumlist.map(formatAlbumItem);
  return {
    isEnd: (+response.pn + 1) * PAGE_SIZE >= +response.total,
    data: albumList,
  };
}

/**
 * 获取歌手作品（按类型分发到 music 或 album 子函数）
 * @param {{id: string}}  artist   歌手对象
 * @param {number}        page     页码
 * @param {"music"|"album"} category 作品类型
 * @returns {Promise<{isEnd: boolean, data: object[]}|undefined>}
 */
async function getArtistWorks(artist, page, category) {
  if (category === "music") {
    return getArtistMusicWorks(artist, page);
  } else if (category === "album") {
    return getArtistAlbumWorks(artist, page);
  }
}

// ============== 歌词 / 单曲详情 ==============

/**
 * 获取 LRC 歌词
 * 走 m.kuwo.cn 的 H5 接口，返回 {time, lineLyric} 数组，需手动拼成 LRC 文本
 * @param {{id: string}} song 歌曲对象
 * @returns {Promise<{rawLrc: string}>} LRC 格式文本
 */
async function getLyric(song) {
  const params = {
    musicId: song.id,
    httpStatus: 1,
  };
  const config = {
    params: params,
  };
  const response = (await axios.get(
    "http://m.kuwo.cn/newh5/singles/songinfoandlrc",
    config
  )).data;
  const lyricList = response.data.lrclist;
  return {
    rawLrc: lyricList
      .map((line) => "[" + line.time + "]" + line.lineLyric)
      .join("\n"),
  };
}

/**
 * 获取单曲详情（主要用于补全高清封面图）
 * 酷我返回的 pic 路径里 starheads/<n> 或 albumcover/<n> 中的尺寸数字会被
 * 替换成 800，得到高清版本
 * @param {{id: string}} song 歌曲对象
 * @returns {Promise<{artwork: string|undefined}>}
 */
async function getMusicInfo(song) {
  const params = {
    musicId: song.id,
    httpStatus: 1,
  };
  const config = {
    params: params,
  };
  const response = (await axios.get(
    "http://m.kuwo.cn/newh5/singles/songinfoandlrc",
    config
  )).data;
  const picUrl = response.data.songinfo.pic;
  let artworkUrl;
  if (picUrl.includes("starheads/")) {
    artworkUrl = picUrl.replace(/starheads\/\d+/, "starheads/800");
  } else if (picUrl.includes("albumcover/")) {
    artworkUrl = picUrl.replace(/albumcover\/\d+/, "albumcover/800");
  }
  const result = {
    artwork: artworkUrl,
  };
  return result;
}

// ============== 专辑详情 ==============

/**
 * 获取专辑详情（专辑下所有歌曲）
 * 一次性返回 100 条；专辑内歌曲的 id 字段已经是纯数字（不带 MUSIC_ 前缀）
 * 封面优先用入参 album.artwork，否则用接口返回的 img
 * @param {{id: string, artwork?: string}} album 专辑对象
 * @returns {Promise<{musicList: object[]}>}
 */
async function getAlbumInfo(album) {
  const requestConfig = {
    method: "get",
    url: "http://search.kuwo.cn/r.s",
    params: {},
  };
  requestConfig.params.pn = 0;
  requestConfig.params.rn = 100;
  requestConfig.params.albumid = album.id;
  requestConfig.params.stype = "albuminfo";
  requestConfig.params.sortby = 0;
  requestConfig.params.alflac = 1;
  requestConfig.params.show_copyright_off = 1;
  requestConfig.params.pcmp4 = 1;
  requestConfig.params.encoding = "utf8";
  requestConfig.params.plat = "pc";
  requestConfig.params.thost = "search.kuwo.cn";
  requestConfig.params.vipver = "MUSIC_9.1.1.2_BCS2";
  requestConfig.params.devid = "38668888";
  requestConfig.params.newver = 1;
  requestConfig.params.pcjson = 1;
  const response = (await axios(requestConfig)).data;
  const musicList = response.musiclist.map((rawMusic) => {
    return {
      id: rawMusic.id,
      artwork: album.artwork ?? response.img,
      title: he.decode(rawMusic.name || ""),
      artist: he.decode(rawMusic.artist || ""),
      album: he.decode(rawMusic.album || ""),
      albumId: album.id,
      artistId: rawMusic.artistid,
      formats: rawMusic.formats,
    };
  });
  const result = {
    musicList: musicList,
  };
  return result;
}

// ============== 榜单 ==============

/**
 * 获取榜单列表（按分类分组返回）
 * 酷我的榜单分两层：第一层是大类（如"官方榜"），第二层是具体榜单
 * @returns {Promise<Array<{title: string, data: object[]}>>}
 */
async function getTopLists() {
  const groupList = (await axios.get("http://wapi.kuwo.cn/api/pc/bang/list")).data.child;
  return groupList.map((group) => ({
    title: group.disname,
    data: group.child.map((topListItem) => {
      return {
        id: topListItem.sourceid,
        coverImg: topListItem.pic5 ?? topListItem.pic2 ?? topListItem.pic,
        title: topListItem.name,
        description: topListItem.intro,
      };
    }),
  }));
}

/**
 * 获取榜单详情（榜单下所有歌曲）
 * 走 kbangserver.kuwo.cn/ksong.s，一次返回 80 条
 * 返回值会把入参 topList 的字段和 musicList 合并
 * @param {{id: string}} topList 榜单对象
 * @returns {Promise<object>} 入参字段 + musicList
 */
async function getTopListDetail(topList) {
  const params = {
    from: "pc",
    fmt: "json",
    pn: 0,
    rn: 80,
    type: "bang",
    data: "content",
    id: topList.id,
    show_copyright_off: 0,
    pcmp4: 1,
    isbang: 1,
    userid: 0,
    httpStatus: 1,
  };
  const config = {
    params: params,
  };
  const response = await axios.get("http://kbangserver.kuwo.cn/ksong.s", config);
  return Object.assign(Object.assign({}, topList), {
    musicList: response.data.musiclist.map((rawMusic) => {
      return {
        id: rawMusic.id,
        title: he.decode(rawMusic.name || ""),
        artist: he.decode(rawMusic.artist || ""),
        album: he.decode(rawMusic.album || ""),
        albumId: rawMusic.albumid,
        artistId: rawMusic.artistid,
        formats: rawMusic.formats,
      };
    }),
  });
}

// ============== 歌单详情 / 导入 ==============

/**
 * 按 ID 拉取歌单原始响应（带分页）
 * @param {string} sheetId  歌单 ID
 * @param {number} page     页码（从 1 开始）
 * @param {number} [pageSize=50] 每页条数
 * @returns {Promise<object>} 酷我原始响应（含 musicList / total 等字段）
 */
async function getMusicSheetResponseById(sheetId, page, pageSize = 50) {
  return (await axios.get("http://nplserver.kuwo.cn/pl.svc", {
    params: {
      op: "getlistinfo",
      pid: sheetId,
      pn: page - 1,
      rn: pageSize,
      encode: "utf8",
      keyset: "pl2012",
      vipver: "MUSIC_9.1.1.2_BCS2",
      newver: 1,
    },
  })).data;
}

/**
 * 导入歌单（全量拉取所有歌曲）
 * 支持的输入形式：
 *   1. http(s)://www.kuwo.cn/playlist_detail/<id>   （注：原始正则里写的是 www\/kuwo，按原样保留）
 *   2. http(s)://m.kuwo.cn/h5app/playlist/<id>
 *   3. 纯数字 ID
 * 每页拉 80 条，每页之间 sleep 200~300ms 防止限流；单页失败直接吞掉继续
 * @param {string} input 用户输入的链接或 ID
 * @returns {Promise<object[]|undefined>} 全部歌曲数组；解析不到 ID 时返回 undefined
 */
async function importMusicSheet(input) {
  let sheetId;
  if (!sheetId) {
    sheetId = input.match(/https?:\/\/www\/kuwo\.cn\/playlist_detail\/(\d+)/)?.[1];
  }
  if (!sheetId) {
    sheetId = input.match(/https?:\/\/m\.kuwo\.cn\/h5app\/playlist\/(\d+)/)?.[1];
  }
  if (!sheetId) {
    sheetId = input.match(/^\s*(\d+)\s*$/);
  }
  if (!sheetId) {
    return;
  }
  let currentPage = 1;
  let totalPages = 30;
  let allSongs = [];
  while (currentPage < totalPages) {
    try {
      const response = await getMusicSheetResponseById(sheetId, currentPage, 80);
      totalPages = Math.ceil(response.total / 80);
      if (isNaN(totalPages)) {
        totalPages = 1;
      }
      allSongs = allSongs.concat(
        response.musicList.map((rawMusic) => ({
          id: rawMusic.id,
          title: he.decode(rawMusic.name || ""),
          artist: he.decode(rawMusic.artist || ""),
          album: he.decode(rawMusic.album || ""),
          albumId: rawMusic.albumid,
          artistId: rawMusic.artistid,
          formats: rawMusic.formats,
        }))
      );
    } catch (_err) {
      // 单页失败直接跳过，继续拉下一页
    }
    await new Promise((resolve) => {
      setTimeout(() => {
        resolve();
      }, 200 + Math.random() * 100);
    });
    ++currentPage;
  }
  return allSongs;
}

/**
 * 获取歌单详情（分页）
 * @param {{id: string}} sheet 歌单对象
 * @param {number}       page  页码（从 1 开始，每页 PAGE_SIZE 条）
 * @returns {Promise<{isEnd: boolean, musicList: object[]}>}
 */
async function getMusicSheetInfo(sheet, page) {
  const response = await getMusicSheetResponseById(sheet.id, page, PAGE_SIZE);
  return {
    isEnd: page * PAGE_SIZE >= response.total,
    musicList: response.musiclist.map((rawMusic) => ({
      id: rawMusic.id,
      title: he.decode(rawMusic.name || ""),
      artist: he.decode(rawMusic.artist || ""),
      album: he.decode(rawMusic.album || ""),
      albumId: rawMusic.albumid,
      artistId: rawMusic.artistid,
      formats: rawMusic.formats,
    })),
  };
}

// ============== 歌单分类与推荐 ==============

/**
 * 获取歌单分类标签
 * 返回 {data: 分类列表, pinned: 固定置顶标签}
 * pinned 里的"翻唱/网络/伤感/欧美"是作者手动写死的（酷我官方接口没暴露）
 * @returns {Promise<{data: object[], pinned: object[]}>}
 */
async function getRecommendSheetTags() {
  const tagData = (await axios.get(
    "http://wapi.kuwo.cn/api/pc/classify/playlist/getTagList?cmd=rcm_keyword_playlist&user=0&prod=kwplayer_pc_9.0.5.0&vipver=9.0.5.0&source=kwplayer_pc_9.0.5.0&loginUid=0&loginSid=0&appUid=76039576"
  )).data.data;
  const tagGroups = tagData
    .map((group) => ({
      title: group.name,
      data: group.data.map((tag) => ({
        id: tag.id,
        digest: tag.digest,
        title: tag.name,
      })),
    }))
    .filter((group) => group.data.length);
  const pinnedTags = [
    { id: "1848", title: "翻唱", digest: "10000" },
    { id: "621", title: "网络", digest: "10000" },
    { title: "伤感", digest: "10000", id: "146" },
    { title: "欧美", digest: "10000", id: "35" },
  ];
  const result = {
    data: tagGroups,
    pinned: pinnedTags,
  };
  return result;
}

/**
 * 按标签拉取推荐歌单
 * 三种分支：
 *   - 有 id 且 digest == "10000"：走通用 getTagPlayList 接口
 *   - 有 id 但 digest != "10000"：走 mobileinterfaces.kuwo.cn 的专题接口，
 *     把多组 list 拍平成一个数组
 *   - 没有 id：走 getRcmPlayList 推荐接口（按热度排序）
 * @param {{id?: string, digest?: string}} tag  标签对象
 * @param {number}                          page 页码（从 1 开始）
 * @returns {Promise<{isEnd: boolean, data: object[]}>}
 */
async function getRecommendSheetsByTag(tag, page) {
  const sheetPageSize = 20;
  let responseData;
  if (tag.id) {
    if (tag.digest === "10000") {
      responseData = (await axios.get(
        "http://wapi.kuwo.cn/api/pc/classify/playlist/getTagPlayList?loginUid=0&loginSid=0&appUid=76039576&pn=" +
          (page - 1) + "&id=" + tag.id + "&rn=" + sheetPageSize
      )).data.data;
    } else {
      const specialData = (await axios.get(
        "http://mobileinterfaces.kuwo.cn/er.s?type=get_pc_qz_data&f=web&id=" +
          tag.id + "&prod=pc"
      )).data;
      responseData = {
        total: 0,
        data: specialData.reduce((acc, group) => [...acc, ...group.list]),
      };
    }
  } else {
    responseData = (await axios.get(
      "https://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?loginUid=0&loginSid=0&appUid=76039576&&pn=" +
        (page - 1) + "&rn=" + sheetPageSize + "&order=hot"
    )).data.data;
  }
  const isEnd = page * sheetPageSize >= responseData.total;
  return {
    isEnd: isEnd,
    data: responseData.data.map((sheet) => ({
      title: sheet.name,
      artist: sheet.uname,
      id: sheet.id,
      artwork: sheet.img,
      playCount: sheet.listencnt,
      createUserId: sheet.uid,
    })),
  };
}

// ============== 播放 URL ==============

/**
 * 获取播放 URL
 * 注意：这里走的是第三方代理 music.haitangw.cc/music1/kw.php（绕过酷我版权限制）
 * @param {{id: string}} song    歌曲对象
 * @param {string}       quality 音质档位（low / standard / high / super）
 * @returns {Promise<{url: string}>}
 */
async function getMediaSource(song, quality) {
  const response = (await axios.get(
    "https://music.haitangw.cc/music1/kw.php?id=" +
      song.id + "&level=" + QUALITY_LEVELS[quality]
  )).data;
  const result = {
    url: response.data.url,
  };
  return result;
}

// ============== 模块导出 ==============

module.exports = {
  platform: "元力KW",
  author: "微信公众号:元力菌",
  version: "1.2.0",
  srcUrl: "https://13413.kstore.vip/yuanli/kw.js",
  cacheControl: "no-cache",
  hints: {
    importMusicSheet: [
      "酷我APP：自建歌单-分享-复制试听链接，直接粘贴即可",
      "H5：复制URL并粘贴，或者直接输入纯数字歌单ID即可",
      "导入时间和歌单大小有关，请耐心等待",
    ],
  },
  supportedSearchType: ["music", "album", "sheet", "artist"],

  /**
   * 统一搜索入口
   * @param {string} keyword 关键字
   * @param {number} page    页码
   * @param {"music"|"album"|"artist"|"sheet"} type 搜索类型
   */
  async search(keyword, page, type) {
    if (type === "music") {
      return await searchMusic(keyword, page);
    }
    if (type === "album") {
      return await searchAlbum(keyword, page);
    }
    if (type === "artist") {
      return await searchArtist(keyword, page);
    }
    if (type === "sheet") {
      return await searchMusicSheet(keyword, page);
    }
  },

  getMediaSource: getMediaSource,
  getMusicInfo: getMusicInfo,
  getAlbumInfo: getAlbumInfo,
  getLyric: getLyric,
  getArtistWorks: getArtistWorks,
  getTopLists: getTopLists,
  getTopListDetail: getTopListDetail,
  importMusicSheet: importMusicSheet,
  getRecommendSheetTags: getRecommendSheetTags,
  getRecommendSheetsByTag: getRecommendSheetsByTag,
  getMusicSheetInfo: getMusicSheetInfo,
};
