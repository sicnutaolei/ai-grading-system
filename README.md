# 通用 AI 自动化阅卷系统

导入答题卡文件夹 → 调 `deepseek-flash` 逐张批改 → 实时看给分理由 → 人工改分覆盖 → 异常卷（没写名字 / 字迹不清）自动拦截置顶。

批改完成后列表按总分重排、显示名换成考生姓名（文件名不动）。可提前导入班级名单，让模型只能从名单里挑名字，避免手写姓名被读成别的字。

Tauri v2 (Rust) + React 18 + TypeScript + TailwindCSS + shadcn/ui。

| 正常卷 | 异常卷（红色横幅 + 列表置顶 + 姓名「未知」） |
|---|---|
| ![](docs/screenshot-normal.png) | ![](docs/screenshot-abnormal.png) |

> 截图取自 `npm run dev` 的预览模式，用的是**虚构示例数据**（姓名「张三」、代码画的示意答题卡 SVG），不含任何真实学生信息。

---

## 项目结构

```
ai-grading-system/
├── index.html
├── package.json
├── vite.config.ts                  # 端口 1420，@ → ./src
├── tailwind.config.js              # shadcn 的 HSL 变量方案
├── postcss.config.js
├── tsconfig.json
├── components.json                 # shadcn/ui 约定（可继续 npx shadcn add）
├── rubric.md                       # ★ 内置评分细则，前后端共用这一份
├── public/sample/                  # 预览用的示意答题卡（SVG，虚构）
│   ├── card-a.svg
│   └── card-b.svg
│
├── src/                            # ── 前端 ──
│   ├── main.tsx
│   ├── App.tsx                     # 三栏骨架 + 事件订阅生命周期
│   ├── index.css                   # 主题变量、画布底纹、细滚动条
│   ├── types.ts                    # 与 models.rs 一一对应（手写对齐）
│   ├── store.ts                    # zustand：状态 / 改分 / 修改日志 / 导出
│   ├── lib/
│   │   ├── bridge.ts               # invoke + 事件 + 浏览器 mock
│   │   ├── order.ts                # 异常置顶 + 按分数降序
│   │   ├── roster.ts               # 名单文本 ↔ 数组
│   │   ├── score.ts                # 总分重算、分数着色、分组
│   │   ├── rubric.ts               # ?raw 引入 rubric.md
│   │   └── utils.ts                # cn()
│   ├── components/
│   │   ├── Sidebar.tsx             # 左栏：配置 / 导入 / 文件列表
│   │   ├── ImageViewer.tsx         # 中栏：缩放 / 拖拽 / 翻页
│   │   ├── GradePanel.tsx          # 右栏：横幅 / 学生卡 / 明细 / 导出
│   │   ├── ScoreList.tsx           # 按题型折叠 + 逐题改分
│   │   ├── RevisionLog.tsx         # 修改日志时间轴
│   │   ├── PromptEditor.tsx        # 评分细则折叠编辑器
│   │   ├── Toaster.tsx
│   │   └── ui/                     # shadcn 基础件（button/input/…）
│   └── fixtures/
│       ├── sample.ts               # 预览数据（虚构）
│       └── sample-graded.json      # 脱敏后的评分结构样例
│
└── src-tauri/                      # ── 后端 ──
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json             # asset 协议、CSP、窗口
    ├── capabilities/default.json
    ├── dev-settings.json           # 本地测试配置（gitignore，仅 debug 读取）
    ├── icons/
    └── src/
        ├── main.rs
        ├── lib.rs                  # 9 个 command 的注册与实现
        ├── models.rs               # 前后端契约
        ├── prompt.rs               # include_str!(rubric.md) + 固定 JSON 契约
        ├── scanner.rs              # 文件夹遍历 + 自然排序
        ├── roster.rs               # 名单解析（UTF-8 / GB18030 / CSV 表头）
        ├── api.rs                  # deepseek-flash 请求（关思考/联网）
        ├── parser.rs               # JSON 抠取 + 归一化 + clamp
        ├── grading.rs              # 并发编排 + 事件推送
        ├── settings.rs             # 配置持久化
        └── exporter.rs             # CSV（带 BOM）/ JSON 导出
```

## 依赖

### 前端

| 包 | 用途 |
|---|---|
| `react` / `react-dom` 18 | UI |
| `@tauri-apps/api` 2 | `invoke` / `listen` / `convertFileSrc` |
| `@tauri-apps/plugin-dialog` 2 | 系统文件夹选择器 |
| `tailwindcss` 3 + `tailwindcss-animate` | 样式 |
| `@radix-ui/react-collapsible`, `react-slot` | 折叠面板、`asChild` |
| `class-variance-authority` `clsx` `tailwind-merge` | shadcn 的样式组合三件套 |
| `lucide-react` | 图标 |
| `zustand` 5 | 状态管理（改分 / 日志在 store 里统一落地） |

