# xmly-decompiled

> 从 [gitcode.com/wenshao/xmly](https://gitcode.com/wenshao/xmly) 反编译并人工重写的 7 个 MusicFree 插件合集。
>
> 原作使用 `javascript-obfuscator` 进行字符串数组 + 控制流混淆，本仓库通过 `webcrack` 还原后，进一步做了变量重命名、函数 JSDoc 注释、关键算法分步注释。

## 包含插件

| 文件 | 平台标识 | 功能 |
| --- | --- | --- |
| `plugins/FM.js`  | xmFM   | 喜马拉雅有声书 |
| `plugins/kg.js`  | 温kg    | 酷狗概念版（含云盘/歌单导入） |
| `plugins/kw.js`  | 温酷我  | 酷我音乐 |
| `plugins/qc.js`  | 温Q词   | QQ 音乐独立歌词源 |
| `plugins/qq.js`  | 温Q     | QQ 音乐全功能 |
| `plugins/wbl.js` | 温哔哩  | B 站（含 WBI 签名 / DASH 音频流） |
| `plugins/wy.js`  | 温网易  | 网易云音乐 |

## 一键导入 MusicFree

把下面的链接作为订阅地址添加到 MusicFree 的「订阅管理」中：

```
https://raw.githubusercontent.com/martin65536/xmly-decompiled/main/manifest.json
```

导入后会自动出现 7 个插件，可单独启用/禁用。

## 反编译质量

- 7 个文件全部通过 `node --check` 语法校验
- 与原混淆版的导出 key 集合完全一致（验证脚本：`scripts/verify_readable.js`）
- 平台标识、版本号、作者字段与原版完全一致
- 关键算法（WBI 签名、songId↔songmid 转换、DASH 音轨选档）逐步骤注释

## 目录结构

```
xmly-decompiled/
├── README.md
├── manifest.json            # MusicFree 订阅清单
├── LICENSE                  # AGPL-3.0
└── plugins/
    ├── FM.js
    ├── kg.js
    ├── kw.js
    ├── qc.js
    ├── qq.js
    ├── wbl.js
    └── wy.js
```

## 致谢

- 原作者：温 / monkeycode
- 反编译工具：[webcrack](https://github.com/j4k0xb/webcrack)
- 反编译 + 重写：本仓库作者

## License

AGPL-3.0 — 与原仓库保持一致
