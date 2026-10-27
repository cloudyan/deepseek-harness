# apps/ 四应用架构：cli · desktop · desktop-host · web

> 源码设计分析笔记（单语维护，不承担 docs/ 的双语配对契约）。引用提交请用 tag 或 PR 链接，勿写裸 commit 哈希（repository-references 门禁）。
>
> 姊妹篇：[enterprise-architecture.md](enterprise-architecture.md)——企业级部署（多租户、隔离边界与分层归属）。本文回答"现在是什么"，那篇回答"要交付给一个企业、企业内部还要分人时该做什么"；那篇另含**外部同行对照**（云端 chat 为何能单部署多用户）与**工具面装配边界**（撤掉 `dsh-tool-*` 能得到什么、得不到什么）。

## 总览

一套 Cordis agent 内核，四种外壳复用：`apps/cli` 是统一启动器，`apps/web` 是唯一的前端 UI，`apps/desktop` 是 Electron 安全壳，`apps/desktop-host` 是把同一套 agent 树以 headless 方式跑在 Electron 里的 Node 子进程；四个应用不实现业务逻辑，全部是围绕 `packages/` 内核的装配与交付层。

![apps 四应用架构关系图](apps-architecture.svg)

### 分层全景

按"入口层 → 对接服务层 → harness 内核 → 内置运行时"的分层视角：

![apps 分层全景架构图](apps-architecture-layers.svg)

- **入口层**：CLI、Web、Desktop、Headless、SDK、ACP 六类已支持；IM Bot、移动端/远程为虚线灰底预留位——**其底层能力面已经就绪**（`dsh --profile sdk-net` 把 SDK 契约暴露到 TCP），缺的是 IM 网关与客户端本身（含认证）。
- **对接服务层**：无单一 app-server，五个协议适配器（HTTP+WS / NDJSON-stdio / NDJSON-TCP / JSON-RPC-stdio / one-shot）全部经由同一条 `runProfile()` 装配路径复用内核。
- **harness 内核**：Cordis agent 树的模块分组——会话与编排、工具与执行、生态与集成（mcp/skill/hooks 等）、存储与会话数据。
- **内置运行时**：primary-runtime（Node/CPython/pnpm/wheels，sha256 锁定）随桌面交付；CLI/Web 形态用系统运行时。

两种会话形态的进程与请求拓扑：

```
Web session:
  dsh web (CLI process, local)
    |- Cordis tree: webserver (127.0.0.1:<port>) + agent + plugins
    '- browser -- HTTP/WS --> same process, apps/web dist + /api

Desktop session:
  Electron main (apps/desktop main.ts)
    |- renderer (sandboxed) -- dsh-app://app = apps/web dist
    |    '- /api -- auth cookie --> 127.0.0.1:19387
    '- desktop-host child (ELECTRON_RUN_AS_NODE, IPC fd)
         '- runProfile('desktop'): webserver:19387 + agent + plugins
```

### 运行时的归属：不是第四层，是交付基础层

请求链路不经过运行时（入口 → 服务适配 → 内核即闭环），所以严格说模型是 **3 层 + 1 个垂直基础层**。运行时的"仅 desktop"是**实现现状而非架构约束**：

- **现状**：全仓只有 `apps/desktop/scripts/prepare-primary-runtime.ts` 做供给，唯一消费点是 desktop-host（`desktop-host/src/index.ts:71` 的 `desktopOffice` 插件，装入 `resolveDshHome()/dsh-runtimes/`，即 `$DSH_HOME` 或 `~/.dsh`）。`apps/cli` 零运行时供给逻辑，用系统 Node/Python。
- **合理性**：desktop 面向终端用户，不能假设机器上有 Node/Python，且要求离线可装、sha256 可复现——自带运行时是必要条件；CLI/web/SDK/ACP/headless 面向开发者与自动化，环境里本来就有 Node（否则装不了 dsh），捆绑反而拖慢安装。
- **代价**：同一 agent 两种形态能力不一致——desktop 里 Python 技能用的锁定 CPython 3.12.14，CLI 里取决于用户系统 Python；headless/CI 若需可复现执行也没有现成机制。
- **演进空间**：`$DSH_HOME/dsh-runtimes/` 是 per-user 共享路径（`packages/util/home-paths`），任何 dsh 进程都可读。把供给逻辑从 desktop scripts 提升为共享包或 `dsh runtime install` 子命令，CLI/headless 即可复用同一份锁定运行时，消除形态差异。

