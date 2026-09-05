/**
 * kg.js — 元力KG 酷狗音乐插件
 * ------------------------------------------------------------------
 * 适用宿主：MusicFree / 同类插件系统
 * 平台标识：元力KG
 * 原作者：微信公众号「元力菌」（原始混淆版）
 * 反编译 + 变量重命名 + 注释 by Super Z
 * ------------------------------------------------------------------
 * 架构特点：
 *   - 元数据接口（搜索 / 专辑 / 歌单 / 榜单 / 歌词）直连酷狗官方
 *     移动端 / PC 端 API：
 *       songsearch.kugou.com  → 关键字搜歌
 *       msearch.kugou.com     → 搜专辑
 *       mobilecdn.kugou.com   → 搜歌单、专辑详情
 *       mobilecdnbj.kugou.com → 榜单列表、榜单歌曲
 *       lyrics.kugou.com      → 歌词搜索 / 下载
 *       t.kugou.com           → 酷狗码解析（导入歌单第一步）
 *       www2.kugou.kugou.com  → 歌单详情（导入歌单第二步）
 *       gateway.kugou.com     → 资源权限/批量补全 hash（导入歌单第三步）
 *   - 不走代理，直连酷狗官方接口
 *   - 播放 URL 走第三方代理 music.haitangw.cc/kgqq1/kg.php（绕过酷狗版权限制）
 *   - 歌单导入只支持酷狗码（纯数字），通过 t.kugou.com/command/ 解析成歌单
 * ------------------------------------------------------------------
 * 歌词流程：
 *   1. lyrics.kugou.com/search 用 title+hash+duration 查候选词
 *   2. 取 candidates[0]，拿 id + accesskey
 *   3. lyrics.kugou.com/download 用 id+accesskey 拉 LRC（base64 编码）
 *   4. base64 解码 + he.decode 反转 HTML 实体后返回
 * ------------------------------------------------------------------
 * 导入歌单流程（酷狗码 → 歌单）：
 *   1. POST t.kugou.com/command/  传酷狗码，拿到 specialid / userid /
 *      collect_type / count
 *   2. POST www2.kugou.kugou.com/apps/kucodeAndShare/app/  用上一步字段
 *      拉歌曲 hash 列表
 *   3. POST gateway.kugou.com/v2/get_res_privilege/lite  批量补全 320hash
 *      / sqhash / origin_hash 等多档音质信息
 * ------------------------------------------------------------------
 * 依赖：axios / cheerio / crypto-js / he
 */

'use strict';

Object.defineProperty(exports, "__esModule", { value: true });

const axios = require("axios");
const cheerio = require("cheerio");
const CryptoJs = require("crypto-js");
const he = require("he");

// 每页歌曲数（搜索歌曲 / 搜索歌单通用）
const PAGE_SIZE = 20;

// ============== 通用请求头 ==============

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate",
  "Accept-Language": "zh-CN,zh;q=0.9",
};

// ============== 数据格式化 ==============

/**
 * 把酷狗「关键字搜歌」返回的歌曲对象归一化成 MusicFree 通用结构
 * 酷狗搜索接口返回的 Grp 字段是同名的多版本数组，这里取第 0 个做兜底
 * @param {object} raw 酷狗 songsearch 返回的原始歌曲对象
 * @returns {object} MusicFree 通用歌曲结构
 */
function formatMusicItem(raw) {
  const fallback = raw.Grp?.[0];
  return {
    id: raw.FileHash ?? fallback.FileHash,
    title: raw.SongName ?? raw.OriSongName,
    artist: raw.SingerName ?? fallback.SingerName,
    album: raw.AlbumName ?? fallback.AlbumName,
    album_id: raw.AlbumID ?? fallback.AlbumID,
    album_audio_id: 0,
    duration: raw.Duration,
    // 封面 URL 里 {size} 是占位符，替换成 1080 拿大图
    artwork: (raw.Image ?? fallback.Image).replace("{size}", "1080"),
    "320hash": raw.HQFileHash ?? undefined,
    sqhash: raw.SQFileHash ?? undefined,
    ResFileHash: raw.ResFileHash ?? undefined,
  };
}

/**
 * 把酷狗「榜单歌曲」返回的对象归一化
 * 跟 formatMusicItem 的区别：榜单接口字段名小写、artists 是数组
 * artist 取值顺序：singername → authors[].author_name 拼接 → filename 拆分
 * @param {object} raw 酷狗榜单接口返回的原始歌曲对象
 * @returns {object} MusicFree 通用歌曲结构
 */
