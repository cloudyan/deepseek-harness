# apps/ 四应用架构设计：cli · desktop · desktop-host · web

> 基于 dev_202609 分支当时的源码分析（引用提交请用 tag 或 PR 链接，勿写裸 commit 哈希）。所有结论均标注源码位置，可直接核对。

## 1. 一句话总览

**一套 Cordis agent 内核，四种"外壳"复用**：`apps/cli` 是统一启动器，`apps/web` 是唯一的前端 UI，`apps/desktop` 是 Electron 安全壳，`apps/desktop-host` 是把同一套 agent 树 headless 地跑在 Electron 里的 Node 子进程。四个应用没有一个独立实现业务逻辑——它们全是围绕 `packages/` 内核的"装配与交付层"。

```
                    ┌──────────────────────────────────────────┐
                    │        共用内核（packages/）              │
                    │  app-boot(profile 装配) · host-webserver  │
                    │  agent · tools · skills · session ...    │
                    └───────────▲──────────────▲───────────────┘
                                │              │
              runProfile() ┌────┴──────────────┴─── 同一条启动路径
                           │
     ┌─────────────┐  spawn(Node模式)  ┌───────────────┐
     │  apps/cli   │──────────────────►│ 任意 profile   │
     │  (dsh bin)  │  直接进程内运行     │ headless/CLI   │
     └──────┬──────┘                   └───────────────┘
            │ serve dist + /api
            ▼
      浏览器 ◄──── apps/web dist
            ▲
            │ dsh-app://app 静态 + /api 认证转发
     ┌──────┴─────────┐  Electron IPC   ┌──────────────────────┐
     │  apps/desktop  │────────────────►│  apps/desktop-host    │
     │  (Electron 壳) │                 │  runProfile('desktop')│
     └────────────────┘                 │  :19387 webserver     │
                                        └───────────────────────┘
```

## 2. 各应用职责

### 2.1 apps/cli —— `@deepseek-ai/dsh`（启动器）

- 入口：`bin.dsh → lib/bin.js`（源码 `apps/cli/src/bin.ts`），CLI 自身**不实现任何 agent 逻辑**。
- 只解析启动器自有 flags，其余参数原样透传（`src/args.ts:6-11`）：
  - `dsh [--profile] <name> [app-args...]`：第一个裸 token 展开为 profile 名（`args.ts:186-188`），所以 **`dsh web` ≡ `dsh --profile web`**；`--patch <yml>` 叠加配置 overlay；`--dump-config` 导出。
  - `dsh plugin --profile <name> <pnpm-args...>`：在 profile 目录内转发 pnpm 增删插件包（`args.ts:171-183`）。
- profile 名 `desktop` 被显式拒绝（`args.ts:73-77`）——桌面形态由 Electron 独占，保证打包/更新链路的完整性。
- 启动链：`bin.ts → src/profile-boot.ts runProfile() → @deepseek-ai/dsh-app-boot boot()` 组装 Cordis 插件树。

### 2.2 apps/web —— `@deepseek-ai/dsh-web-frontend`（唯一 UI）

- Vite 应用，构建产物 `dist/`；UI 内核是 `packages/client/web`（静态模块表 + Cordis loader），组件在 `packages/client/ui-*`。
- **自己不提供服务**，dist 被两个宿主复用（见 §3）。
- ⚠️ 命名陷阱：`packages/web/web`（`@deepseek-ai/dsh-web`）是网页搜索/抓取能力包，与此 UI 无关。

### 2.3 apps/desktop —— `@deepseek-ai/dsh-desktop`（Electron 安全壳）

- 主进程 `src/main.ts`，职责严格限定为"壳"：
  1. 注册特权自定义协议 `dsh-app://app`（`ipc.ts` 定义，`main.ts:70-80`），renderer 加载 `dsh-app://app/`，静态资源即 apps/web dist（`main.ts:403` → `web-document.ts serveWebDocument`），并注入 `__DSH_BOOT_READY__`；
  2. `/api` 等动态请求经 `authenticateWebHost()`（cookie 认证）后由 `forwardWebRequest()` 转发到 host 的 `127.0.0.1:19387`（`web-document.ts`）；
  3. sandbox + contextIsolation 开启（`main.ts:134-140`），preload 只暴露白名单桥（`preload-*.ts` 一族）；
  4. spawn 与监管 desktop-host 子进程（`src/host-process.ts`）；
  5. 打包/更新面：`scripts/prepare-dsh.ts`（物化生产运行时）、`prepare-primary-runtime.ts`（锁定 CPython/Node/pnpm/wheels）、release 元数据（`src/release.ts`，写入 `hostProtocolVersion`）、自动更新（`mandatory-update-*`、`installed-update-*` 一族）。

