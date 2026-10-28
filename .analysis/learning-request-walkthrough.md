# 调用链追踪：一次请求从进入到响应怎么走

> 自建补文（官方 docs 的 architecture.md 讲"turn flow"是描述性的，没把每一步钉在真实代码位置；本文补这条端到端链路，方便你读码时对照）。
> 所有路径/符号都以 master 实际代码为准。版本随时会变，若对不上，以 `grep` 当前源码为准。

## 选哪条线

两条主线共享同一棵内核树，差别只在 transport：
- **`dsh web`**（浏览器）：HTTP+WS，服务端 `packages/host/webserver`，GUI 在 `packages/client/*`。
- **`dsh --profile sdk`**（stdio JSON-RPC）：服务端 `packages/sdk/server`，TS/Python SDK 驱动。

下面以 **`dsh web`** 为主线，末尾点出 SDK 形态的差异。

## 端到端顺序清单

```
① apps/cli/src/bin.ts              runCli() 解析参数
② apps/cli/src/profile-boot.ts     runProfile() 装配 profile
③ @deepseek-ai/dsh-app-boot        boot() 挂载 Cordis 插件树
④ packages/util/official-bundles/bundles.ts  PROFILE_TEMPLATES（profile → bundle 列表）
⑤ packages/host/webserver/src/index.ts  webServer service 起 HTTP+WS（CLI 默认 3080；桌面端口由 Electron launcher 运行时注入）
⑥ 浏览器 → session.prompt 远程调用（WS /api/remote.mux）
⑦ packages/api/session-controller/src/index.ts  @Remote('prompt') 落到内核
⑧ packages/core/agent-loop/src/agent.ts  followup() → wakeDriver() → turn()
⑨ packages/llm/*                    调 LLM（provider 路由）
⑩ packages/core/tools/src/*         executeToolBatch + pipeline 跑工具
⑪ packages/core/agent-loop          turn 结束，产出回复
⑫ packages/session/session-persistence-jsonl  会话日志 append-only 落盘
⑬ session/event 事件经 WS 回传浏览器
```

## 逐段说明

### ① 启动入口
`apps/cli/src/bin.ts` 的 `runCli()` 调 `parseDshArgs` 解析参数，`switch(invocation.mode)` 走到 `'profile'` 分支，动态 `import('./profile-boot.ts')` 后调 `runProfile()`。`dsh web` 等价于 `runProfile({ profile: 'web', ... })`。

### ② 装配 profile
`runProfile()`（`apps/cli/src/profile-boot.ts`）做几件关键事：
- `composeProfile()`：加载 profile 目录、算运行时解析 `createRuntimeResolution`、加载 `--patch` overlay。
- `boot(NAME, rootConfig, readProfilePatches(...), async hostCtx => { ... })`：调 `@deepseek-ai/dsh-app-boot` 的 `boot()`，在回调里 `hostCtx.plugin(PluginPackages, { resolution })` 把 bundle 里声明的所有插件**挂上 Cordis 树**。
- 根配置 `PROFILE_ROOT_CONFIG` 是空入口列表 `[]`，整棵树由 patch 层（bundle 的 cordis.patch.yml → profile 自己的 → `$DSH_HOME/cordis.patch.yml` → `--patch`）叠加而成。

### ③ ④ profile → bundle 映射
`PROFILE_TEMPLATES`（`packages/util/official-bundles/src/bundles.ts`）把 `'web'` / `'desktop'` / `'headless'` / `'sdk'` 等名字映射到具体 bundle 集合。`initializeProfileFromDefault()` 把模板的 bundle 列表写进 profile 目录。`prepareProfile()` → `loadProfile()` 读取并 `reportSkippedBundles()`。

> 读码时记住：**能力面 = bundle 声明挂哪些插件**。改"装什么"改这里，不是改内核。

> **平台感知（master 新增）**：bundle 的 `package.json` 可声明 `dsh.bundle.platforms`（Node 平台名数组，如 `['darwin']`）。`packages/boot/app-boot/src/bundle-platform.ts` 的 `assertBundlePlatform(platforms, process.platform)` 在装配/选择 bundle 前校验：若 Host 平台不在声明里，抛 `UnsupportedBundlePlatformError`，该 bundle 被跳过。这就是为什么某些 bundle（例如 CUA 的 `cua-bundle`、部分 experimental）只在特定 Host（如 macOS/桌面）出现，在 CLI/Web 形态下自动隐藏且不被激活。读 `runProfile` 装配时要把这层过滤算进去。

### ⑤ web 服务起来
`packages/host/webserver/src/index.ts` 是一个 Cordis service（`declare module '@deepseek-ai/cordis' { interface Context { webServer: WebServer } }`）。它用 `node:http`（或 `node:https` 带证书）起服务，**自己不处理业务、不服务静态文件**——路由由组合方（client/host 插件）通过 `webServer` service 注入。
- **端口**：CLI `dsh web` 默认 **3080**（来自 `packages/bundle/web-app/cordis.patch.yml` 的 `port: ctx.webStartup.port ?? 3080`，由 `packages/bundle/web-app/src/startup.ts` 解析 `--port` 注入）。**desktop 由 desktop-host 固定传 `--port 19387`**（`apps/desktop-host/src/index.ts` 的应用参数），所以桌面子进程端口是 19387——这是 launcher 传参，不是 webserver 包自身的默认常量。
- **WS 升级路由**：gateway 在 `packages/api/gateway/src/index.ts` 用 `webServer.registerUpgrade()` 注册 WS，路径 `/api/remote.mux`。