function formatMusicItem2(raw) {
  const authorsStr = raw.authors
    ?.map((a) => a?.author_name ?? "")
    .join(", ");
  const filenameArtist = raw.filename?.split("-")?.[0]?.trim();

  return {
    id: raw.hash,
    title: raw.songname,
    artist: raw.singername ?? authorsStr ?? filenameArtist,
    album: raw.album_name ?? raw.remark,
    album_id: raw.album_id,
    album_audio_id: raw.album_audio_id,
    artwork: raw.album_sizable_cover
      ? raw.album_sizable_cover.replace("{size}", "400")
      : undefined,
    duration: raw.duration,
    "320hash": raw["320hash"],
    sqhash: raw.sqhash,
    origin_hash: raw.origin_hash,
  };
}

/**
 * 把「导入歌单」第三步 get_res_privilege 返回的歌曲对象归一化
 * 这一步的 name 字段格式通常是 "歌手名 - 歌曲名"，需要把歌手名前缀剥掉
 * relate_goods 数组的索引含义：[0]=普通 [1]=320k [2]=sq [3]=origin
 * @param {object} raw get_res_privilege 返回的原始歌曲对象
 * @returns {object} MusicFree 通用歌曲结构
 */
function formatImportMusicItem(raw) {
  let title = raw.name;
  const singer = raw.singername;

  // 把 "歌手名 - 歌曲名" 里的歌手名前缀剥掉，只留歌曲名
  if (singer && title) {
    const idx = title.indexOf(singer);
    if (idx !== -1) {
      title = title.substring(idx + singer.length + 2)?.trim();
    }
    // 兜底：剥完空了就把歌手名当标题
    if (!title) {
      title = singer;
    }
  }

  const goods = raw.relate_goods;
  return {
    id: raw.hash,
    title,
    artist: singer,
    album: raw.albumname ?? "",
    album_id: raw.album_id,
    album_audio_id: raw.album_audio_id,
    artwork: raw?.info?.image?.replace("{size}", "400"),
    "320hash": goods?.[1]?.hash,
    sqhash: goods?.[2]?.hash,
    origin_hash: goods?.[3]?.hash,
  };
}

// ============== 搜索 ==============

/**
 * 搜歌曲：直连 songsearch.kugou.com/song_search_v2
 * @param {string} keyword 关键字
 * @param {number} page    页码（从 1 开始）
 * @returns {Promise<{isEnd: boolean, data: object[]}>}
 */
async function searchMusic(keyword, page) {
  const response = await axios.get(
    "https://songsearch.kugou.com/song_search_v2",
    {
      headers: COMMON_HEADERS,
      params: {
        keyword,
        page,
        pagesize: PAGE_SIZE,
        userid: 0,
        clientver: "",
        platform: "WebFilter",
        filter: 2,
        iscorrection: 1,
        privilege_filter: 0,
        area_code: 1,
      },
    }
  );
  const result = response.data;
  const data = result.data.lists.map(formatMusicItem);
  return {
    isEnd: page * PAGE_SIZE >= result.data.total,
    data,
  };
}

/**
 * 搜专辑：直连 msearch.kugou.com/api/v3/search/album
 * 专辑名是 HTML 转义过的，用 cheerio 解析回纯文本
 * @param {string} keyword 关键字
 * @param {number} page    页码（从 1 开始）
 * @returns {Promise<{isEnd: boolean, data: object[]}>}
 */
async function searchAlbum(keyword, page) {
  const params = {
    version: 9108,
    iscorrection: 1,
    highlight: "em",
    plat: 0,
    keyword,
    pagesize: 20,
    page,
    sver: 2,
    with_res_tag: 0,
  };
  const response = await axios.get(
    "http://msearch.kugou.com/api/v3/search/album",
    { headers: COMMON_HEADERS, params }
  );
  const result = response.data;
  const data = result.data.info.map((album) => ({
    id: album.albumid,
    artwork: album.imgurl?.replace("{size}", "400"),
    artist: album.singername,
    // albumname 里可能含 <em> 高亮标签，用 cheerio 取纯文本
    title: cheerio.load(album.albumname).text(),
    description: album.intro,
    // publishtime 形如 "2020-01-01..."，截前 10 位即 YYYY-MM-DD
    date: album.publishtime?.slice(0, 10),
  }));
  return {
    isEnd: page * 20 >= result.data.total,
    data,
  };
}