### 2.4 apps/desktop-host —— `@deepseek-ai/dsh-desktop-host`（headless 宿主）

- 单文件核心 `src/index.ts`：读 argv → `loadProfileDirectory('dsh', projectDir, ...)` → **调用与 CLI 完全相同的 `runProfile()`**（`index.ts:5`，from `@deepseek-ai/dsh/profile-boot`），profile 固定 `'desktop'`，应用参数 `['--no-open', '--port', '19387']`（`index.ts:24`）。
- 即：webserver + agent + 插件都活在这个 **Node 模式子进程**里（Electron 可执行 + `ELECTRON_RUN_AS_NODE`，`host-process.ts:115-128`），stdio 仅透传，控制面走 Electron IPC（第 4 个 fd）。
- 额外承担两件事：
  - `update-tasks` 控制面（`src/update-tasks.ts`）：自动更新前检查/锁定活跃任务，响应主进程 `update-tasks{inspect|lock|unlock}`；
  - `desktopOffice` 插件（`src/office.ts` + `workspace-dependencies.ts`）：把 primary-runtime 中的 python/pnpm 安装到 `$DSH_HOME/dsh-runtimes/`，挂载 Office 技能（`dsh-skill-office`）。

## 3. 两种会话形态

### Web 会话（CLI 直连）

```
dsh web
  └─ CLI 进程 = Cordis 树（web-app bundle）
       ├─ host-webserver :port（可 --host/--port/--no-open）
       │    └─ 静态：@deepseek-ai/dsh-web-frontend/dist + SPA 兜底
       └─ agent/工具/技能插件
浏览器 ──HTTP/WS──► 同一进程
```

### 桌面会话（Electron 三层）

```
Electron 主进程（apps/desktop main.ts）
 ├─ renderer（sandbox）── dsh-app://app/ = apps/web dist（本地静态）
 │     └─ /api、WS ──认证 cookie──► forwardWebRequest ──► 127.0.0.1:19387
 └─ desktop-host 子进程（Electron 可执行 + ELECTRON_RUN_AS_NODE，IPC fd）
      └─ runProfile('desktop')：webserver:19387 + agent + 插件
           └─ 插件子进程（pnpm/node 均经 Electron Node 模式执行）
```

**同一份 dist、同一套 `/api` 协议、同一条 `runProfile()` 启动路径**——桌面只是给浏览器换成了受控的 renderer，并多了一层 IPC 控制面。

## 4. 值得注意的设计决策

| 决策 | 动机与证据 |
|---|---|
| **CLI 即服务器**：`dsh web` 的 CLI 进程本身就是 web server | 省去独立 daemon；profile 隔离天然按进程划分（`packages/bundle/web-app/src/index.ts`） |
| **UI 单一来源**：apps/web dist 被两种宿主复用 | 保证 web 与桌面功能/样式完全一致；桌面仅增加认证与协议处理 |
| **启动路径唯一**：CLI 与 desktop-host 都走 `runProfile()` | desktop 不是一个平行实现，行为差异全部收敛在 profile/bundle 配置层（cordis.yml 分层：bundle 补丁层 → profile `cordis.patch.yml` → `--patch` overlay） |
| **壳极薄、协议面极窄**：主进程↔host 仅 4 类消息（`ready{url,injections}`/`fatal`/`shutdown-complete`/`update-tasks`，下行 `shutdown`/`update-tasks{inspect\|lock\|unlock}`，`host-process.ts:18-23`） | Electron 与 agent 逻辑解耦：agent 可以整体升级而不动壳；`host-protocol.ts` 的 `DESKTOP_HOST_PROTOCOL_VERSION=4` 不是运行时握手，而是**构建期/发布元数据兼容闸门**（`release.ts` 校验、`runtime-tree.ts` versions.json 记录） |
| **安全边界清晰**：renderer sandbox + 自定义协议 + cookie 认证转发；Node 能力全部在子进程 | renderer 被攻破也拿不到文件系统/Shell；host 端口仅绑 127.0.0.1 且需认证 cookie |
| **primary-runtime 哈希锁定**：`primary-runtime-lock.json` 锁 CPython/Node/pnpm/wheels 的 sha256，下载先校验后落盘（`prepare-primary-runtime.ts downloadPrimaryRuntimeAsset`） | 桌面交付可复现、离线可装；消费方是 desktop-host 的 `desktopOffice`（安装到 `$DSH_HOME/dsh-runtimes/`，供 Office 技能与工作区依赖使用），非 PTC runtime |
| **profile 传递即配置**：`$DSH_HOME/profiles/<name>` 是目录而非文件 | bundle 列表、用户补丁、overlay 都可版本化/ review；`dsh plugin` 在 profile 内做包管理 |

