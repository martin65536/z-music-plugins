/**
 * xiaomi.js — 元力MG 咪咕音乐插件
 * ------------------------------------------------------------------
 * 适用宿主：MusicFree / 同类插件系统
 * 平台标识：元力MG
 * 原作者：微信公众号「元力菌」（原始混淆版）
 * 反编译 + 变量重命名 + 注释 by Super Z
 * ------------------------------------------------------------------
 * 架构特点：
 *   - 元数据接口（搜索 / 专辑 / 歌手 / 歌词 / 歌单）直连咪咕官方接口
 *     m.music.migu.cn / music.migu.cn，无加密
 *   - 搜索类型映射：music=2 / album=4 / artist=1 / sheet=6 / lyric=7
 *   - 歌手专辑列表走 music.migu.cn/v3/music/artist/<id>/album 抓 HTML
 *     页面，用 cheerio 解析
 *   - 歌单导入支持 migu.cn PC / H5 / c.migu.cn 短链 / 纯数字 ID 多种形式：
 *       1. 解析出 playlistId
 *       2. 调 query_playlist_by_id_tag 拿 contentCount
 *       3. 分页抓 HTML 拿所有 copyrightId
 *       4. 一次性调 audioPlayer/songs 拿歌曲详情
 *       5. 过滤掉 VIP 歌曲（vipFlag === 0）
 *   - 榜单列表硬编码两组（咪咕尖叫榜 + 咪咕特色榜），不调接口
 *   - 播放 URL 走第三方代理 music.haitangw.cc/musicapi1/mg.php
 *     （绕过咪咕版权限制）
 * ------------------------------------------------------------------
 * By 头说明：
 *   - m.music.migu.cn 的 migumusic/h5/* 接口需要 By 头校验
 *   - 大部分接口写死 By: "7242bd16f68cd9b39c54a8e61537009f"
 *   - billboard/home 接口源码里写的是 By: MD5(UA)，与上面其实是同一个值
 * ------------------------------------------------------------------
 * 依赖：axios / crypto-js / cheerio
 */

'use strict';

Object.defineProperty(exports, "__esModule", { value: true });

const axios = require("axios");
const cheerio = require("cheerio");
const CryptoJS = require("crypto-js");

// ============== 常量 ==============

// 咪咕 m 站 Linux Android UA（被多个接口共用）
const MIGU_M_UA =
  "Mozilla/5.0 (Linux; Android 6.0.1; Moto G (4)) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/89.0.4389.114 Mobile Safari/537.36 Edg/89.0.774.68";

// 咪咕 PC 站 UA（抓 HTML 用）
const MIGU_PC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36";

// 咪咕 H5 iPhone UA（migumusic/h5/* 接口专用）
const MIGU_IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 " +
  "Mobile/15E148 Safari/604.1 Edg/113.0.0.0";

// migumusic/h5/* 接口需要的 By 头（写死的 MD5）
const BY_H5 = "7242bd16f68cd9b39c54a8e61537009f";

// billboard/home 接口的 By 头（源码里写的是 MD5(MIGU_M_UA)，与 BY_H5 相同）
const BY_BILLBOARD = CryptoJS.MD5(MIGU_M_UA).toString();

// 搜索每页条数（咪咕搜索接口固定 20 条/页）
const SEARCH_PAGE_SIZE = 20;

// 音质档位映射：MusicFree 档位 → 咪咕档位
const QUALITY_LEVELS = {
  low: "standard",
  standard: "exhigh",
  high: "lossless",
  super: "lossless",
};

/**
 * 构造 m.music.migu.cn 的标准 JSON 接口请求头
 * 搜索 / 歌手作品 / 歌词 / 专辑详情等接口共用这套头，区别只在 Referer
 * @param {string} referer Referer 头的值
 * @returns {object} axios headers 对象
 */
function buildMiguApiHeaders(referer) {
  return {
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    Connection: "keep-alive",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    Host: "m.music.migu.cn",
    Referer: referer,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": MIGU_M_UA,
    "X-Requested-With": "XMLHttpRequest",
  };
}

// ============== 通用工具 ==============