/**
 * 搜歌单：直连 mobilecdn.kugou.com/api/v3/search/special
 * @param {string} keyword 关键字
 * @param {number} page    页码（从 1 开始）
 * @returns {Promise<{isEnd: boolean, data: object[]}>}
 */
async function searchMusicSheet(keyword, page) {
  const response = await axios.get(
    "http://mobilecdn.kugou.com/api/v3/search/special",
    {
      headers: COMMON_HEADERS,
      params: {
        format: "json",
        keyword,
        page,
        pagesize: PAGE_SIZE,
        showtype: 1,
      },
    }
  );
  const result = response.data;
  const data = result.data.info.map((sheet) => ({
    title: sheet.specialname,
    createAt: sheet.publishtime,
    description: sheet.intro,
    artist: sheet.nickname,
    coverImg: sheet.imgurl,
    gid: sheet.gid,
    playCount: sheet.playcount,
    id: sheet.specialid,
    worksNum: sheet.songcount,
  }));
  return {
    isEnd: page * PAGE_SIZE >= result.data.total,
    data,
  };
}

// ============== 播放 URL ==============

/**
 * 音质档位映射：把 MusicFree 的 low/standard/high/super 转成酷狗代理的 level 参数
 */
const QUALITY_LEVELS = {
  low: "standard",
  standard: "exhigh",
  high: "lossless",
  super: "hires",
};

/**
 * 获取播放 URL
 * 走第三方代理 music.haitangw.cc/kgqq1/kg.php（绕过酷狗版权限制）
 * @param {{id: string}} song    歌曲对象（id 是 FileHash）
 * @param {string}       quality 音质档位：low / standard / high / super
 * @returns {Promise<{url: string}>}
 */
async function getMediaSource(song, quality) {
  const response = await axios.get(
    "https://music.haitangw.cc/kgqq1/kg.php?id=" +
      song.id +
      "&type=json&level=" +
      QUALITY_LEVELS[quality]
  );
  return { url: response.data.data.url };
}

// ============== 榜单 ==============

/**
 * 获取榜单列表：直连 mobilecdnbj.kugou.com/api/v3/rank/list
 * 酷狗把榜单按 classify 字段分组：
 *   1, 2 → 热门榜单
 *   3, 5 → 特色音乐榜
 *   4    → 全球榜
 *   其他 → 其他
 * @returns {Promise<Array<{title: string, data: object[]}>>}
 */
async function getTopLists() {
  const response = await axios.get(
    "http://mobilecdnbj.kugou.com/api/v3/rank/list" +
      "?version=9108&plat=0&showtype=2&parentid=0&apiver=6" +
      "&area_code=1&withsong=0&with_res_tag=0",
    { headers: COMMON_HEADERS }
  );
  const ranks = response.data.data.info;

  const groups = [
    { title: "热门榜单", data: [] },
    { title: "特色音乐榜", data: [] },
    { title: "全球榜", data: [] },
  ];
  const others = { title: "其他", data: [] };

  ranks.forEach((rank) => {
    const item = {
      id: rank.rankid,
      description: rank.intro,
      coverImg: rank.imgurl?.replace("{size}", "400"),
      title: rank.rankname,
    };
    if (rank.classify === 1 || rank.classify === 2) {
      groups[0].data.push(item);
    } else if (rank.classify === 3 || rank.classify === 5) {
      groups[1].data.push(item);
    } else if (rank.classify === 4) {
      groups[2].data.push(item);
    } else {
      others.data.push(item);
    }
  });

  if (others.data.length !== 0) {
    groups.push(others);
  }
  return groups;
}

/**
 * 获取榜单详情（榜单下所有歌曲）
 * 直连 mobilecdnbj.kugou.com/api/v3/rank/song，一次拉 100 条
 * @param {{id: string}} topList 榜单对象
 * @returns {Promise<object>} 合并了原始榜单字段 + musicList 的对象
 */
async function getTopListDetail(topList) {
  const response = await axios.get(
    "http://mobilecdnbj.kugou.com/api/v3/rank/song" +
      "?version=9108&ranktype=0&plat=0&pagesize=100&area_code=1" +
      "&page=1&volid=35050&rankid=" +
      topList.id +
      "&with_res_tag=0",
    { headers: COMMON_HEADERS }
  );
  return Object.assign({}, topList, {
    musicList: response.data.data.info.map(formatMusicItem2),
  });
}

// ============== 歌词 ==============

