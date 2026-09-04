/**
 * qc.js — Z·QQ歌词 插件
 * ------------------------------------------------------------------
 * 适用宿主：MusicFree / 同类插件系统
 * 平台标识：Z·QQ歌词
 * 原作者：wenshao（原始混淆版）
 * 反编译 + 变量重命名 + 注释 by Super Z
 * ------------------------------------------------------------------
 * 本插件只做一件事：在搜索页选择「歌词」分类时，返回 QQ 音乐
 * 歌曲列表（仅含 songmid / 歌名 / 歌手 / 专辑），并允许通过
 * songmid 拉取对应的 LRC 原文歌词。它不提供播放能力，因此
 * 通常与其他 QQ 音乐播放插件配合使用。
 */

const axios = require("axios");

// 后端代理基础地址
const BASE_URL = "http://ws.suol.cc/qq/qq_php.php";
const API = BASE_URL;

/**
 * 去除 HTML 标签并首尾去空格
 * QQ 音乐接口返回的 songname / singer.name 等字段可能带 <em> 高亮标签
 * @param {string} raw 原始字符串
 * @returns {string} 干净的纯文本
 */
function stripHtml(raw) {
  return String(raw || "").replace(/<[^>]+>/g, "").trim();
}

module.exports = {
  platform: "Z·QQ歌词",
  version: "1.0.1",
  author: "Super Z",
  description: "QQ 音乐官方歌词源（独立歌词插件），在搜索页选「歌词」分类使用",
  updateURL: "http://ws.suol.cc/qq/qqlyric.js",
  cacheControl: "no-cache",

  /**
   * 搜索歌曲（仅当用户在「歌词」分类下搜索时才返回数据）
   * @param {string} keyword   搜索关键字
   * @param {number} pageNo    页码，从 1 开始
   * @param {string} searchType 搜索类型，本插件只认 "lyric"
   * @returns {{isEnd: boolean, data: Array}}
   */
  async search(keyword, pageNo, searchType) {
    // 非歌词分类直接返回空，让宿主转交给其他插件
    if (searchType !== "lyric") {
      return { isEnd: true, data: [] };
    }

    const response = await axios.get(API, {
      params: {
        path: "search",
        key: keyword,
        pageNo: pageNo || 1,
        pageSize: 20,
        t: 0, // t=0 表示歌曲类型
      },
      timeout: 8000,
    });
    const body = response.data;

    // 后端约定 result === 100 表示成功
    if (!body || body.result !== 100 || !Array.isArray(body.data.list)) {
      return { isEnd: true, data: [] };
    }

    // 字段归一化：把后端字段映射成 MusicFree 通用结构
    const songs = body.data.list.map((item) => ({
      id: String(item.songmid),
      platform: "QQ歌词",
      title: stripHtml(item.songname) || "未知歌曲",
      artist:
        (item.singer && item.singer[0] && stripHtml(item.singer[0].name)) ||
        "未知歌手",
      album: stripHtml(item.albumname) || "",
    }));

    return { isEnd: true, data: songs };
  },

  /**
   * 根据歌曲 ID 拉取 LRC 歌词
   * @param {{id?: string, songmid?: string}} song 歌曲对象
   * @returns {{rawLrc: string} | null}
   */
  async getLyric(song) {
    const songmid = song.id || song.songmid;
    if (!songmid) {
      return null;
    }

    const response = await axios.get(API, {
      params: { path: "lyric", songmid },
      timeout: 8000,
    });
    const body = response.data;

    if (!body || body.result !== 100 || !body.data || !body.data.lyric) {
      return null;
    }
    return { rawLrc: body.data.lyric };
  },
};
