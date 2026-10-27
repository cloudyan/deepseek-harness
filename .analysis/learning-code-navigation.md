# 代码导航：读这个仓库时去哪找什么

> 自建补文（官方 docs 有 module-graph / graph-atlas 讲依赖关系，但没讲"我想看 X 功能该打开哪个文件"）。本文是**入口索引**：按"我想搞懂什么"分类，给出该从哪个文件/目录切入。

## 顶层目录速记

| 目录 | 是什么 |
|---|---|
| `apps/` | 四个交付外壳：cli（dsh 启动器）、web（前端产物）、desktop（Electron 壳）、desktop-host（Electron 内 headless 子进程） |
| `packages/` | 内核与生态，按 `packages/<group>/<pkg>/` 组织，包名 `@deepseek-ai/dsh-<pkg>` |
| `vendor/` | vendored Cordis 源码（pinned，勿手改，走 sync 流程） |
| `python/` | Python SDK / 运行时 |
| `native/` | Node addon 源码 |
| `docs/` | 官方文档（architecture、cordis-primer、subsystems、cookbook、user-guide…） |
| `website/` | VitePress 文档站投影 |
| `scripts/` | 门禁与生成器（gates、generators） |
| `snapshots/` | 录制的会话快照预期输出 |
| `examples/` `tmp/` | 示例 / 草稿目录 |

## 按"我想搞懂"查入口

### 启动与装配

| 想搞懂 | 去哪看 |
|---|---|
| `dsh` 命令怎么开始、怎么解析参数 | `apps/cli/src/bin.ts` → 调用 `runProfile()` |
| `runProfile()` 定义、装配主流程 | `packages/boot/app-boot/src/`（应用启动编排） |
| profile 名 → 具体 bundle 集合的映射 | `packages/util/official-bundles/src/bundles.ts`（`PROFILE_TEMPLATES`） |
| 各 profile 的 bundle 定义（挂哪些插件） | `packages/bundle/*`（如 `bundle/web-app`、`bundle/sdk-app`、`bundle/sdk-minimal`） |
| cordis.yml / cordis.patch.yml 的加载与 overlay | `packages/boot/*` 的 loader 逻辑；Cordis 侧见 vendor/cordis |

### 内核核心

| 想搞懂 | 去哪看 |
|---|---|
| agent 循环（一个 turn 怎么跑） | `packages/core/agent-loop/src/` |
| 会话模型与持久化 | `packages/session/*`、`packages/session-query/*`、`session-persistence-*`（append-only 日志） |
| 工具注册与执行 | `packages/core/tools/src/`（执行入口、executor 选择） |
| 事件系统（typed events / waterfall） | `packages/core/`（事件 map）+ `docs/cordis-api/events.md` |
| 上下文组装与压缩 | `packages/context/*`、`packages/compaction/*` |
| LLM 调用与 provider 路由 | `packages/llm/*`（`registerAdapter` 自定义路由） |
| 子代理委派 | `packages/subagent/*` |
| 能力面 / seam | `docs/capability-seams.md` + `packages/*` 各自的 service 定义 |

### 交付与接口

| 想搞懂 | 去哪看 |
|---|---|
| web/桌面 HTTP+WS 服务怎么起 | `packages/host/webserver/src/index.ts`（监听端口：CLI 默认、desktop 固定 19387） |
| SDK JSON-RPC 服务端（stdio） | `packages/sdk/server/src/` |
| gateway / controller（类型化方法面） | `packages/api/src/` |
| 客户端 GUI（Electron/Web 插件） | `packages/client/*`（大量 `ui-*` 插件） |
| 桌面主进程 / host 子进程 | `apps/desktop/src/main.ts`、`apps/desktop-host/src/index.ts` |

### 生态集成

| 想搞懂 | 去哪看 |
|---|---|
| MCP（外部工具） | `packages/mcp/*`（mcp-client、mcp-resources） |
| skill 加载 | `packages/skill/*` |
| hooks | `packages/hooks/*` |
| 沙箱 / 安全 | `packages/sandbox/*`（sandbox、sandbox-policy、sandbox-local、sandbox-windows-acl） |
| 凭据 / 授权 | `packages/credentials/*`（credentials、authorization） |
| 设置 | `packages/settings/*` |

### 规范与质量门禁

| 想搞懂 | 去哪看 |
|---|---|
| 贡献者 setup、CI 摘要 | `docs/development.md` |
| 评审强制规则 | `docs/defensive-patterns/` |
| 测试策略 / 快照门禁 | `docs/testing.md` |
| 文档标准 | `docs/AGENTS.md`、`docs/architecture.md` 的文档分层 |
| 升级与兼容 | `docs/upgrade-guide/`、`docs/session-format-status.md` |

## 一个有效的读码策略

1. **先定位包，再读 README**：每个 `packages/*/<pkg>/` 大多有 `README.md`，写的是该包的契约（config / 语义 / 扩展点）。先读它，比直接读源码快。
2. **从 `src/index.ts` 进**：包的主入口通常在这里，顺着导出往下追。
3. **跟着一次请求走**：不要试图通读。挑一条线（如"用户输入 → 回复"）用 IDE 的"跳转到定义"一路跟，配合 [learning-request-walkthrough.md](learning-request-walkthrough.md)。
4. **子系统字典**：遇到不认识的包，回 [docs/subsystems/README.md](../docs/subsystems/README.md) 查对应篇。

## Cordis 本身在哪

Cordis 是 vendored 的，不在 `packages/`：`vendor/cordis/`。它是 fork/pinned 的源码，改动要走 sync 流程（见 `vendor/README.md`），不要直接手改。读 Cordis 内核机制（Context、Service、events、waterfall、loader）时去这里，但理解"harness 怎么用 Cordis"靠 `docs/cordis-primer.md` 与上面的 subsystems。