// 酷狗 PC 客户端的歌词接口专用请求头（伪装成 KuGou2012 客户端）
const LYRIC_HEADERS = {
  "KG-RC": 1,
  "KG-THash": "expand_search_manager.cpp:852736169:451",
  "User-Agent": "KuGou2012-9020-ExpandSearchManager",
};

/**
 * 用候选词的 id + accesskey 下载 LRC 歌词
 * 直连 lyrics.kugou.com/download，返回的 content 是 base64 编码的 UTF-8 文本
 * 解码后再用 he.decode 反转 HTML 实体（&amp; 等）
 * @param {{id: string, accessKey: string}} lyricInfo 候选词对象
 * @returns {Promise<{rawLrc: string}>}
 */
async function getLyricDownload(lyricInfo) {
  const response = await axios({
    url:
      "http://lyrics.kugou.com/download?ver=1&client=pc&id=" +
      lyricInfo.id +
      "&accesskey=" +
      lyricInfo.accessKey +
      "&fmt=lrc&charset=utf8",
    headers: LYRIC_HEADERS,
    method: "get",
    xsrfCookieName: "XSRF-TOKEN",
    withCredentials: true,
  });
  const result = response.data;
  const lrcText = CryptoJs.enc.Base64.parse(result.content).toString(
    CryptoJs.enc.Utf8
  );
  return { rawLrc: he.decode(lrcText) };
}

/**
 * 获取 LRC 歌词
 * 两步走：
 *   1. lyrics.kugou.com/search 用 title + hash + duration 查候选词
 *   2. 取 candidates[0] 调 getLyricDownload 拉真实歌词
 * @param {{id: string, title: string, duration: number}} song 歌曲对象
 * @returns {Promise<{rawLrc: string}>}
 */
async function getLyric(song) {
  const response = await axios({
    url:
      "http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=" +
      song.title +
      "&hash=" +
      song.id +
      "&timelength=" +
      song.duration,
    headers: LYRIC_HEADERS,
    method: "get",
    xsrfCookieName: "XSRF-TOKEN",
    withCredentials: true,
  });
  const result = response.data;
  const best = result.candidates[0];
  return await getLyricDownload({
    id: best.id,
    accessKey: best.accesskey,
  });
}

// ============== 专辑详情 ==============

/**
 * 获取专辑详情（专辑下所有歌曲，分页）
 * 直连 mobilecdn.kugou.com/api/v3/album/song
 * 酷狗的 filename 字段格式是 "歌手名 - 歌曲名"，需要 split("-") 拆开
 * @param {{id: string, artwork?: string}} album  专辑对象
 * @param {number} [page=1] 页码（每页 100 条）
 * @returns {Promise<{isEnd: boolean, albumItem: {worksNum: number}, musicList: object[]}>}
 */
async function getAlbumInfo(album, page = 1) {
  const response = await axios.get(
    "http://mobilecdn.kugou.com/api/v3/album/song",
    {
      params: {
        version: 9108,
        albumid: album.id,
        plat: 0,
        pagesize: 100,
        area_code: 1,
        page,
        with_res_tag: 0,
      },
    }
  );
  const result = response.data;
  return {
    isEnd: page * 100 >= result.data.total,
    albumItem: { worksNum: result.data.total },
    musicList: result.data.info.map((song) => {
      const [artist, title] = song.filename.split("-");
      return {
        id: song.hash,
        title: title.trim(),
        artist: artist.trim(),
        album: song.album_name ?? song.remark,
        album_id: song.album_id,
        album_audio_id: song.album_audio_id,
        // 单曲详情接口不返回封面，复用专辑封面
        artwork: album.artwork,
        "320hash": song.HQFileHash,
        sqhash: song.SQFileHash,
        origin_hash: song.id,
      };
    }),
  };
}

// ============== 导入歌单（酷狗码）==============

/**
 * 通过酷狗码导入歌单
 * 整个流程三步：
 *   1. POST t.kugou.com/command/  传酷狗码 → 拿到 specialid / userid /
 *      collect_type / count
 *   2. POST www2.kugou.kugou.com/apps/kucodeAndShare/app/  用上一步字段拉
 *      歌曲的 hash 列表（每首只有 hash + filename，没有音质档位）
 *   3. POST gateway.kugou.com/v2/get_res_privilege/lite  批量补全 320hash /
 *      sqhash / origin_hash 等多档音质信息
 * @param {string} input 用户输入（含酷狗码的字符串或纯数字）
 * @returns {Promise<object[]|undefined>} MusicFree 通用歌曲结构数组；解析失败返回 undefined
 */