### ⑥ 用户输入 prompt
浏览器经 `/api` 发 Typert Remote 调用 `session.prompt`，走 WS mux → `packages/api/gateway` 的 Remote dispatch。

### ⑦ 落到控制器（内核入口）
- **Web 形态**：`packages/api/session-controller/src/index.ts:464` 的 `@Remote('prompt') prompt()`（属于 `SessionController`，namespace `session`）只是 Remote 入口，它委托给 `packages/api/session-controller/src/commands.ts:304` 的 `SessionCommandController.prompt()` 校验后调 `agent.followup(message)`。
  - 注意：master 把 session-controller **拆成了多个子 controller**：`index.ts` 现在只做资源解析与装配，真正的实现分散在 `agent.ts`(Agent 命令)、`commands.ts`(prompt/cancel/follow)、`control.ts`、`history/controller.ts`、`state/controller.ts`、`web/controller.ts`、`list.ts`。读代码时别再找"一个大 index.ts 包含所有逻辑"。
- **SDK 形态**（更直观）：`packages/sdk/server/src/server.ts:253` `prompt()`（在 `handleRequest` 的 `case 'session/prompt'` 分支）→ `rec.handle.agent.followup(message)`。
- 两条线都汇聚到 `followup()`（`packages/core/agent-loop/src/agent.ts:172`）。

### ⑧ ⑨ turn 执行（内核核心）
`followup()` → `wakeDriver()`（`agent.ts:243`）→ `kick()` → **`turn()` 是 turn 执行入口**（`agent.ts:320`），内部 `while (await this.turn()) {}`；每个 step 是 `step()`（`agent.ts:428`）。
- 一个 turn = 组装上下文（含 `packages/context`、`packages/compaction` 的压缩）→ 调 LLM（`agent.ts:483` `loopCtx.llm.stream(request)`，provider 路由在 `packages/llm/*`，如 `llm-deepseek/src/adapter.ts` 的 `generate()`）→ 看模型是否回 `tool_call`。
- 若回 tool_call：`agent.ts:583` 调 `tools.execute({ calls: toolCalls, ... })` → `packages/core/tools/src/batch.ts:50` `executeToolBatch()` → pipeline（`packages/core/tools/src/pipeline.ts`）按工具名 `resolveExecution` 解析、`dispatchToolBody()`（`pipeline.ts:258/275`）执行具体 `tool.execute()`。
- **若当前组合没装任何 executor**，`ToolsService.selectExecutor`（`packages/core/tools/src/index.ts`）抛 `ToolExecutorUnavailableError`（你之前在 `examples/cordis-tutorial` 跑 `greet-tool` 撞到的就是它）。
- 工具结果回灌上下文，再调一次 LLM，直到产出回复文本。

### ⑩ ⑪ 会话落盘
会话日志是 **append-only** 的 JSONL 事件流：`packages/session/session-persistence`（抽象 handle/contract，`append(events)` 接口）+ `packages/session/session-persistence-jsonl`（写 `.jsonl`/`.jsonl.zstd` 实现）。`session-persistence-jsonl` 直接订阅 `session/event` 把每个事件顺序写盘（写前按 seq 连续性校验）。这是"会话 = 常驻 agent-loop + cwd"可恢复的基础。

### ⑫ 事件回传
流式事件（token、工具调用、turn/end…）以 `session/event` 形式发出。SDK 形态最清晰：`packages/sdk/server/src/server.ts:154` 订阅 `ctx.on('session/event', ...)` → `this.transport.notify('session.event', payload)` 扇出给客户端（注意它不补历史，断线重连拿不到断连期间的事件——这正是企业级"断线续读"要补的点）。Web 形态走同源 WS `/api/remote.mux`，由 gateway 的 Remote 事件流回传，机制同类。
- **新增能力（master）**：Gateway 现在暴露 `getPendingRemoteEvents(): readonly PendingRemoteEventInfo[]`（`packages/api/gateway/src/types.ts:165`）——客户端读取 session 状态时可以顺带看到"Gateway 已收到、尚未推送给你的远程事件"，用于填补轮询/重连间隙的可见性。这是 `12` 段事件链路的延伸，不影响 `session/event` 的派发机制。

## SDK 形态与 Web 形态的差异（一句话）

两条线**内核完全相同**，差异只在 transport 与生命周期：`sdk` 走 stdio JSON-RPC（`packages/sdk/server`），随 stdin EOF 退出、单客户端；`web` 走 HTTP+WS、浏览器多客户端。想看"网络契约面长什么样"，读 `packages/sdk/server/src/server.ts` 和 `packages/sdk/protocol`（wire 类型）。

## 读码练习建议

1. 在终端跑 `node --import tsx ../../vendor/cordis/bin.js`（在 `examples/cordis-tutorial/` 或按 cordis-tutorial 第 7 章），亲手触发一次工具调用，对照本文 ⑦⑧⑨。
2. 用 IDE "跳转到定义"从 `runProfile` → `boot` → 某个 bundle 的 `cordis.patch.yml`，看插件怎么挂上树的。
3. 在 `AgentLoop` 的 turn 函数里打断点（或加 `console.log`），发一条消息，观察 LLM→tool→LLM 的循环。
4. 想看事件怎么回传，搜 `ctx.on('session/event'` 和 `transport.notify('session.event'`，把两端连起来。

> 本篇是导航，不是源码副本。路径/符号以当前 master 为准；对不上时 `grep` 源码。