/**
 * 判断歌曲是否可播放（有任一可用播放 URL 字段即视为可播放）
 * 咪咕搜索结果里同一首歌可能返回 mp3 / listenUrl / lisQq / lisCr 多种字段，
 * 这里返回第一个非空的字段
 * @param {object} song 咪咕原始歌曲对象
 * @returns {string|undefined} 第一个可用的播放 URL，否则 undefined
 */
function musicCanPlayFilter(song) {
  return song.mp3 || song.listenUrl || song.lisQq || song.lisCr;
}

// ============== 搜索 ==============

/**
 * 搜索基础函数：调用 m.music.migu.cn/migu/remoting/scr_search_tag
 * @param {string} keyword 关键字
 * @param {number} page    页码（从 1 开始）
 * @param {number} type    搜索类型：2=歌曲 4=专辑 1=歌手 6=歌单 7=歌词
 * @returns {Promise<object>} 咪咕原始返回数据
 */
async function searchBase(keyword, page, type) {
  const headers = buildMiguApiHeaders(
    "https://m.music.migu.cn/v3/search?keyword=" + encodeURIComponent(keyword)
  );
  const response = await axios.get(
    "https://m.music.migu.cn/migu/remoting/scr_search_tag",
    {
      headers,
      params: {
        keyword,
        type,
        pgc: page,
        rows: SEARCH_PAGE_SIZE,
      },
    }
  );
  return response.data;
}

/**
 * 搜歌曲
 * @param {string} keyword 关键字
 * @param {number} page    页码
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function searchMusic(keyword, page) {
  const result = await searchBase(keyword, page, 2);
  const data = result.musics.map((song) => ({
    id: song.id,
    artwork: song.cover,
    title: song.songName,
    artist: song.artist,
    album: song.albumName,
    url: musicCanPlayFilter(song),
    copyrightId: song.copyrightId,
    singerId: song.singerId,
  }));
  return {
    isEnd: +result.pageNo * SEARCH_PAGE_SIZE >= result.pgt,
    data,
  };
}

/**
 * 搜专辑
 * @param {string} keyword 关键字
 * @param {number} page    页码
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function searchAlbum(keyword, page) {
  const result = await searchBase(keyword, page, 4);
  const data = result.albums.map((album) => ({
    id: album.id,
    artwork: album.albumPicL,
    title: album.title,
    date: album.publishDate,
    artist: (album.singer || []).map((s) => s.name).join(","),
    singer: album.singer,
    fullSongTotal: album.fullSongTotal,
  }));
  return {
    isEnd: +result.pageNo * SEARCH_PAGE_SIZE >= result.pgt,
    data,
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
  const data = result.artists.map((artist) => ({
    name: artist.title,
    id: artist.id,
    avatar: artist.artistPicL,
    worksNum: artist.songNum,
  }));
  return {
    isEnd: +result.pageNo * SEARCH_PAGE_SIZE >= result.pgt,
    data,
  };
}

/**
 * 搜歌单
 * @param {string} keyword 关键字
 * @param {number} page    页码
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function searchMusicSheet(keyword, page) {
  const result = await searchBase(keyword, page, 6);
  const data = result.songLists.map((sheet) => ({
    title: sheet.name,
    id: sheet.id,
    artist: sheet.userName,
    artwork: sheet.img,
    description: sheet.intro,
    worksNum: sheet.musicNum,
    playCount: sheet.playNum,
  }));
  return {
    isEnd: +result.pageNo * SEARCH_PAGE_SIZE >= result.pgt,
    data,
  };
}

/**
 * 搜歌词（返回带 lrc 字段的歌曲列表）
 * @param {string} keyword 关键字
 * @param {number} page    页码
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function searchLyric(keyword, page) {
  const result = await searchBase(keyword, page, 7);
  const data = result.songs.map((song) => ({
    title: song.title,
    id: song.id,
    artist: song.artist,
    artwork: song.cover,
    lrc: song.lyrics,
    album: song.albumName,
    copyrightId: song.copyrightId,
  }));
  return {
    isEnd: +result.pageNo * SEARCH_PAGE_SIZE >= result.pgt,
    data,
  };
}

// ============== 歌手作品 ==============

/**
 * 获取歌手的专辑列表（走 PC 站 HTML 页面，cheerio 解析）
 * @param {{id: string, name: string}} artist 歌手对象
 * @param {number}                        page   页码
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function getArtistAlbumWorks(artist, page) {
  const response = await axios.get(
    "https://music.migu.cn/v3/music/artist/" + artist.id + "/album?page=" + page,
    {
      headers: {
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif," +
          "image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
        "accept-encoding": "gzip, deflate, br",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        connection: "keep-alive",
        host: "music.migu.cn",
        referer: "http://music.migu.cn",
        "user-agent": MIGU_PC_UA,
        "Cache-Control": "max-age=0",
      },
    }
  );
  const $ = cheerio.load(response.data);
  const $items = $("div.artist-album-list").find("li");

  const albums = [];
  for (let i = 0; i < $items.length; i++) {
    const $item = $($items[i]);
    const artwork = $item.find(".thumb-img").attr("data-original");
    albums.push({
      id: $item.find(".album-play").attr("data-id"),
      title: $item.find(".album-name").text(),
      // 注意：原代码此处未做 null 判断，artwork 为空时会抛错（保留原行为）
      artwork: artwork.startsWith("//") ? "https:" + artwork : artwork,
      date: "",
      artist: artist.name,
    });
  }
  return {
    isEnd: $(".pagination-next").hasClass("disabled"),
    data: albums,
  };
}

/**
 * 获取歌手作品（歌曲或专辑）
 * @param {{id: string, name: string}} artist   歌手对象
 * @param {number}                        page     页码（music 类型一次返回 20 条）
 * @param {string}                        category "music" 或 "album"
 * @returns {Promise<{isEnd?: boolean, data: Array}>}
 */
