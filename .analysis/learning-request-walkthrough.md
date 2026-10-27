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
① apps/cli/src/bin.ts         runCli() 解析参数
② apps/cli/src/profile-boot.ts runProfile() 装配 profile
③ @deepseek-ai/dsh-app-boot     boot() 挂载 Cordis 插件树
④ packages/util/official-bundles bundles.ts  PROFILE_TEMPLATES（profile → bundle 列表）
⑤ packages/host/webserver/src/index.ts  webServer service 起 HTTP+WS（端口：CLI 默认 / desktop 固定 19387）
⑥ 浏览器 → /api  POST session.prompt
⑦ packages/core/agent-loop/src/index.ts  AgentLoop 开一个 turn
⑧ packages/llm/*              调 LLM（provider 路由）
⑨ packages/core/tools/src/index.ts       ToolsService.selectExecutor + execute 跑工具
⑩ packages/core/agent-loop     turn 结束，产出回复
⑪ packages/session/*          会话日志 append-only 落盘
⑫ session/event 事件经 webserver/WS 回传浏览器
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

### ⑤ web 服务起来
`packages/host/webserver/src/index.ts` 是一个 Cordis service（`declare module '@deepseek-ai/cordis' { interface Context { webServer: WebServer } }`）。它用 `node:http`（或 `node:https` 带证书）起服务，**自己不处理业务、不服务静态文件**——路由由组合方（client/host 插件）通过 `webServer` service 注入。监听端口由 profile/bundle 决定：CLI 用默认值，desktop 固定 `19387`。

### ⑥ 用户输入 prompt
浏览器经 `/api` 发 `session.prompt`。Web 形态下请求进 `webServer` 注册的路由，落到对应的 session controller（在 `packages/client/*` 或 host 组合层）。具体 controller 实现随版本，不必死记路径——关键是它拿到一个 `Session`，调它的 `prompt`。

### ⑦ ⑧ ⑨ turn 执行（内核核心）
`packages/core/agent-loop/src/index.ts` 的 `AgentLoop` 类（`extends Service implements AgentFactory`）负责跑 turn：
- 一个 turn = 组装上下文（含 `packages/context`、`packages/compaction` 的压缩）→ 调 LLM（`packages/llm/*`，`registerAdapter` 做 provider 路由）→ 看模型是否回 `tool_call`。
- 若回 tool_call：`packages/core/tools/src/index.ts` 的 `ToolsService` 用 `selectExecutor(scope)` 选执行器，再 `execute(input)` 跑工具；**若当前组合没装任何 executor，`selectExecutor` 抛 `ToolExecutorUnavailableError`**（你之前在 `examples/cordis-tutorial` 跑 `greet-tool` 撞到的就是它）。
- 工具结果回灌上下文，再调一次 LLM，直到产出回复文本。

### ⑩ ⑪ 会话落盘
turn 结束后，会话状态经 `packages/session/*`（append-only 日志）持久化——这是"会话 = 常驻 agent-loop + cwd"可恢复的基础。

### ⑫ 事件回传
流式事件（token、工具调用、turn/end…）以 `session/event` 形式发出。SDK 形态下的回传链路最清晰：`packages/sdk/server/src/server.ts` 订阅 `ctx.on('session/event', (session, event) => { ... this.transport.notify('session.event', payload) })`，把事件经 transport 扇出给客户端（注意它不补历史，断线重连拿不到断连期间的事件——这正是企业级"断线续读"要补的点）。Web 形态走同源 WS，机制同类。

## SDK 形态与 Web 形态的差异（一句话）

两条线**内核完全相同**，差异只在 transport 与生命周期：`sdk` 走 stdio JSON-RPC（`packages/sdk/server`），随 stdin EOF 退出、单客户端；`web` 走 HTTP+WS、浏览器多客户端。想看"网络契约面长什么样"，读 `packages/sdk/server/src/server.ts` 和 `packages/sdk/protocol`（wire 类型）。

## 读码练习建议

1. 在终端跑 `node --import tsx ../../vendor/cordis/bin.js`（在 `examples/cordis-tutorial/` 或按 cordis-tutorial 第 7 章），亲手触发一次工具调用，对照本文 ⑦⑧⑨。
2. 用 IDE "跳转到定义"从 `runProfile` → `boot` → 某个 bundle 的 `cordis.patch.yml`，看插件怎么挂上树的。
3. 在 `AgentLoop` 的 turn 函数里打断点（或加 `console.log`），发一条消息，观察 LLM→tool→LLM 的循环。
4. 想看事件怎么回传，搜 `ctx.on('session/event'` 和 `transport.notify('session.event'`，把两端连起来。

> 本篇是导航，不是源码副本。路径/符号以当前 master 为准；对不上时 `grep` 源码。
