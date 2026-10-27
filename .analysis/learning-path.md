# DeepSeek Harness 源码学习路径：从 0 到精通

> 单语学习笔记（不担任 docs/ 的双语配对契约）。本文件是**主线索引**：给出循序渐进的阅读顺序，官方文档已覆盖的章节直接链到 `docs/`，官方**没有**的章节链到本目录下的自建补文（`learning-*.md`）。
>
> 为什么需要这份路线图：官方 `docs/` 是一套**孤岛式参考**（architecture 全景、cordis-primer 概念、subsystems 134 篇、cookbook how-to、user-guide），内容极全但**没有一条"先读什么、再读什么、跟着哪段代码走"的主线**。本文补的就是这条主线，并把官方文档串成一张有序地图。

## 0. 先建立心智模型（必读，官方没有）

别一上来读代码。先读这两篇自建补文，在脑子里搭好骨架：

- [learning-mental-model.md](learning-mental-model.md) — 一页纸心智模型：Cordis 内核 / profile-bundle 装配 / 四应用外壳 / 会话-turn 生命周期，以及你脑子里该有什么图。
- [learning-code-navigation.md](learning-code-navigation.md) — 仓库目录导航：每一层该从哪个文件入口看，去哪找"启动""装配""内核""工具""持久化"。

## 1. 概念地基（官方已有，按顺序读）

1. **Cordis 是什么** → [docs/cordis-primer.md](../docs/cordis-primer.md)（五要点、dispatch 模式、waterfall 语义、loader 配置、实践规则）。这是全仓的基石，不懂 Cordis 后面全看不懂。
2. **术语表** → [docs/glossary.md](../docs/glossary.md)（profile / bundle / ctx / effect / 等术语的准确定义，随时回查）。
3. **架构全景** → [docs/architecture.md](../docs/architecture.md)（Cordis、profiles & bundles、application launch、desktop、core packages、events、turn flow、session log、capability seams）。读一遍建立"仓库由哪些大块组成"的印象即可，细节后面会反复回来。

## 2. 跟着官方动手（官方已有，边读边跑）

4. **Cordis 实战 7 章** → [docs/cordis-tutorial/index.md](../docs/cordis-tutorial/index.md)。从 `examples/cordis-tutorial/`（旧文档写 `tmp/cordis-tutorial`，以仓库实际位置为准）逐步建插件，亲手体会 plugin / lifecycle / service / event / config / composition+HMR / 接入 harness 工具。**这一环不可替代**，读十篇概念不如写一个能跑的插件。
5. **用户向开发文档** → 按需读 [docs/user/develop/](../docs/user/develop/)：
   - 基础：`basic/`（config、tool、publish）
   - 框架：`framework/`（events、service、dynamic-cordis）
   - 实践：`practice/`（dynamic-cordis、llm-adapter）

## 3. 读码：一次真实请求怎么走（必读，官方没有）

6. **端到端调用链追踪** → [learning-request-walkthrough.md](learning-request-walkthrough.md)。自建补文：从 `dsh` 进程启动 → profile 装配 → webserver 起服务 → 用户输入 prompt → agent-loop 跑 turn → 调 LLM → 跑工具 → 事件回传 → 会话落盘。把第 1、2 步的概念**钉死在真实代码行号上**。

## 4. 子系统深挖（官方已有，当字典查）

7. **子系统参考** → [docs/subsystems/README.md](../docs/subsystems/README.md)（134 篇，每个子系统一篇：agent-loop、tools、llm、mcp、sandbox、session、compaction、subagent……）。不要通读，当成字典：用到哪个包回来查哪篇。
8. **能力面契约** → 按需：[docs/capability-seams.md](../docs/capability-seams.md)（seam = 服务定义/提供/消费三角色）、[docs/tool-execution-pipeline.md](../docs/tool-execution-pipeline.md)（工具执行管线）、[docs/cordis-api/](../docs/cordis-api/)（Cordis 核心 API：context / events / fiber / registry / service）。
9. **目录与依赖图** → [docs/module-graph.md](../docs/module-graph.md)、[docs/graph-atlas.md](../docs/graph-atlas.md)。看包之间怎么依赖、谁依赖谁。

## 5. 学会改代码（官方已有，按场景查）

10. **Cookbook** → [docs/cookbook/](../docs/cookbook/)：加一个包、加一个工具、加一个 LLM adapter、加一个 vendored 包、加一个 session 格式版本……都是单点 how-to，改代码前先查对应那篇。
11. **开发规范** → [docs/development.md](../docs/development.md)（贡献者 setup、CI 摘要）、[docs/defensive-patterns/](../docs/defensive-patterns/)（评审强制规则）、[docs/testing.md](../docs/testing.md)（测试策略与快照门禁）。

## 6. 进阶主题（按需）

- **客户端 UI**：`packages/client/*` 是 Electron/Web 的 GUI 插件层，官方文档较少覆盖其内部结构；读码时参考 [learning-code-navigation.md](learning-code-navigation.md) 的导航，结合 `packages/client/ui-*` 实际目录。
- **部署形态**：企业级多租户/隔离边界等主题，本仓库曾有一份分析笔记（enterprise-architecture.md）已移除；相关结论以 [docs/architecture.md](../docs/architecture.md) 和 [docs/user/guide/public-deployments.md](../docs/user/guide/public-deployments.md) 为准。
- **升级与兼容**：[docs/upgrade-guide/](../docs/upgrade-guide/)、[docs/session-format-status.md](../docs/session-format-status.md)。

---

## 能力进阶地图（从"会用一个命令"到"能改一个包"）

| 阶段 | 你能做什么 | 该读/做 |
|---|---|---|
| L0 使用者 | 装好 dsh，跑 `dsh web`、写 cordis.yml | §1 概念地基 + §2 实战 7 章 |
| L1 写插件 | 写一个自己的 Cordis 插件，注册一个工具 | cordis-tutorial + user/develop/basic/tool |
| L2 读源码 | 能跟着一次请求走完整调用链，定位任意功能在哪个包 | §0 心智模型 + §3 调用链追踪 + subsystems 字典 |
| L3 改内核 | 给某个子系统加能力（如新工具、新 service、新 adapter） | cookbook 对应篇 + defensive-patterns + testing |
| L4 改装配 | 改/加 profile 或 bundle，改变应用启动形态 | architecture.md(profiles & bundles) + official-bundles 源码 |
| L5 体系化 | 理解多应用外壳、客户端 UI、部署边界，能做架构级改动 | 全仓库 cross-reference + 评审规则 |

---

> 本路线图与自建补文（learning-*.md）是学习辅助，**不替代官方文档**。任何与官方文档冲突处，以 `docs/` 为准。
