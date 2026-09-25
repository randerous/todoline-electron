# TodoLine Electron 0.2.11 · macOS 跑通与使用测试报告

日期：2026-09-25 · 验证环境：macOS (Apple Silicon)
源码：`TodoLine-Electron-0.2.11-source.zip` 解压到 `TodoLine-Electron-0.2.11-source/`

## 1. 结论摘要

- 项目在 macOS（Apple Silicon）上已经**跑通**：可编译、可启动、可正常编辑/保存/搜索/导出/提醒/**复制粘贴**，端到端冒烟 **39/39 通过**，类型检查通过，单元测试 **966 通过 / 7 失败**（7 项全部是 Windows 专用工具链或平台语义导致，与 macOS 产品逻辑无关）。
- 测试中发现并**修复 2 个真实缺陷**：
  1. 文档路径规范化不一致，导致"仅修改文件名大小写"的重命名必然失败（`Only a filename case change is allowed.`）；macOS 与 Windows 的别名路径场景都受影响。
  2. 剪贴板写入被 `process.platform !== 'win32'` 直接拒绝，macOS 上**任何复制都不生效**（文字/富文本/事件/图片全部弹"当前发布版仅支持 Windows 剪贴板"）。
- 其余发现属于"Windows 专用产品在 macOS 上使用"的平台限制，见第 5 节。

## 2. 环境与前置条件

| 项 | 值 |
| --- | --- |
| 系统 | Darwin 24.6.0 / arm64（Apple Silicon） |
| Node | v25.9.0（项目 `engines` 要求 `>=24 <25`，仅告警） |
| pnpm / npm | 11.9.0 / 11.12.1（`packageManager` 声明 pnpm@11.19.0） |
| Electron | 40.10.6（darwin-arm64，ABI 143） |
| better-sqlite3 | 12.11.1（Node ABI 141 + Electron ABI 143 两份预编译） |

项目本身是 **Windows 专用**：`prepare-native.mjs` / `prepare-runtime.mjs` / `build-clipboard.mjs` 对 `win32 x64` 硬校验，`image-codec.cpp` 依赖 WIC、`clipboard-win.c` 依赖 user32，electron-builder 目标为 win zip。因此原生 `pnpm build` / `pnpm dev` 在 macOS 会直接抛错。

本次为跑通新增了三个 macOS 脚本（不改动 Windows 流程）：

```bash
pnpm install                 # registry.npmjs.org 可用
# github.com 在本机不可达：Electron 与 better-sqlite3 预编译改走 npmmirror 镜像，
# 并缓存进工作区（沙箱只允许写工作区）
pnpm build:mac               # = scripts/build-mac.mjs：esbuild 主进程 + vite 渲染进程
pnpm dev:mac                 # = scripts/dev-mac.mjs：构建后启动（macOS 默认补 --no-sandbox）
pnpm smoke:mac               # = scripts/smoke-mac.mjs：37 项端到端冒烟
```

需要准备的本地二进制（已在本次会话中下载到 `.cache/`）：

```bash
curl -L -o .cache/downloads/bs3-node.tar.gz \
  https://npmmirror.com/mirrors/better-sqlite3/v12.11.1/better-sqlite3-v12.11.1-node-v141-darwin-arm64.tar.gz
tar -xzf .cache/downloads/bs3-node.tar.gz --strip-components=2 -C node_modules/better-sqlite3/build/Release build/Release/better_sqlite3.node
curl -L -o .cache/downloads/bs3-electron.tar.gz \
  https://npmmirror.com/mirrors/better-sqlite3/v12.11.1/better-sqlite3-v12.11.1-electron-v143-darwin-arm64.tar.gz
tar -xzf .cache/downloads/bs3-electron.tar.gz --strip-components=2 -C .cache/native build/Release/better_sqlite3.node
cp .cache/native/better_sqlite3.node .cache/native/electron.node
# Electron 自身：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

> 本会话内 Chromium sandbox 无法初始化（`sandbox initialization failed: Operation not permitted` → GPU 进程反复崩溃、`GPU process isn't usable. Goodbye.`），所以启动必须带 `--no-sandbox`。这是环境限制，不是产品缺陷。

受限环境下启动图形界面的推荐命令（把配置目录放进工作区，避免 DSH 文件沙箱拒绝写
`~/Library/Application Support/TodoLine-Electron` 而报 `SingletonLock: No such file or directory`）：

```bash
TODOLINE_DATA_DIR="$PWD/.cache/run-profile" pnpm dev:mac
```

普通 macOS 桌面环境直接 `pnpm dev:mac` 即可（脚本仅在需要时补 `--no-sandbox`）。

## 3. 测试方法与规模

| 层次 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `pnpm typecheck` | 通过（无输出） |
| 单元测试 | `pnpm test`（vitest，jsdom+node） | **966 通过 / 7 失败 / 8 跳过（981）** |
| 端到端冒烟 | `pnpm smoke:mac`（Playwright 驱动真实 Electron，真实 SQLite 文件校验） | **39 项全通过**（连续两轮），0 渲染进程异常、0 console error |
| 构建 | `pnpm build:mac` | 通过 |

冒烟脚本要点：macOS 上编辑器快捷键是 ProseMirror `Mod-*`（即 Cmd），所以脚本用 Cmd；原生菜单加速键（Cmd+N/O/S/F）无法通过 CDP 注入，脚本改用菜单实际使用的同一条 IPC 通道 `tl:command` 触发，其余交互全部是真实点击/键入。

### 单元测试 7 项失败的定位（均非 macOS 产品逻辑问题）

1. `tests/image-native.test.ts` —— 需要 Windows WIC 助手 `image-codec.exe`；macOS 上 `g++` 因 `windows.h` 缺失编译失败。
2. `tests/block-structures.test.ts`、`tests/paragraph-format.test.ts`×2、`tests/tables.test.ts` —— 需要 Qt 侧校验工具 `.cache/qt-compat/qt-compat.exe`（Windows 专用）。
3. `tests/rename-storage.test.ts > an external reader that prevents rename...` —— 依赖 Windows"文件被占用则不能重命名"的语义；POSIX 允许重命名已打开文件，该分支在 macOS 不可达。
4. `tests/storage.test.ts`×2（并发/冲突注入类）—— 测试把 mock 挂在**未规范化**的 tmpdir 路径字符串上（`/var/folders/...`），而 `open()` 内部存的是 `realpathSync` 结果（`/private/var/folders/...`），于是 mock 永不命中。属测试可移植性，产品逻辑正常。

### 端到端冒烟覆盖（39 项，全部通过）

- 启动与首页、新建文档（`YYYYMMDD_N.tde` 命名）、输入并自动保存进 SQLite
- Cmd+H 事件分隔线、Cmd+B 加粗（`<strong>` 落库）、Cmd+Z / Cmd+Shift+Z 撤销重做
- 完成勾选 `done=1`、截止时间解析（`明天下午3点` / `1 分钟后`）与倒计时
- Cmd+L 有序列表 + Tab 缩进、插入链接（`<a>` 落库）、插入 3×3 表格、插入 PNG（资产表 + 预览）
- 快速搜索命中；**复制粘贴**：选中文字复制到系统剪贴板、Cmd+Shift+C 复制事件并在新标签粘回（结构保留）、选中图片复制并在新标签粘回
- 浮动搜索窗（当前文件 / 所有打开文件）、主题切换并持久化、行号开关、自动换行开关
- 事件日历、最近文档列表、导出 md/txt/pdf（含图片 PDF）、另存为副本并复读
- 关闭空草稿自动清理、关闭有内容的文档保留文件与历史、双击图片进入原图查看 + Esc 关闭
- 非法文件名拒绝且不改名、新建文档目录设置生效
- 空白标签粘贴 Markdown 自动转 `.md`、纯文本文件按文本模式打开
- 标签改名保留 `.tde`、仅改大小写改名、`.tde` → `.md` 格式转换（正文保留 + 恢复副本）
- 重启会话恢复

## 4. 发现并修复的缺陷

### 4.1 路径规范化不一致 → 仅改大小写重命名失败（已修复）

- **现象**：对已保存文档执行"只改文件名大小写"（例如 `改名后文档.tde` → `改名后文档.TDE`）时报 `Only a filename case change is allowed.`，重命名不生效。
- **根因**：`DocumentStore` 内部对文档路径的规范化前后不一致。
  - `open()` 用 `realpathSync(path)` 存路径：macOS 上 `/var/folders/...` 变成 `/private/var/folders/...`。
  - `saveAs()` 对**尚不存在**的目标文件用 `resolve(path)`，于是"另存为/改名"产生的新文档存的是未规范化路径；应用内"标签改名"正是走 `saveAs` + 删除原文件实现的。
  - `renameCase()` 用 `resolve(入参)` 的目录与 `doc.path` 的目录直接比较；只要两侧规范化形式不同（`/var` vs `/private/var`）就必然抛错。
- **影响面**：macOS 上任意别名/软链接目录（`/var`、`/tmp`、`iCloud`、软链目录）都会触发；Windows 上同类触发条件是 8.3 短名、`subst` 虚拟盘、junction、或调用方传入大小写不同的路径。单元测试在 Windows 上因 tmpdir 没有别名而未暴露。
- **修复**（`src/main/storage.ts`）：
  - 新增 `canonicalPath()`：对父目录做 `realpathSync`、保留调用方 basename，失败时回退 `resolve()`。
  - `saveAs()` 的目标路径（含尚不存在的新文件）也走 `canonicalPath()`，从此所有落库路径形式统一。
  - `renameCase()` 改为：basename 大小写不敏感比较 + 两侧目录都规范化后比较，并以规范化目标路径执行 `rename`（源路径即使是非规范化的旧记录也能正确匹配同一物理目录）。
- **验证**：
  - `tests/rename-storage.test.ts` 由 1/4 通过变为 3/4 通过（余下 1 项是 POSIX 语义差异，见 3 节）。
  - 单元测试总数 963 → **966 通过**。
  - 应用内端到端：`仅改大小写改名` 从失败变为通过，且改名后事件数据完整（3 个事件）。
  - `pnpm typecheck`、`pnpm build:mac` 通过。

复现路径（未修复前，冒烟脚本第 34 项）：先做一次"改名 → 新名字"（走 saveAs，路径变成 `/var/...`），再对同一文档做"仅改大小写"。修复前主进程报 `Only a filename case change is allowed.`，修复后返回新快照且事件数不变。

### 4.2 剪贴板写入只支持 Windows → macOS 上任何复制都失效（已修复）

- **现象**：macOS 上选中文字按 Cmd+C、复制事件按 Cmd+Shift+C、复制图片，系统剪贴板始终为空，界面弹 `当前发布版仅支持 Windows 剪贴板`；但从外部粘贴进 TodoLine 正常（读取走 Electron 原生剪贴板）。
- **根因**：`writeClipboard()` 第一句就是 `if (process.platform !== 'win32') throw`，写入完全依赖 `clipboard-win.exe`（把 CF_UNICODETEXT / CF_DIBV5 / HTML Format / 自定义格式打包进 Windows 剪贴板）。
- **实测约束**：Electron 自身的剪贴板在 macOS 上可以写 text/html/image，但 `clipboard.writeBuffer()` 会**清空**剪贴板，因此"标准格式 + 自定义事件格式"无法分两次写入。
- **修复**（`src/main/clipboard.ts`，Windows 分支一行未改）：
  - 非 Windows 走新的 `writePortableClipboard()`：一次 `clipboard.write({ text, html, image })` 写入标准格式（外部程序可正常接收文字/富文本/图片）。
  - 事件结构载荷改为**内嵌在 HTML 注释里**（`<!--todoline-events:BASE64-->`）：外部程序忽略该注释，应用自身在 `readClipboard()` 中还原出 `events`，于是应用内"复制事件 → 粘贴"仍保留事件结构（分隔线、状态、资产）。图片复制走标准 PNG 通道，粘回时按图片重新入库。
  - 写后校验：文本、图片、内嵌载荷三项读回比对，不一致则提示重试（与 Windows 分支同等强度）。
- **验证**（macOS 实测 + 冒烟固化）：
  - 选中文字 Cmd+C → 系统剪贴板得到 `第一行测试内容…`，无错误提示。
  - 复制事件 Cmd+Shift+C → 剪贴板文本为 `==== 2026-09-25 12:41:08 ====\n第二事件`，在新标签 Cmd+V 粘回后 SQLite 中重新出现该事件。
  - 选中图片 Cmd+C → 剪贴板图片 120×90，新标签 Cmd+V 粘回后图片正常显示。
  - Windows 分支保持原样（`clipboard-win.exe` + 打包校验）。

## 5. macOS 上的平台限制（未改代码，使用前需知悉）

1. **仍属 Windows 专用的剪贴板路径**：从资源管理器"复制图片文件"再粘贴（CF_HDROP 文件列表）、TIFF/BMP/ICO 解码依赖 `clipboard-win.exe` / `image-codec.exe`，macOS 上不可用；普通文字/富文本/事件/PNG·JPEG·GIF·WebP 图片的复制粘贴已可用。
2. **快捷键提示与 macOS 实际按键不符**：README 与界面提示都是 `Ctrl+B/I/H/L/Z/Y`、`Ctrl+Shift+C/X/V`，实现是 ProseMirror `Mod-*`，macOS 上等于 **Cmd**。按文档的 Ctrl 组合在 macOS 上完全无效；另外 `Cmd+H`（分隔线）与系统"隐藏应用"快捷键冲突，建议 macOS 下改用工具栏"分隔线"按钮。
3. **去掉后缀重命名 = 转纯文本**：把 `.tde` 改名为无后缀名字会触发格式转换——原 `.tde` 被移除、正文降级为纯文本（原文件保留恢复副本在 `userData/recovery/format-renames`）。这与 `docs/release-0.2.8.md` 的"可移除后缀 + 按后缀路由"一致，但对"只想改个名字"的用户风险偏高，建议后端无后缀时给二次确认。
4. **图片格式助手**：TIFF/BMP/ICO 依赖 Windows WIC 助手，macOS 上不可用；PNG/JPEG/GIF/WebP 走 Chromium 解码，正常。

## 6. 低危健壮性观察

- 主进程 `tl:opened` 载荷未做形状校验：手工注入一个缺少 `name` 的快照即可让渲染进程在标签栏 `snapshot.name.replace(...)` 抛 `TypeError` 并整页失效。正常 UI 路径不可达（内部 IPC 通道），但加一行形状校验成本很低。

## 7. 源码/工作区卫生

- `TodoLine-Electron-0.2.11-source.zip` 内含 macOS 打包产生的 AppleDouble 垃圾文件（`._*`，共 231 个，`src/` 下每个源文件都有一份），已清理；不影响构建，但建议重新打包时排除。
- 工作区磁盘（exFAT 卷）不支持硬链接，部分原子写工具会 `ENOTSUP`；本次改用 shell 写入，产品代码不受影响。

## 8. 改动清单

| 文件 | 说明 |
| --- | --- |
| `scripts/build-mac.mjs` | 新增：macOS 开发构建（跳过 Windows 原生助手与 win32 校验） |
| `scripts/dev-mac.mjs` | 新增：构建后启动 Electron，macOS 默认补 `--no-sandbox` |
| `scripts/smoke-mac.mjs` | 新增：37 项端到端冒烟（Playwright + Electron，含 SQLite 落库断言） |
| `package.json` | 新增 `build:mac` / `dev:mac` / `smoke:mac` 三个脚本（Windows 脚本未改） |
| `src/main/storage.ts` | 修复：`canonicalPath()` + `saveAs`/`renameCase` 路径规范化一致性 |
| `src/main/clipboard.ts` | 修复：非 Windows 平台用 Electron 原生剪贴板写入标准格式；事件载荷内嵌 HTML 注释以便应用内结构粘贴 |
| `.cache/smoke/report.json` | 冒烟明细（每项结果、探针状态、主进程输出） |

Windows 原有流程（`scripts/setup.ps1`、`dev.ps1`、`pnpm build`、`pnpm package`）未做任何改动。