async function getArtistWorks(artist, page, category) {
  if (category === "music") {
    const headers = buildMiguApiHeaders(
      "https://m.music.migu.cn/migu/l/?s=149&p=163&c=5123&j=l&id=" + artist.id
    );
    const result =
      (await axios.get(
        "https://m.music.migu.cn/migu/remoting/cms_artist_song_list_tag",
        {
          headers,
          params: {
            artistId: artist.id,
            pageSize: 20,
            pageNo: page - 1,
          },
        }
      )).data || {};
    return {
      data: result.result.results.map((song) => ({
        id: song.songId,
        artwork: song.picL,
        title: song.songName,
        artist: (song.singerName || []).join(", "),
        album: song.albumName,
        url: musicCanPlayFilter(song),
        rawLrc: song.lyricLrc,
        copyrightId: song.copyrightId,
        singerId: song.singerId,
      })),
    };
  } else if (category === "album") {
    return getArtistAlbumWorks(artist, page);
  }
}

// ============== 歌词 ==============

/**
 * 获取 LRC 歌词
 * 通过 cms_detail_tag 接口拿到歌曲详情，里面包含 lyricLrc 字段
 * @param {{copyrightId: string}} song 歌曲对象（需要 copyrightId）
 * @returns {Promise<{rawLrc: string}>}
 */
async function getLyric(song) {
  const headers = buildMiguApiHeaders(
    "https://m.music.migu.cn/migu/l/?s=149&p=163&c=5200&j=l&id=" +
      song.copyrightId
  );
  const result = (await axios.get(
    "https://m.music.migu.cn/migu/remoting/cms_detail_tag",
    {
      headers,
      params: { cpid: song.copyrightId },
    }
  )).data;
  return { rawLrc: result.data.lyricLrc };
}

// ============== 歌单详情 ==============

/**
 * 获取歌单详情（分页）
 * 调 migumusic/h5/playlist/songsInfo，过滤掉 VIP 歌曲（vipFlag === 0 才是免费）
 * @param {{id: string}} sheet 歌单对象
 * @param {number}       page  页码（每页 30 条）
 * @returns {Promise<{isEnd: boolean, musicList: Array}>}
 */