### 后端

| crate | 用途 |
|---|---|
| `tauri` 2（`protocol-asset`） | 应用框架 + `asset://` 协议 |
| `tauri-plugin-dialog` 2 | 文件夹对话框 |
| `reqwest` 0.12（`rustls-tls`） | 调接口（用 rustls，Windows 不依赖 OpenSSL） |
| `tokio` 1 | 异步 runtime、`JoinSet`、`Semaphore` |
| `serde` / `serde_json` | 序列化 + 宽容解析 |
| `base64` 0.22 | 图片转 data URL |
| `walkdir` 2 | 递归遍历 |
| `chrono` | 时间戳 |
| `encoding_rs` | 名单文件可能是 Excel 另存的 GB18030 CSV |
| `anyhow` / `thiserror` | 错误处理 |

## 开发

```bash
npm install
npm run dev          # 只跑前端（浏览器预览模式，数据是模拟的）
npm run tauri:dev    # 完整桌面应用（需要 Rust 工具链）
npm run tauri:build  # 打包
```

Rust 环境：装 [rustup](https://rustup.rs)，Windows 还需 MSVC Build Tools + WebView2（Win10/11 自带）。

本机已验证可用：`rustc 1.98.1 (x86_64-pc-windows-msvc)` + VS 2022 生成工具，`cargo` 在 `~/.cargo/bin`（已加入用户 PATH）。

> 首次 `cargo build` 要拉 400+ 个 crate（本机耗时约 12 分钟，主要是 crates.io 索引）；之后增量编译 3-6 秒。

配置优先级：`app_config_dir/settings.json`（界面里填的）> `src-tauri/dev-settings.json`（开发用，已 gitignore，仅 debug 构建读取，不会进二进制）。

## 关键实现说明

**1. 图片走 asset 协议，不走 Base64**

`convertFileSrc(path)` 生成 `asset://localhost/...`，前端只传路径。但**必须**在 Rust 端运行时授权目录：

```rust
app.asset_protocol_scope().allow_directory(&dir, true)?;
```

`tauri.conf.json` 里 `assetProtocol.scope` 故意留空数组 —— 只有老师真正选中的目录会被放行，比写 `["**"]` 安全得多。漏掉这行会稳定 403。

**2. 思考模式：用官方字段，而且默认开着**

最初按常见做法发了 `enable_thinking: false`，实测**无效**——DeepSeek 官方 API 会静默忽略这个字段（那是百炼系的），思考照跑不误（一张卷子 3526 个 reasoning token）。查文档后换成官方字段：

```json
{ "thinking": { "type": "enabled" | "disabled" } }
```

`reasoning_effort: low|high|max` 控制强度（默认 high，`none` 也可关）。思考模式下 `temperature` / `top_p` 不生效，所以只在关掉思考时才设 `temperature: 0`。

**默认开启思考**，因为实测关掉会明显变马虎（同一张样卷）：

| 模式 | 耗时 | 输出 tokens | 结果 |
|---|---|---|---|
| 开 | 28.6 s | 5744（其中思考 3526） | 得分点齐全，第 9 题「B 对 B」判对 |
| 关 | 7.1 s | 1978 | 第 9 题判 0 分，11(1) 两空（3d⁵4s² / +4）误给 4 分 |

所以 `max_tokens` 必须给足（现为 16384）。原来的 4096 会把 JSON 直接截断，而截断后的半截 JSON 又会被解析器的容错逻辑吞掉，最后给出一份"看起来很合理"的错误成绩——因此 `extract_content()` 把 `finish_reason=length` 当成硬错误抛出。

**3. JSON 容错三层**

- `extract_json_blob()`：跳过 ```` ```json ```` 围栏和前后废话，做**括号配平扫描**（跳过字符串字面量内的 `{}` 和转义），抠出第一个完整对象；
- 宽容 serde：`score` 可能是 `"6"` 字符串、`questions` 可能是 `null`、字段名有 alias；
- `normalize()`：**用内置分值表纠正模型**（第 1-10 题 6 分、11-3-1 是 3 分……），把分数 clamp 进 `[0, max]`，补全 `label` / `section`，缺姓名强制 `is_abnormal = true`。

**4. 人工改分不污染 AI 分**

`ai_score` 永远是模型原值，人工改分只写 `overrides[file][qid]`。所以「撤销」不需要重跑模型；修改日志是纯追加的时间轴。

**5. 评分细则只有一份**

`rubric.md` 在仓库根：Rust 用 `include_str!("../../rubric.md")`，前端用 `import ... ?raw`。改细则只改一个文件，两边不会漂移。JSON 输出契约写死在 `prompt.rs`，老师编辑细则时改不到。

**6. 名单纠错：把"猜名字"变成"选名字"**

手写姓名靠视觉识别不可靠（实测会把形近的三字名读成别的字，甚至凭空造一个）。导入班级名单后，`prompt.rs` 会插入一段强约束：

- `student_name` 必须是名单里的某一个完整姓名，原样照抄；
- 形近时选字形最接近的那个，并在总评里标「姓名按名单匹配，请核对」；
- 姓名栏为空或完全对不上任何一项 → `未知` + `is_abnormal: true`；
- **不许因为名单里有某个名字就硬套**（这条单独写，否则模型会倾向于"必须选一个"）。

名单文件支持 txt / csv，UTF-8 和 GB18030 都能读（Excel 在中文 Windows 下导出的 csv 就是 GB18030，用 UTF-8 解会全变乱码，而乱码的名单比没有名单更危险）。解析会跳过表头（`序号,姓名`）和序号列。

**7. 排序：异常优先于分数**

列表排序不是单纯按分数降序，而是：

1. **异常卷永远置顶** —— 它们的分数只来自"能看清的部分"，混进排名里会让老师误判班级情况；
2. 其余已批改的按 **AI 原始总分**降序（用 `total_ai` 而不是改分后的分数，这样老师改分时列表不会突然重排、把正在看的那张顶走）；
3. 未批改 / 失败的垫底，按文件名自然序。

显示名取考生姓名，拿不到才退回文件名；**文件名本身从不修改**，第二行小字仍然显示原文件名，方便对回原始文件。

## 当前状态

| 项 | 状态 |
|---|---|
| 前端类型检查 `tsc --noEmit` | ✅ 通过 |
| 前端生产构建 `vite build` | ✅ 通过（JS 245 KB / CSS 24.9 KB） |
| 真实接口联调 | ✅ `https://api.deepseek.com` + `deepseek-flash` 跑通整卷批改 |
| 异常卷识别 | ✅ 涂白姓名后正确返回 `is_abnormal: true` / `姓名: 未知` |
| Rust `cargo check` | ✅ 通过（rustc 1.98.1 / x86_64-pc-windows-msvc） |
| Rust `cargo test` | ✅ **20 passed, 0 failed** |
| Rust `cargo build` | ✅ 产出 20 MB debug exe；启动后窗口响应正常（28.6 MB 常驻） |

### 实测数据（同一张样卷，2026-10-26）

| 轮次 | 模式 | 耗时 | tokens | 姓名 | 总分 |
|---|---|---|---|---|---|
| 1 | 开思考 | 28.6 s | 5744 | 识别正确 | 31 |
| 2 | 关思考 | 7.1 s | 1978 | 识别正确 | 29（多算 5-7 分） |
| 3 | 开思考 | 27.6 s | 5800+ | 识别正确 | 41 |

⚠️ **同一张卷子两次批改差了 10 分**，差异集中在有涂改的选择题（第 2 题被读成 B 或 D、第 10 题被读成 B 或 D）。手写体识别本身有随机性，这套系统不能承诺"批完就是对的"，它承诺的是**把可疑的地方标出来让人复核**。

## 已知限制

- **非确定性**：同一张卷子重复批改有波动（实测 31 / 41），必须抽检。思考模式也无法用 `temperature` 压掉这个波动（文档明确思考模式忽略该参数）。
- **姓名会读错**：实测会把形近的手写姓名读串（三字名读成另一个字）。所以姓名做成了可直接编辑的输入框，改完自动记进修改日志；若异常原因是"没写名字"，补名字后会自动摘掉异常标记。
- **模型自报总分和明细经常对不上**（36 vs 29、30 vs 26）。程序一律按明细求和，并在分数下方提示 `自报 36 ≠ 明细 29`。
- API Key 以明文存在 `app_config_dir/settings.json`；开发用的测试 Key 放在 `src-tauri/dev-settings.json`（已 gitignore，仅 debug 构建读取，不进二进制）。
- 图片不做压缩，单张超过 8 MB 会在日志里提示但不拦截（多数网关单图上限 10 MB）。
- 超过 30 张的大批量建议把并发调低（左侧「批改设置」里可改，默认 3，上限 8）。