## 5. 对外服务面与协议矩阵（对照 Codex 的 app-server 问题）

dsh 没有单一的 "app-server" 二进制，而是**按消费方分层的多个服务面**，由 profile 机制决定装配哪一个；agent 内核始终是同一棵 Cordis 树，外层只是协议适配器。

| 服务面 | 承载包 / profile | 协议 | 消费方 | Codex 类比 |
|---|---|---|---|---|
| UI 服务 | `@deepseek-ai/dsh-host-webserver`（`web` profile / desktop profile） | HTTP + WebSocket（node:http，路由注册 + WS 升级；webserver 自身不懂业务、不管静态文件，由组合方注入） | 浏览器 / Electron renderer（`/api`） | 无直接对应（Codex UI 非 web） |
| SDK 服务 | `dsh --profile sdk`：`@deepseek-ai/dsh-sdk-jsonrpc-server` | newline-delimited **JSON-RPC over stdio**；客户端把同版本 dsh runtime 作为子进程 spawn | TS SDK（`dsh-sdk-client`，`packages/sdk/client`）、Python SDK（`python/sdk`，`deepseek-harness-sdk`） | **≈ Codex `app-server`**（IDE 集成） |
| 自动化服务 | `@deepseek-ai/dsh-acp`（`acp` profile，标注 automation-only） | **JSON-RPC over stdio**（Agent Client Protocol） | 编辑器/自动化客户端（Zed 一类） | ≈ Codex IDE 集成面 |
| 一次性命令 | `@deepseek-ai/dsh-headless`（`headless` profile） | 无服务：`dsh --profile headless "task"` 跑完打印答案退出；`--json` 输出 NDJSON 事件流，`--session-id` 续会话；退出码 0/1 | 脚本、CI | ≈ `claude -p`（print 模式） |

关键事实（源码依据）：
- wire protocol 收敛在 `packages/sdk/protocol`（命名请求/结果/通知类型，TS 与 Python 共享同一份）。
- `host-webserver` 刻意"无知"：*"It knows no harness concepts and serves no files"*（`packages/host/webserver/src/index.ts` 头注释）。
- Electron 主进程↔host 的 IPC（ready/fatal/shutdown-complete/update-tasks）是桌面壳生命周期控制面，**不承载 agent 业务**。
- `headless` bundle：*"opens no ports and leaves nothing running behind"*——不监听端口、无残留进程；模型、工具、安全默认值与其他面完全一致。

## 6. 命令行交互形态：有无 "Claude Code 式" 入口？

- **交互式终端 REPL/TUI：没有。** `apps/cli` 的定位是启动器（profile 装配 + plugin 管理 + 配置导出），未发现 readline/ink 等 TUI 依赖；`packages/terminal` 是 agent 侧的持久终端工具，不是 UI。
- **最接近的形态是 one-shot**：`dsh --profile headless "task"`（等价 `claude -p`）——单任务、无 GUI/无端口、可 `--json` 编程消费、可 `--session-id` 恢复对话继续追问（见 §5 表格）。源码运行：`pnpm dsh --profile headless "task"`。
- **需要交互式体验时**，官方路径是 `dsh web`（浏览器）或桌面应用——两者与 headless 共用同一 agent 内核与会话存储（session 可跨面接续）。
- 程序化驱动选 `sdk` profile（自家 TS/Python SDK）或 `acp` profile（编辑器集成）。

## 7. 速查：谁依赖谁

| 应用 | 运行时依赖的内核包（节选） | 被谁消费 |
|---|---|---|
| apps/cli | dsh-app-boot、host-webserver、web-app bundle、agent-presets | 终端用户 `dsh`；desktop 打包（prepare-dsh 物化 dsh 包集） |
| apps/web | packages/client/web、ui-* | apps/cli 的 `dsh web`；apps/desktop 的 `dsh-app://app` |
| apps/desktop | Electron；构建期调用 scripts/* | 终端用户桌面应用；打包产物内嵌 cli 包集 + web dist + desktop-host |
| apps/desktop-host | @deepseek-ai/dsh/profile-boot、dsh-client-connection、host-webserver、jobs/tools/skill-office | 仅 apps/desktop（spawn） |

## 8. 分析中的不确定点（如需入正史文档建议进一步核实）

1. desktop profile 的 bundle 列表内容（`loadProfileDirectory` 读取 projectDir 内 profile，具体 bundles 未逐项确认）。
2. CLI `dsh web` 的默认端口（desktop 固定 19387；CLI 侧默认值未确认）。
3. `packages/ptc-runtime` 与 primary-runtime 的关系：未发现直接引用，PTC 的 Python 后端是独立实验包 `dsh-experimental-ptc-runtime-python`。