async function getMusicSheetInfo(sheet, page) {
  const result = (await axios.get(
    "https://m.music.migu.cn/migumusic/h5/playlist/songsInfo",
    {
      // 注意：原代码这里参数名是 "palylistId"（拼写错误），保留原样
      params: {
        palylistId: sheet.id,
        pageNo: page,
        pageSize: 30,
      },
      headers: {
        Host: "m.music.migu.cn",
        referer: "https://m.music.migu.cn/v4/music/playlist/",
        By: BY_H5,
        "User-Agent": MIGU_IPHONE_UA,
      },
    }
  )).data.data;

  if (!result) {
    return { isEnd: true, musicList: [] };
  }

  const isEnd = result.total < 30;
  const musicList = result.items
    .filter((item) => item?.fullSong?.vipFlag === 0)
    .map((item) => ({
      id: item.id,
      artwork:
        item.mediumPic && item.mediumPic.startsWith("//")
          ? "http:" + item.mediumPic
          : item.mediumPic,
      title: item.name,
      artist: (item.singers?.map((s) => s.name)?.join(",")) ?? "",
      album: item.album?.albumName ?? "",
      copyrightId: item.copyrightId,
      singerId: item.singers?.[0]?.id,
    }));

  return { isEnd, musicList };
}

// ============== 导入歌单 ==============

/**
 * 从用户输入解析出咪咕歌单 ID
 * 支持的形式（按顺序尝试）：
 *   1. https://music.migu.cn/v3/my/playlist/<id>
 *   2. https://music.migu.cn/v3/music/playlist/<id>
 *   3. https://h5.nf.migu.cn/app/v4/p/share/playlist/index.html?...id=<id>
 *   4. 纯数字 <id>
 *   5. https://c.migu.cn/... 短链（跟随 302 重定向拿真实 URL 里的 id）
 * @param {string} input 用户输入
 * @returns {Promise<string|undefined>} 歌单 ID，解析失败返回 undefined
 */
async function resolvePlaylistId(input) {
  let playlistId;

  if (!playlistId) {
    playlistId = (input.match(
      /https?:\/\/music\.migu\.cn\/v3\/(?:my|music)\/playlist\/([0-9]+)/
    ) || [])[1];
  }
  if (!playlistId) {
    playlistId = (input.match(
      /https?:\/\/h5\.nf\.migu\.cn\/app\/v4\/p\/share\/playlist\/index\.html\?.*id=([0-9]+)/
    ) || [])[1];
  }
  if (!playlistId) {
    playlistId = input.match(/^\s*(\d+)\s*$/)?.[1];
  }
  if (!playlistId) {
    // c.migu.cn 短链：发起请求让它 302，从最终 URL 里取 id
    const shortUrl = input.match(/(https?:\/\/c\.migu\.cn\/[\S]+)\?/)?.[1];
    if (shortUrl) {
      const response = await axios.get(shortUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36 Edg/109.0.1518.61",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp," +
            "image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
          host: "c.migu.cn",
        },
        validateStatus(status) {
          return (status >= 200 && status < 300) || status === 403;
        },
      });
      const req = response.request;
      const finalPath = req?.path ?? req?.responseURL;
      if (finalPath) {
        playlistId = finalPath.match(/id=(\d+)/)?.[1];
      }
    }
  }

  return playlistId;
}

/**
 * 导入咪咕歌单
 * 流程：解析 ID → 查 contentCount → 分页抓 HTML 拿所有 copyrightId →
 *       调 audioPlayer/songs 接口拿歌曲详情 → 过滤 VIP
 * @param {string} input 用户输入
 * @returns {Promise<Array|undefined>} 歌曲列表，解析失败返回 undefined
 */
