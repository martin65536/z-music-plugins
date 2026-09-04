# Z 系列音乐插件合集

7 个 MusicFree 插件，覆盖喜马拉雅 / 酷狗概念版 / 酷我音乐 / QQ 音乐歌词 / QQ 音乐 / 哔哩哔哩 / 网易云音乐。

## 包含插件

| 文件 | 平台标识 | 功能 | 版本 |
| --- | --- | --- | --- |
| `plugins/FM.js`  | Z·喜马拉雅 | 喜马拉雅有声书 | 0.1.1 |
| `plugins/kg.js`  | Z·酷狗    | 酷狗概念版（含云盘/歌单导入） | 0.3.1 |
| `plugins/kw.js`  | Z·酷我    | 酷我音乐 | 0.1.1 |
| `plugins/qc.js`  | Z·QQ歌词   | QQ 音乐独立歌词源 | 1.0.1 |
| `plugins/qq.js`  | Z·QQ音乐  | QQ 音乐全功能 | 0.4.1 |
| `plugins/bl.js`  | Z·哔哩哔哩 | B 站（搜索/分P/UP主/排行榜/收藏夹/歌词/评论） | 0.1.0 |
| `plugins/wy.js`  | Z·网易云  | 网易云音乐 | 0.0.2 |

## 一键导入 MusicFree

把下面的链接作为订阅地址添加到 MusicFree 的「订阅管理」中：

```
https://raw.githubusercontent.com/martin65536/z-music-plugins/main/manifest.json
```

导入后会自动出现 7 个插件，可单独启用/禁用。

## 代码质量

- 7 个文件全部通过 `node --check` 语法校验
- 与原混淆版的导出 key 集合完全一致
- 关键算法（songId↔songmid 转换、DASH 音轨选档、收藏夹分页）逐步骤注释
- 每个文件顶部都有 `BASE_URL` 常量，方便统一切换后端

## API 可用性测试（2026-09-04）

| 平台 | 搜索 | 播放 | 歌词 | 备注 |
| --- | --- | --- | --- | --- |
| 酷狗 (kg)  | ✅ | ✅ | ✅ | 完全可用 |
| 酷我 (kw)  | ✅ | ✅ | ✅ | 完全可用 |
| QQ (qq)   | ✅ | ✅ | ✅ | 完全可用 |
| 网易云 (wy) | ✅ | ✅ | ✅ | 完全可用 |
| B 站 (bl) | ✅ | ✅ | ✅ | 完全可用（服务器转码 mp3） |
| 喜马拉雅 (FM) | ⚠️ | ❌ | N/A | 后端服务降级 |

## 目录结构

```
├── README.md
├── manifest.json            # MusicFree 订阅清单
└── plugins/
    ├── FM.js                # Z·喜马拉雅
    ├── kg.js                # Z·酷狗
    ├── kw.js                # Z·酷我
    ├── qc.js                # Z·QQ歌词
    ├── qq.js                # Z·QQ音乐
    ├── bl.js                # Z·哔哩哔哩
    └── wy.js                # Z·网易云
```

## 致谢

- 原作者：wenshao
- 反编译 + 重写：Super Z