async function importMusicSheet(input) {
  // 从输入里抠出第一段连续数字作为酷狗码
  const kgCode = input.match(/^(?:.*?)(\d+)(?:.*?)$/)?.[1];
  let musicList = [];
  if (!kgCode) {
    return;
  }

  // ---- 第一步：解析酷狗码 → 拿到歌单元信息 ----
  const cmdReqBody = {
    appid: 1001,
    clientver: 9020,
    mid: "21511157a05844bd085308bc76ef3343",
    clienttime: 640612895,
    key: "36164c4015e704673c588ee202b9ecb8",
    data: kgCode,
  };
  const cmdResp = await axios.post("http://t.kugou.com/command/", cmdReqBody);

  if (cmdResp.status === 200 && cmdResp.data.status === 1) {
    const cmdData = cmdResp.data.data;

    // ---- 第二步：拉歌曲 hash 列表 ----
    const shareReqBody = {
      id: cmdData.info.id,
      type: 3,
      userid: cmdData.info.userid,
      collect_type: cmdData.info.collect_type,
      page: 1,
      pagesize: cmdData.info.count,
    };
    const shareReqPayload = {
      appid: 1001,
      clientver: 10112,
      mid: "70a02aad1ce4648e7dca77f2afa7b182",
      clienttime: 722219501,
      key: "381d7062030e8a5a94cfbe50bfe65433",
      data: shareReqBody,
    };
    const shareResp = await axios.post(
      "http://www2.kugou.kugou.com/apps/kucodeAndShare/app/",
      shareReqPayload
    );

    if (shareResp.status === 200 && shareResp.data.status === 1) {
      // 把 hash 列表组装成 get_res_privilege 需要的 resource 格式
      const resources = [];
      shareResp.data.data.forEach((item) => {
        resources.push({
          album_audio_id: 0,
          album_id: "0",
          hash: item.hash,
          id: 0,
          name: item.filename.replace(".mp3", ""),
          page_id: 0,
          type: "audio",
        });
      });

      // ---- 第三步：批量补全多档音质 hash ----
      const privilegeReqBody = {
        appid: 1001,
        area_code: "1",
        behavior: "play",
        clientver: "10112",
        dfid: "2O3jKa20Gdks0LWojP3ly7ck",
        mid: "70a02aad1ce4648e7dca77f2afa7b182",
        need_hash_offset: 1,
        relate: 1,
        resource: resources,
        token: "",
        userid: "0",
        vip: 0,
      };
      const privilegeResp = await axios.post(
        "https://gateway.kugou.com/v2/get_res_privilege/lite" +
          "?appid=1001&clienttime=1668883879&clientver=10112" +
          "&dfid=2O3jKa20Gdks0LWojP3ly7ck" +
          "&mid=70a02aad1ce4648e7dca77f2afa7b182" +
          "&userid=390523108&uuid=92691C6246F86F28B149BAA1FD370DF1",
        privilegeReqBody,
        { headers: { "x-router": "media.store.kugou.com" } }
      );

      // 注意：原代码这里判断的是 shareResp 而不是 privilegeResp，是有意的兼容写法
      if (shareResp.status === 200 && shareResp.data.status === 1) {
        musicList = privilegeResp.data.data.map(formatImportMusicItem);
      }
    }
  }
  return musicList;
}

// ============== 模块导出 ==============

module.exports = {
  platform: "元力KG",
  version: "1.2.0",
  author: "微信公众号:元力菌",
  srcUrl: "https://13413.kstore.vip/yuanli/kg.js",
  cacheControl: "no-cache",
  description: "",
  primaryKey: ["id", "album_id", "album_audio_id"],
  hints: {
    importMusicSheet: [
      "仅支持酷狗APP通过酷狗码导入，输入纯数字酷狗码即可。",
      "导入时间和歌单大小有关，请耐心等待",
    ],
  },
  supportedSearchType: ["music", "album", "sheet"],

  /**
   * 搜索入口（按 type 分流）
   * @param {string} keyword 关键字
   * @param {number} page    页码
   * @param {("music"|"album"|"sheet")} type 搜索类型
   */
  async search(keyword, page, type) {
    if (type === "music") {
      return await searchMusic(keyword, page);
    } else if (type === "album") {
      return await searchAlbum(keyword, page);
    } else if (type === "sheet") {
      return await searchMusicSheet(keyword, page);
    }
  },

  getMediaSource,
  getTopLists,
  getLyric,
  getTopListDetail,
  getAlbumInfo,
  importMusicSheet,
};