async function importMusicSheet(input) {
  const playlistId = await resolvePlaylistId(input);
  if (!playlistId) {
    return;
  }

  // 1. 拿歌单元信息（取 contentCount 用于分页）
  const playlistInfo = (await axios.get(
    "https://m.music.migu.cn/migu/remoting/query_playlist_by_id_tag" +
      "?onLine=1&queryChannel=0&createUserId=migu&contentCountMin=5&playListId=" +
      playlistId,
    {
      headers: {
        host: "m.music.migu.cn",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": MIGU_M_UA,
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://m.music.migu.cn",
      },
    }
  )).data;
  const contentCount = parseInt(playlistInfo.rsp.playList[0].contentCount);

  // 2. 分页抓 HTML 拿所有 copyrightId（每页 20 条）
  const copyrightIds = [];
  let pageNum = 1;
  while ((pageNum - 1) * 20 < contentCount) {
    const html = (await axios.get(
      "https://music.migu.cn/v3/music/playlist/" + playlistId + "?page=" + pageNum
    )).data;
    const $ = cheerio.load(html);
    $(".row.J_CopySong").each((_, el) => {
      copyrightIds.push($(el).attr("data-cid"));
    });
    pageNum += 1;
  }

  if (copyrightIds.length === 0) {
    return;
  }

  // 3. 一次性拿所有歌曲详情
  const detail = (await axios({
    url:
      "https://music.migu.cn/v3/api/music/audioPlayer/songs?type=1&copyrightId=" +
      copyrightIds.join(","),
    headers: { referer: "http://m.music.migu.cn/v3" },
    xsrfCookieName: "XSRF-TOKEN",
    withCredentials: true,
  })).data;

  // 4. 只保留非 VIP 歌曲
  return detail.items
    .filter((item) => item.vipFlag === 0)
    .map((item) => ({
      id: item.songId,
      artwork: item.cover,
      title: item.songName,
      artist: item.singers?.map((s) => s.artistName)?.join(", "),
      album: item.albums?.[0]?.albumName,
      copyrightId: item.copyrightId,
      singerId: item.singers?.[0]?.artistId,
    }));
}

// ============== 榜单 ==============

/**
 * 获取榜单列表（硬编码两组榜单：咪咕尖叫榜 + 咪咕特色榜）
 * @returns {Promise<Array<{title: string, data: Array}>>}
 */
async function getTopLists() {
  const screamGroup = {
    title: "咪咕尖叫榜",
    data: [
      {
        id: "jianjiao_newsong",
        title: "尖叫新歌榜",
        coverImg:
          "https://cdnmusic.migu.cn/tycms_picture/20/02/36/20020512065402_360x360_2997.png",
      },
      {
        id: "jianjiao_hotsong",
        title: "尖叫热歌榜",
        coverImg:
          "https://cdnmusic.migu.cn/tycms_picture/20/04/99/200408163640868_360x360_6587.png",
      },
      {
        id: "jianjiao_original",
        title: "尖叫原创榜",
        coverImg:
          "https://cdnmusic.migu.cn/tycms_picture/20/04/99/200408163702795_360x360_1614.png",
      },
    ],
  };
  const featureGroup = {
    title: "咪咕特色榜",
    data: [
      {
        id: "movies",
        title: "影视榜",
        coverImg:
          "https://cdnmusic.migu.cn/tycms_picture/20/05/136/200515161848938_360x360_673.png",
      },
      {
        id: "mainland",
        title: "内地榜",
        coverImg:
          "https://cdnmusic.migu.cn/tycms_picture/20/08/231/200818095104122_327x327_4971.png",
      },
      {
        id: "hktw",
        title: "港台榜",
        coverImg:
          "https://cdnmusic.migu.cn/tycms_picture/20/08/231/200818095125191_327x327_2382.png",
      },
      {
        id: "eur_usa",
        title: "欧美榜",
        coverImg:
          "https://cdnmusic.migu.cn/tycms_picture/20/08/231/200818095229556_327x327_1383.png",
      },
      {
        id: "jpn_kor",
        title: "日韩榜",
        coverImg:
          "https://cdnmusic.migu.cn/tycms_picture/20/08/231/200818095259569_327x327_4628.png",
      },
      {
        id: "coloring",
        title: "彩铃榜",
        coverImg:
          "https://cdnmusic.migu.cn/tycms_picture/20/08/231/200818095356693_327x327_7955.png",
      },
      {
        id: "ktv",
        title: "KTV榜",
        coverImg:
          "https://cdnmusic.migu.cn/tycms_picture/20/08/231/200818095414420_327x327_4992.png",
      },
      {
        id: "network",
        title: "网络榜",
        coverImg:
          "https://cdnmusic.migu.cn/tycms_picture/20/08/231/200818095442606_327x327_1298.png",
      },
    ],
  };
  return [screamGroup, featureGroup];
}

/**
 * 获取榜单详情：调 migumusic/h5/billboard/home 一次拿 100 首
 * @param {{id: string}} topList 榜单对象
 * @returns {Promise<object>} 榜单对象 + musicList 字段
 */
