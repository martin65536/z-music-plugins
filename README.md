# xmly-decompiled

> 从 [gitcode.com/wenshao/xmly](https://gitcode.com/wenshao/xmly) 反编译并人工重写的 7 个 MusicFree 插件合集。
>
> 原作使用 `javascript-obfuscator` 进行字符串数组 + 控制流混淆，本仓库通过 `webcrack` 还原后，进一步做了变量重命名、函数 JSDoc 注释、关键算法分步注释，并将作者署名统一改为 **Super Z**。

## 包含插件

| 文件 | 平台标识 | 功能 | 版本 |
| --- | --- | --- | --- |
| `plugins/FM.js`  | Z·喜马拉雅 | 喜马拉雅有声书 | 0.1.1 |
| `plugins/kg.js`  | Z·酷狗    | 酷狗概念版（含云盘/歌单导入） | 0.3.1 |
| `plugins/kw.js`  | Z·酷我    | 酷我音乐 | 0.1.1 |
| `plugins/qc.js`  | Z·QQ歌词   | QQ 音乐独立歌词源 | 1.0.1 |
| `plugins/qq.js`  | Z·QQ音乐  | QQ 音乐全功能 | 0.4.1 |
| `plugins/bl.js`  | Z·哔哩哔哩 | B 站（含 WBI 签名 / DASH 音频流） | 0.0.2 |
| `plugins/wy.js`  | Z·网易云  | 网易云音乐 | 0.0.2 |

## 一键导入 MusicFree

把下面的链接作为订阅地址添加到 MusicFree 的「订阅管理」中：

```
https://raw.githubusercontent.com/martin65536/xmly-decompiled/main/manifest.json
```

导入后会自动出现 7 个插件，可单独启用/禁用。

## 反编译质量

- 7 个文件全部通过 `node --check` 语法校验
- 与原混淆版的导出 key 集合完全一致
- 关键算法（WBI 签名、songId↔songmid 转换、DASH 音轨选档）逐步骤注释
- 每个文件顶部都有 `BASE_URL` 常量，方便统一切换后端

## API 可用性测试（2026-09-04）

| 平台 | 搜索 | 播放 | 歌词 | 备注 |
| --- | --- | --- | --- | --- |
| 酷狗 (kg)  | ✅ | ✅ | ✅ | 完全可用 |
| 酷我 (kw)  | ✅ | ✅ | ✅ | 完全可用 |
| QQ (qq)   | ✅ | ✅ | ✅ | 完全可用 |
| 网易云 (wy) | ✅ | ✅ | ✅ | 完全可用 |
| 喜马拉雅 (FM) | ⚠️ | ❌ | N/A | 后端服务降级 |
| B 站 (bl) | ❌ | ❌ | N/A | 测试 IP 被风控，换 IP 应可用 |

## 目录结构

```
xmly-decompiled/
├── README.md
├── manifest.json            # MusicFree 订阅清单
├── plugins/
│   ├── FM.js                # Z·喜马拉雅
│   ├── kg.js                # Z·酷狗
│   ├── kw.js                # Z·酷我
│   ├── qc.js                # Z·QQ歌词
│   ├── qq.js                # Z·QQ音乐
│   ├── bl.js                # Z·哔哩哔哩
│   └── wy.js                # Z·网易云
```

## 致谢

- 原作者：wenshao
- 反编译工具：[webcrack](https://github.com/j4k0xb/webcrack)
- 反编译 + 重写 + 署名改造：Super Z
