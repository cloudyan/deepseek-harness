# 心智模型：DeepSeek Harness 在你脑子里该是什么样

> 自建补文（官方 docs 没有"一页纸总览"，只有分主题的 architecture 与概念文档）。读源码前先建立这 4 层骨架，后面每一步都有地方"挂"。

## 一句话定位

DeepSeek Harness（命令行里叫 `dsh`）是一个 **All-plugin 的 Cordis agent 运行时**：几乎所有能力——工具、LLM 适配器、文件访问、agent 循环本身——都是挂在一棵共享 `Context` 树上的 Cordis 插件。四个应用外壳（cli / web / desktop / desktop-host）不实现业务逻辑，只负责**装配与交付**这同一棵内核树。

```
四个外壳 ──装配──> 同一棵 Cordis 内核树 ──驱动──> 模型 + 工具 + 生态
 (cli/web/desktop/desktop-host)      (packages/*)        (llm/mcp/skill/shell…)
```

## 图层 1：Cordis 内核（packages/* 的分组）

内核不是一层，是一棵按职责分组的插件树。记住这几组"家族"，读代码时先判断一个包属于哪族：

| 家族 | 干什么 | 代表包 |
|---|---|---|
| 会话与编排 | agent 循环、会话、子代理、目标/计划/待办 | `core/agent-loop`、`core`、`subagent`、`goal`、`plan`、`todo`、`session` |
| 工具与执行 | 工具注册/执行、shell、fs、lsp、computer-use | `core/tools`、`shell/*`、`fs/*`、`lsp` |
| 生态与集成 | mcp、skill、hooks、web 搜索、browser | `mcp/*`、`skill`、`hooks`、`web`、`browser-use` |
| 模型 | LLM 适配器、provider 路由 | `llm` |
| 存储与会话数据 | 持久化、附件、spill、storage | `session/*`、`attachment`、`storage`、`spill` |
| 上下文工程 | 压缩、请求上下文、上下文预算 | `compaction`、`context` |
| 装配与启动 | profile/bundle、boot、官方 bundle、sdk | `boot`、`bundle`、`util/official-bundles`、`sdk` |
| 交付外壳 | host(服务端)、client(GUI)、api(gateway) | `host/*`、`client/*`、`api` |
| 横切 | 沙箱、凭据、设置、身份、遥测、调度 | `sandbox`、`credentials`、`settings`、`identity`、`telemetry`、`schedule` |

**关键认知**：能力是**装配**出来的，不是写死的。撤掉一组 `dsh-tool-*` 插件，就得到一个纯对话装配——内核零改动。这是理解整个仓库的钥匙（详见 architecture.md 的 capability seams）。

## 图层 2：profile + bundle 装配（启动时才成形）

内核树长什么样，由 **profile** 决定。profile 指向一个或多个 **bundle**（一组预置插件的 cordis.yml 补丁），再叠加项目/用户的 `cordis.patch.yml` 与 `--patch` overlay。

```
runProfile('web')
  └─ 读 profile → 装载 bundle（packages/bundle/web-app 等）
       └─ bundle 的 cordis.patch.yml 声明要挂哪些插件
            └─ 叠加官方 bundle（packages/util/official-bundles，含 PROFILE_TEMPLATES）
                 └─ 叠加用户/project 的 cordis.patch.yml
                      └─ 一棵具体的 Cordis 树成形
```

- `packages/boot`（包 `@deepseek-ai/dsh-app-boot`）负责应用启动编排（实际 `boot()` 所在）；
- `packages/util/official-bundles` 持有官方 `PROFILE_TEMPLATES`（把 `web`/`desktop`/`headless`/`sdk` 等映射成具体 bundle 集合）；
- `packages/bundle/*` 是各 profile 的 bundle 定义。
- **没有"一个 app-server 二进制"**：按消费方分层多个服务面（UI / SDK-stdio / ACP / headless），由 profile 决定装哪个，内核始终是同一棵树。

## 图层 3：四应用外壳（交付层，业务逻辑为零）

| 外壳 | 角色 | 入口 |
|---|---|---|
| `apps/cli` | 统一启动器 `dsh`，解析参数后调 `runProfile()` | `apps/cli/src/bin.ts` |
| `apps/web` | 唯一前端 UI 的构建产物（被 host 服务） | 由 `packages/host/webserver` 托管 |
| `apps/desktop` | Electron 安全壳，主进程 + 沙箱 renderer | `apps/desktop/src/main.ts` |
| `apps/desktop-host` | 同一棵树以 headless 跑在 Electron 子进程（Node） | `apps/desktop-host/src/index.ts` |

桌面会话拓扑（记住这个图，后面调桌面 bug 有用）：

```
Electron main (apps/desktop/src/main.ts)
  |- renderer (沙箱) -- dsh-app://app = apps/web 产物
  |    '- /api -- auth cookie --> 127.0.0.1:<port>
  '- desktop-host 子进程 (apps/desktop-host/src/index.ts, ELECTRON_RUN_AS_NODE)
       '- runProfile('desktop'): webserver:<port> + agent + 插件
```

> 端口注记：desktop 子进程的 webserver 端口由 desktop-host 固定传 `--port 19387`（`apps/desktop-host/src/index.ts` 的应用参数），桌面端口因此是 19387；CLI `dsh web` 默认 3080（来自 `packages/bundle/web-app/cordis.patch.yml`）。二者都是启动方注入，webserver 包自身没有硬编码端口常量。

## 图层 4：一次会话的生命周期（turn 的循环）

你脑子里要有一条"会话 = 常驻 agent-loop + cwd + DSH_HOME"的线。一个 turn（一次用户输入→回复）的内部：

```
用户输入
  → webserver/SDK 收到 session.prompt
  → agent-loop 开一个 turn
       → 组装上下文（context 包，含 compaction 压缩）
       → 调 LLM（llm 包，provider 路由）
       → 模型回 tool_call?
            → 是：tools 包选 executor → 执行工具 → 结果回灌上下文 → 再调 LLM
            → 否：产出回复文本
       → 流式事件经 session-event 通知回客户端（WS / stdio）
  → 会话日志 append-only 落盘（session-persistence-*）
```

**单部署多用户结构性不成立**：因为"会话 = 常驻 agent-loop + 能跑 shell 的 cwd"，等价于给用户任意代码执行。所以隔离边界只能切在容器/UID 级，不能切在内核里（这是架构约束，不是工程难度）。理解这一点，企业级部署话题就通了。

## 把四层叠起来的总图

```
┌─────────────────────────────────────────────────────────────┐
│ 交付外壳: cli / web / desktop / desktop-host  (零业务逻辑)      │
├─────────────────────────────────────────────────────────────┤
│ 装配层:  profile → bundle → cordis.patch.yml → overlay        │
│         (boot / official-bundles / bundle/*)                  │
├─────────────────────────────────────────────────────────────┤
│ Cordis 内核树:  packages/* 按家族分组 (会话/工具/生态/模型/…)   │
│   每一能力 = 一个插件, 经 ctx.effect()/ctx.on() 注册, 可卸载    │
├─────────────────────────────────────────────────────────────┤
│ 运行时基础层: primary-runtime(仅 desktop 自带, sha256 锁定)     │
│             Node / CPython / pnpm / wheels                    │
└─────────────────────────────────────────────────────────────┘
        ↑ 请求: prompt → turn → LLM → tool → event → 持久化
```

读完这篇，再去读 [learning-code-navigation.md](learning-code-navigation.md) 知道"每层去哪个文件看"，然后 [learning-request-walkthrough.md](learning-request-walkthrough.md) 把上面这棵树钉死在真实代码行号上。