async function getTopListDetail(topList) {
  const response = await axios.get(
    "https://m.music.migu.cn/migumusic/h5/billboard/home",
    {
      params: {
        pathName: topList.id,
        pageNum: 1,
        pageSize: 100,
      },
      headers: {
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        Host: "m.music.migu.cn",
        referer: "https://m.music.migu.cn/v4/music/top/" + topList.id,
        "User-Agent": MIGU_M_UA,
        By: BY_BILLBOARD,
      },
    }
  );
  return Object.assign({}, topList, {
    musicList: response.data.data.songs.items.map((song) => ({
      id: song.id,
      artwork:
        song.mediumPic && song.mediumPic.startsWith("//")
          ? "https:" + song.mediumPic
          : song.mediumPic,
      title: song.name,
      artist: song.singers?.map((s) => s.name)?.join(", "),
      album: song.album?.albumName,
      copyrightId: song.copyrightId,
      singerId: song.singers?.[0]?.id,
    })),
  });
}

// ============== 歌单分类与推荐 ==============

/**
 * 获取歌单分类标签
 * 调 migumusic/h5/playlist/allTag 拿全部分类，pinned 是硬编码的 5 个热门标签
 * @returns {Promise<{pinned: Array, data: Array}>}
 */
async function getRecommendSheetTags() {
  const tags = (await axios.get(
    "https://m.music.migu.cn/migumusic/h5/playlist/allTag",
    {
      headers: {
        host: "m.music.migu.cn",
        referer: "https://m.music.migu.cn/v4/music/playlist",
        "User-Agent": MIGU_IPHONE_UA,
        By: BY_H5,
      },
    }
  )).data.data.tags;

  const groups = tags.map((group) => ({
    title: group.tagName,
    data: group.tags.map((tag) => ({
      id: tag.tagId,
      title: tag.tagName,
    })),
  }));

  return {
    pinned: [
      { title: "小清新", id: "1000587673" },
      { title: "电视剧", id: "1001076078" },
      { title: "民谣",   id: "1000001775" },
      { title: "旅行",   id: "1000001749" },
      { title: "思念",   id: "1000001703" },
    ],
    data: groups,
  };
}

/**
 * 按标签拉取推荐歌单
 * @param {{id: string}} tag  标签对象
 * @param {number}       page 页码（每页 20 条）
 * @returns {Promise<{isEnd: boolean, data: Array}>}
 */
async function getRecommendSheetsByTag(tag, page) {
  const pageSize = 20;
  const result = (await axios.get(
    "https://m.music.migu.cn/migumusic/h5/playlist/list",
    {
      params: {
        columnId: 15127272,
        tagId: tag.id,
        pageNum: page,
        pageSize,
      },
      headers: {
        "user-agent": MIGU_IPHONE_UA,
        host: "m.music.migu.cn",
        By: BY_H5,
        Referer: "https://m.music.migu.cn/v4/music/playlist",
      },
    }
  )).data.data;

  const isEnd = page * pageSize > result.total;
  const data = result.items.map((item) => ({
    id: item.playListId,
    artist: item.createUserName,
    title: item.playListName,
    artwork: item.image.startsWith("//") ? "http:" + item.image : item.image,
    playCount: item.playCount,
    createUserId: item.createUserId,
  }));

  return { isEnd, data };
}

// ============== 播放 URL ==============

/**
 * 备用播放 URL 获取（直连咪咕官方接口）
 * 注意：当前导出的 getMediaSource 走的是 haitangw 代理，此函数未被调用，
 * 保留以维持源码完整性。仅处理 standard 音质。
 * @param {{copyrightId: string, url?: string, artwork?: string}} song     歌曲对象
 * @param {string}                                                  quality  音质档位（仅 "standard" 有效）
 * @returns {Promise<{url?: string, artwork?: string}|undefined>}
 */
async function getMediaSourceByMTM(song, quality) {
  if (quality === "standard" && song.url) {
    // 已经有现成的播放 URL，直接返回
    return { url: song.url };
  } else if (quality === "standard") {
    // 通过 cms_detail_tag 拿 listenUrl
    const headers = buildMiguApiHeaders(
      "https://m.music.migu.cn/migu/l/?s=149&p=163&c=5200&j=l&id=" +
        song.copyrightId
    );
    const detail = (await axios.get(
      "https://m.music.migu.cn/migu/remoting/cms_detail_tag",
      {
        headers,
        params: { cpid: song.copyrightId },
      }
    )).data.data;
    return {
      artwork: song.artwork || detail.picL,
      url: detail.listenUrl || detail.listenQq || detail.lisCr,
    };
  }
}