### IM 入口现状：无 im-gateway，最近的种子是 webhook

仓库没有 im/gateway/bot/messaging 类包。最接近的是 `packages/webhook/`（webhook · webhook-github）：接收**已验证的外部 provider 事件**，按规则 fire-and-forget 地创建 DSH Session（无投递库/队列/重试/去重，也无 Agent 完成态回传）。它是"外部事件 → 会话"的单向通道，缺 IM 网关需要的**双向对话**（回复路由回消息平台、会话↔聊天线程绑定、幂等/重试）。若未来做 IM 入口，webhook 家族可承载入站事件，出站回复需要新增 provider 适配层（或经统一 app-server/SDK 面）。企业级形态下的完整归属分解见 [enterprise-architecture.md §3.4](enterprise-architecture.md#34-im-管理)。

### app-server 化

dsh 的 app-server 化 = 把现有 sdk 能力面（turn/会话/工具/审批/文件/查询）以 latest-only 契约暴露到网络 transport，具体就是三件小事：WS/TCP transport、Typert 方法面快照导出、（可延后的）网络认证。HMR、模块表、注入、resources 这些 UI 投影机制与契约无关，永远留在自家 web UI 的同源快车道上。

**进度（三件小事里两件已落地）**：`packages/bundle/sdk-net` 提供 `dsh --profile sdk-net`——**TCP** transport（每个连接一个 `JsonRpcLineTransport` 包住 socket，NDJSON 分帧，默认连接上限 8，`session.event` / `session.status` / `subagent.*` 通知扇出给所有活连接）与 Typert 方法面快照导出（`--descriptor-snapshot`，可进 CI 比对）。**WS 与网络认证未做**，且监听端**只接受 loopback 绑定**（非回环直接报用法错误），所以现在还不能当公网或跨主机服务用。关键在于契约面实现 `HarnessSdkJsonRpcServer` 与传输类**一行未改**——stdio 的 `sdk` profile 行为完全不变，两者是并存的兄弟而非替代。企业级用法见姊妹篇 §5「阶段 1」。

## 各应用职责

### apps/cli（`@deepseek-ai/dsh`，统一启动器）

- 入口为 `bin.dsh → lib/bin.js`（源码 `apps/cli/src/bin.ts`），自身不实现任何 agent 逻辑，只解析启动器自有 flags 并透传其余参数（`args.ts:6-11`）。
- `dsh [--profile] <name> [app-args...]`：第一个裸 token 展开为 profile 名，所以 `dsh web` 等价于 `dsh --profile web`；`--patch <yml>` 叠加配置 overlay；profile 名 `desktop` 被显式拒绝（`args.ts:73-77`），由 Electron 独占。
- `dsh plugin --profile <name> <pnpm-args...>`：在 profile 目录内转发 pnpm 增删插件包（`args.ts:171-183`）。
- `dsh web` 时 CLI 进程本身就是 web server：webserver + agent + 插件全部在同一进程，浏览器直连（`packages/bundle/web-app/src/index.ts`）。

### apps/web（`@deepseek-ai/dsh-web-frontend`，唯一前端 UI）

- Vite 应用，构建产物 `dist/`；UI 内核是 `packages/client/web`，组件库在 `packages/client/ui-*`。
- **刻意做薄的壳**：源码仅 4 个文件（`src/main.ts` 等）+ `index.html` + `vite.config.ts`，其余为 tests/（数十个 e2e）。`main.ts` 只做两件事：`new AppWebEntry(el)` 挂载 `#root`；desktop 模式下等待 `dshDesktopBoot.ready()` 注入后再引导（`applyIndexInjections`）。
- **UI 真正的实现是 `packages/client/` 的客户端插件树（约 50 包）**：`dsh-client-web` 是引导内核（静态模块表 + Cordis loader + UI-renderer 交接）；`dsh-client-modules` 的浏览器侧是 lazy-CJS 模块表，由 vendored Cordis Loader 消费——**web UI 本身也是一棵 Cordis 插件树**，与后端 agent 同一套组合机制；40+ 个 `ui-*` 功能包（ui-chat、ui-conversation、ui-dockkit 停靠布局、ui-tool/ui-trajectory、ui-approval、ui-settings-* 族、ui-sidebar-* 族）经 `ui-slots` 插槽注册、`ui-renderer` 渲染。
- 自身不提供服务，`dist/` 被两个宿主复用：CLI 的 `dsh web` 与 Electron 桌面壳。
- 注意 `packages/web/web`（`@deepseek-ai/dsh-web`）是网页搜索/抓取能力包，与此 UI 无关。

### apps/desktop（`@deepseek-ai/dsh-desktop`，Electron 安全壳）

- 主进程 `src/main.ts` 职责严格限定为壳：注册特权自定义协议 `dsh-app://app`（`ipc.ts`），renderer 的静态资源即 apps/web dist（`main.ts:403` → `web-document.ts` 的 `serveWebDocument`）。
- `/api` 等动态请求经 `authenticateWebHost()`（cookie 认证）后由 `forwardWebRequest()` 转发到 host 的 `127.0.0.1:19387`。
- sandbox + contextIsolation 开启（`main.ts:134-140`），preload 只暴露白名单桥（`preload-*.ts` 一族）。
- 承担打包与更新面：`scripts/prepare-dsh.ts`（物化生产运行时）、`prepare-primary-runtime.ts`（锁定 CPython/Node/pnpm/wheels）、release 元数据（`src/release.ts`）与自动更新。

### apps/desktop-host（`@deepseek-ai/dsh-desktop-host`，headless 宿主）

- 核心是单文件 `src/index.ts`：读 argv → 加载 profile → 调用与 CLI 完全相同的 `runProfile()`（`index.ts:5`），profile 固定 `'desktop'`，应用参数 `['--no-open', '--port', '19387']`（`index.ts:24`）。
- webserver + agent + 插件都活在这个 Node 模式子进程里（Electron 可执行 + `ELECTRON_RUN_AS_NODE`，`host-process.ts:115-128`），stdio 仅透传，控制面走 Electron IPC。
- 额外承担 `update-tasks` 控制面（自动更新前检查/锁定活跃任务）和 `desktopOffice` 插件（把 primary-runtime 中的 python/pnpm 安装到 `$DSH_HOME/dsh-runtimes/`，挂载 Office 技能）。

## 对外服务面与协议矩阵

没有单一的 "app-server" 二进制，而是按消费方分层的多个服务面，由 profile 机制决定装配哪一个；agent 内核始终是同一棵 Cordis 树，外层只是协议适配器。

| 服务面 | 承载包 / profile | 协议 | 消费方 | Codex 类比 |
|---|---|---|---|---|
| UI 服务 | `dsh-host-webserver`（`web` / `desktop` profile） | HTTP + WebSocket | 浏览器 / Electron renderer（`/api`） | 无直接对应（Codex UI 非 web） |
| SDK 服务 | `dsh --profile sdk`：`dsh-sdk-jsonrpc-server` | newline-delimited JSON-RPC over stdio | TS SDK、Python SDK（`python/sdk`） | 约等于 Codex `app-server` |
| 网络 SDK 服务 | `dsh --profile sdk-net`：`dsh-sdk-net` | newline-delimited JSON-RPC over TCP（仅 loopback） | 常驻客户端；IM / 远程 / 移动接入层的底座 | 约等于 Codex `app-server` 的常驻形态 |
| 自动化服务 | `@deepseek-ai/dsh-acp`（`acp` profile，automation-only） | JSON-RPC over stdio（Agent Client Protocol） | 编辑器/自动化客户端（Zed 一类） | 约等于 Codex IDE 集成面 |
| 一次性命令 | `@deepseek-ai/dsh-headless`（`headless` profile） | 无服务：跑完即退；`--json` 输出 NDJSON 事件流 | 脚本、CI | 约等于 `claude -p` |

- wire protocol 收敛在 `packages/sdk/protocol`（命名请求/结果/通知类型，TS 与 Python 共享同一份）。
- 两个 SDK 面（stdio 与 TCP）**共用同一份能力面实现与同一套 wire 类型**，差别只在 transport 与生命周期归属：stdio 随 stdin EOF 结束、单客户端；`sdk-net` 由客户端 `shutdown` 应答后退出 0、多客户端（默认上限 8），断线不影响已建会话。
- `host-webserver` 刻意"无知"：不懂业务、不管静态文件，路由与资源由组合方注入（`packages/host/webserver/src/index.ts` 头注释）。
- Electron 主进程↔host 的 IPC（ready/fatal/shutdown-complete/update-tasks）是桌面壳生命周期控制面，不承载 agent 业务。
- `headless` bundle 不监听端口、无残留进程，模型、工具、安全默认值与其他面完全一致。

## 命令行交互形态

- 交互式终端 REPL/TUI 不存在：`apps/cli` 定位是启动器，无 readline/ink 类 TUI 依赖；`packages/terminal` 是 agent 侧的持久终端工具，不是 UI。
- 最接近的形态是 one-shot：`dsh --profile headless "task"`（约等于 `claude -p`），单任务、无 GUI、可 `--json` 编程消费、可 `--session-id` 恢复对话；会话存储共享，之后可在 web/桌面继续。
- 需要交互式体验时走 `dsh web`（浏览器）或桌面应用；程序化驱动选 `sdk` profile（TS/Python SDK）或 `acp` profile（编辑器集成）；要让**多个客户端、或常驻进程**共享一个 runtime 时选 `sdk-net` profile（TCP，仅 loopback）。

### UI 与内核的耦合度：对比 Codex 的 app-server 模式

- **Codex 模式**（协议分层）：内核 + 版本化 app-server（JSON-RPC stdio）作为稳定接缝，TUI/IDE 是独立代码库的客户端，UI 可替换、第三方可依协议自建。
- **dsh 现状**（同源组合）：存在功能等价的 Remote 层——`packages/api/`（session/workspace/terminal/settings controller，类型化方法调用经共享 Connection/gateway 传输）——但它是 **monorepo 编译期契约**（两端共享类型、同版发布、无版本协商），对外不是稳定协议。更深的耦合在于：host 不只响应 API，还**组装并投递 UI 本身**（模块表 node 半侧合成、`collectIndexInjections` 注入、HMR 通道、resources 活值），client 是同一棵 Cordis 树上的插件——两端是一个分布式程序，而非两台经协议对话的独立程序。
- **结论**：UI 事实上不可替换；第三方 UI 只能退到 SDK/ACP 契约（stdio，或 `sdk-net` 的 TCP；面较窄，无 UI 投影）。**契约面已不再是瓶颈**——`sdk-net` 已把能力面放上网络、stdout 保持干净；仍缺位的是 IM 网关、移动端/远程客户端这些**消费方**本身以及认证。若要支持外部 UI，演进路径是把 `packages/api` + Connection 协议冻结为版本化契约（app-server 化）。

#### app-server 化的可行性评估

- **有"形"**：`packages/typert/` 已把 Remote 方法面生成为稳定元数据（全局稳定 id、wire namespace、参数 codec、Zod schema），`api/gateway` dispatch 跑在其上——形态与 gRPC proto 同构，是现成 IDL；`sdk/protocol` 是唯一跨语言的 JSON-RPC 面；gateway 线上格式（JSON envelope + 错误码 + WS 流复用）健全。
- **无"约"**：Typert 描述符无版本字段；sdk 协议无版本协商（靠"客户端 spawn 同版本 runtime"绕开）；gateway 绑定 webserver WS + 本机 cookie 模型，不对外监听。
- **改造评估**：机械部分小（Typert 加版本 → 握手协商 → 独立 socket + 独立认证 → descriptor 快照 CI）；结构性成本在三处——UI 投影面（模块表/injections/HMR/resources）无法轻易契约化、多版本共存运维、认证模型重设计。
- **建议路径**：① sdk protocol 版本化 v1（面最窄收益最大，IM/远程入口立即可接）→ ② Typert 选择性冻结稳定 controller（session/workspace 优先）→ ③ UI 投影面永不承诺。渐进式获得"核心能力有稳定契约 + 富 UI 走同源快车道"的双轨。
- **现状核对（已支持 vs 需改动）**：能力面方法（initialize/session.prompt/事件通知/图片/shutdown，`packages/sdk/server`）、传输抽象（`JsonRpcLineTransport(Readable, Writable)` 不绑 stdio，`sdk/protocol/src/transport.ts:70`）、NDJSON 分帧、profile 装配均已就绪。需改动三处：① WS/TCP 监听插件——现有 `bundle/sdk-app` 把生命周期绑死在 stdin EOF（单客户端），需新 profile（如 `bundle/sdk-net`）每连接构造 LineTransport 挂现有方法，难点是并发生命周期策略，传输类零改动；② Typert registry 已有 reflection + Zod schema，缺一个 descriptor JSON 导出命令；③ 网络认证仅非回环监听才需要。结论：不是改造协议栈，是给现有协议栈加监听壳 + 导出命令。**该结论已被实现验证**：`bundle/sdk-net` 就是那个"监听壳 + 导出命令"——① ② 已落地，③ 以"只绑 loopback"替代未做的认证，`HarnessSdkJsonRpcServer` 与传输类零改动。
- **轻量替代（latest-only 契约）**：不承诺跨版本兼容，契约 = 当版发布的方法面快照。sdk 协议已是此模式（同版本 spawn = 天然 latest-only）。底层 controller（session/workspace/fs/shell/审批）方法面稳定占比大，高频变区集中在 UI 投影面（本就不进契约）。补三件小事即可对接外部接入层：sdk jsonrpc server 增加 WS/TCP transport（现仅 stdio）、内网/本机场景可延后的网络认证、Typert → descriptor JSON 快照导出命令。性价比优于渐进版本化，版本协商/兼容承诺可待外部生态成熟后再补（Codex app-server 早期即如此演化）。**契约边界**：只暴露 harness 能力面（turn 驱动/会话/工具/审批/文件/会话查询），UI 投影机制（HMR、模块表合成、injections、resources）永不上契约、仅服务自家 web UI——此边界与 sdk 协议现有覆盖面恰好重合，故"能力面 app-server"无需新造层，复用 sdk 面换 transport 即得。

## 关键设计决策

| 决策 | 动机与证据 |
|---|---|
| 启动路径唯一：CLI 与 desktop-host 都走 `runProfile()` | 桌面不是平行实现，差异全部收敛在 profile/cordis.yml 分层配置（bundle 补丁层 → profile `cordis.patch.yml` → `--patch` overlay） |
| 壳极薄、协议面极窄：主进程↔host 仅 4 类消息 | Electron 与 agent 逻辑解耦，agent 可整体升级而不动壳；`DESKTOP_HOST_PROTOCOL_VERSION` 是发布元数据兼容闸门（`release.ts` 校验），非运行时握手 |
| primary-runtime 哈希锁定：CPython/Node/pnpm/wheels 全部锁 sha256，下载先校验后落盘 | 桌面交付可复现、离线可装；消费方是 desktop-host 的 `desktopOffice` 插件，与 PTC runtime 无关 |

## 不确定点

1. desktop profile 的 bundle 列表内容（`loadProfileDirectory` 读取 projectDir 内 profile，具体 bundles 未逐项确认）。
2. CLI `dsh web` 的默认端口（desktop 固定 19387；CLI 侧默认值未确认）。
3. `packages/ptc-runtime` 与 primary-runtime 的关系：未发现直接引用，PTC 的 Python 后端是独立实验包 `dsh-experimental-ptc-runtime-python`。
4. **`sdk-net` 加 WS/HTTP 的形态**：能力面与传输是解耦的（`JsonRpcLineTransport` 用 `(Readable, Writable)` 构造），WS 侧只需一层 WS message ↔ 行流的薄适配、协议与方法面零改动。但 loopback 上开 HTTP/WS 会引入**浏览器同源面**（DNS rebinding / 页面 fetch localhost 都可达），所以应与认证同批设计——目前未设计。企业级相关考量见姊妹篇 §1.4 与 §4.1。
