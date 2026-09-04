# Z 系列音乐插件合集

两个系列共 13 个 MusicFree 插件，覆盖喜马拉雅 / 酷狗 / 酷我 / QQ音乐 / 网易云 / 哔哩哔哩 / 咪咕等主流平台。

## 系列 1：Z 系列（基于 wenshao/xmly 反编译）

7 个插件，平台名以 `Z·` 前缀标识，作者署名 Super Z。

| 文件 | 平台标识 | 功能 | 版本 |
| --- | --- | --- | --- |
| `plugins/FM.js`  | Z·喜马拉雅 | 喜马拉雅有声书 | 0.1.1 |
| `plugins/kg.js`  | Z·酷狗    | 酷狗概念版（含云盘/歌单导入） | 0.3.1 |
| `plugins/kw.js`  | Z·酷我    | 酷我音乐 | 0.1.1 |
| `plugins/qc.js`  | Z·QQ歌词   | QQ 音乐独立歌词源 | 1.0.1 |
| `plugins/qq.js`  | Z·QQ音乐  | QQ 音乐全功能 | 0.4.1 |
| `plugins/bl.js`  | Z·哔哩哔哩 | B 站（搜索/分P/UP主/排行榜/收藏夹/歌词/评论） | 0.1.0 |
| `plugins/wy.js`  | Z·网易云  | 网易云音乐 | 0.0.2 |

**订阅地址**：
```
https://raw.githubusercontent.com/martin65536/z-music-plugins/main/manifest.json
```

## 系列 2：元力菌 SVIP 音源（反编译版）

6 个插件，原作者「微信公众号:元力菌」，反编译 by Super Z。原版来自 `13413.kstore.vip/yuanli/yuanli.json`，使用 javascript-obfuscator 高度混淆，本仓库通过 webcrack 还原后做了变量重命名和注释。

| 文件 | 平台标识 | 功能 | 版本 |
| --- | --- | --- | --- |
| `yuanli/wy.js`       | 元力WY | 网易云（直连 weapi，AES+RSA 加密） | 1.2.0 |
| `yuanli/kg.js`       | 元力KG | 酷狗（直连官方移动端 API） | 1.2.0 |
| `yuanli/kw.js`       | 元力KW | 酷我（直连官方接口） | 1.2.0 |
| `yuanli/qq.js`       | 元力QQ | QQ 音乐（直连官方 CGI + 播放代理） | 1.2.0 |
| `yuanli/xiaomi.js`   | 元力MG | 咪咕音乐（直连官方接口） | 1.2.0 |
| `yuanli/bilibili.js` | bilibili | B 站（原作者猫头猫，未混淆） | 0.3.0 |

**订阅地址**：
```
https://raw.githubusercontent.com/martin65536/z-music-plugins/main/yuanli/manifest.json
```

## 代码质量

- 13 个文件全部通过 `node --check` 语法校验
- 与原混淆版的导出 key 集合完全一致（自动验证）
- 所有 `_0xXXXX` 变量已重命名为语义化名称
- 关键算法（weapi AES+RSA 双重加密、songId↔songmid 转换、DASH 音轨选档、收藏夹分页）逐步骤注释
- 每个函数都有 JSDoc 注释

## API 可用性测试（2026-09-04）

### Z 系列

| 平台 | 搜索 | 播放 | 歌词 | 备注 |
| --- | --- | --- | --- | --- |
| 酷狗 (kg)  | ✅ | ✅ | ✅ | 完全可用 |
| 酷我 (kw)  | ✅ | ✅ | ✅ | 完全可用 |
| QQ (qq)   | ✅ | ✅ | ✅ | 完全可用 |
| 网易云 (wy) | ✅ | ✅ | ✅ | 完全可用 |
| B 站 (bl) | ✅ | ✅ | ✅ | 完全可用（服务器转码 mp3） |
| 喜马拉雅 (FM) | ⚠️ | ❌ | N/A | 后端服务降级 |

### 元力菌系列

| 平台 | 搜索 | 播放 | 歌词 | 备注 |
| --- | --- | --- | --- | --- |
| 网易云 (元力WY) | ✅ | ❌ | ✅ | 播放代理 175.27.166.236 在测试环境超时 |
| 酷狗 (元力KG) | ✅ | ❌ | ✅ | 播放 404（后端返回结构可能变化） |
| 酷我 (元力KW) | ✅ | ❌ | ✅ | 播放 404（同上） |
| QQ (元力QQ) | ❌ | N/A | N/A | 测试环境签名可能不通 |
| 咪咕 (元力MG) | ❌ | N/A | N/A | 咪咕对境外 IP 限制 |

## 目录结构

```
├── README.md
├── manifest.json            # Z 系列订阅清单
├── plugins/                 # Z 系列插件
│   ├── FM.js
│   ├── kg.js
│   ├── kw.js
│   ├── qc.js
│   ├── qq.js
│   ├── bl.js
│   └── wy.js
└── yuanli/                  # 元力菌系列插件
    ├── manifest.json        # 元力菌系列订阅清单
    ├── wy.js
    ├── kg.js
    ├── kw.js
    ├── qq.js
    ├── xiaomi.js
    └── bilibili.js
```

## 致谢

- Z 系列原作者：wenshao
- 元力菌系列原作者：微信公众号「元力菌」
- bilibili.js 原作者：猫头猫（maotoumao）
- 反编译工具：[webcrack](https://github.com/j4k0xb/webcrack)
- 反编译 + 重写：Super Z