/**
 * 获取播放 URL
 * 走第三方代理 music.haitangw.cc/musicapi1/mg.php（绕过咪咕版权限制）
 * @param {{id: string}} song    歌曲对象
 * @param {string}       quality 音质档位
 * @returns {Promise<{url: string}>}
 */
async function getMediaSource(song, quality) {
  const result = (await axios.get(
    "https://music.haitangw.cc/musicapi1/mg.php?id=" +
      song.id +
      "&quality=" +
      QUALITY_LEVELS[quality]
  )).data;
  return { url: result.data.music_url };
}

// ============== 专辑详情 ==============

/**
 * 获取专辑详情（专辑下所有歌曲）
 * 调两个接口：cms_album_song_list_tag 拿歌曲列表，cms_album_detail_tag 拿专辑简介
 * @param {{id: string, title: string}} album 专辑对象
 * @returns {Promise<{albumItem: {description: string}, musicList: Array}>}
 */
async function getAlbumInfo(album) {
  const headers = buildMiguApiHeaders(
    // 注意：原代码这里 Referer 拼成 "record=record"，保留原样
    "https://m.music.migu.cn/migu/l/?record=record&id=" + album.id
  );

  // 1. 拿专辑下的歌曲列表
  const songListResult = (await axios.get(
    "https://m.music.migu.cn/migu/remoting/cms_album_song_list_tag",
    {
      headers,
      params: {
        albumId: album.id,
        pageSize: 30,
      },
    }
  )).data || {};

  // 2. 拿专辑简介
  const albumDetailResult = (await axios.get(
    "https://m.music.migu.cn/migu/remoting/cms_album_detail_tag",
    {
      headers,
      params: { albumId: album.id },
    }
  )).data || {};

  return {
    albumItem: { description: albumDetailResult.albumIntro },
    musicList: songListResult.result.results.map((song) => ({
      id: song.songId,
      artwork: song.picL,
      title: song.songName,
      artist: (song.singerName || []).join(", "),
      album: album.title,
      url: musicCanPlayFilter(song),
      rawLrc: song.lyricLrc,
      copyrightId: song.copyrightId,
      singerId: song.singerId,
    })),
  };
}

// ============== 模块导出 ==============

module.exports = {
  platform: "元力MG",
  author: "微信公众号:元力菌",
  version: "1.2.0",
  hints: {
    importMusicSheet: [
      "咪咕APP：自建歌单-分享-复制链接，直接粘贴即可",
      "H5/PC端：复制URL并粘贴，或者直接输入纯数字歌单ID即可",
      "导入时间和歌单大小有关，请耐心等待",
    ],
  },
  primaryKey: ["id", "copyrightId"],
  cacheControl: "cache",
  srcUrl: "http://music.haitangw.net/cqapi/xiaomi.js",
  supportedSearchType: ["music", "album", "sheet", "artist", "lyric"],

  getMediaSource,

  /**
   * 搜索入口（按 type 分发到具体搜索函数）
   * @param {string} keyword 关键字
   * @param {number} page    页码
   * @param {string} type    "music" | "album" | "artist" | "sheet" | "lyric"
   * @returns {Promise<{isEnd: boolean, data: Array}|undefined>}
   */
  async search(keyword, page, type) {
    if (type === "music") return await searchMusic(keyword, page);
    if (type === "album") return await searchAlbum(keyword, page);
    if (type === "artist") return await searchArtist(keyword, page);
    if (type === "sheet") return await searchMusicSheet(keyword, page);
    if (type === "lyric") return await searchLyric(keyword, page);
  },

  getAlbumInfo,
  getArtistWorks,
  getLyric,
  importMusicSheet,
  getTopLists,
  getTopListDetail,
  getRecommendSheetTags,
  getRecommendSheetsByTag,
  getMusicSheetInfo,
};
