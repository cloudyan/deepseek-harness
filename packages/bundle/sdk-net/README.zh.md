---
description: "面向需要把 JSON-RPC harness 运行时暴露在本机 TCP 监听端口上的用户与维护者，说明 SDK 网络应用 profile。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-sdk-net`

[English](README.md) | 中文

## 概述

以 [`dsh-base`](../base/README.zh.md) 为基础的 SDK 网络应用 `dsh` profile 组合包，与 stdio 版 [`sdk-app`](../sdk-app/README.zh.md) profile 并存而非替代。它继承 base 默认禁用模块 HMR（热模块替换）的策略；其 patch 设置 coding agent（编程智能体）persona、挂载应用自有的旗标提供方（`--host`、`--port`、`--max-connections`、`--descriptor-snapshot`），并且只在该提供方接受调用后启动监听。因此，`dsh --profile sdk-net --help` 会写出 help 并退出，不会打开端口。

能力面没有重新实现：本组合包原样复用 [`HarnessSdkJsonRpcServer`](../../sdk/server/README.zh.md)，只增加带通知扇出的连接监听，因此一个运行时可以服务多个网络客户端。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

```sh
dsh --profile sdk-net                      # serve on 127.0.0.1:19391
dsh --profile sdk-net --port 0             # serve on an OS-assigned port
dsh --profile sdk-net --descriptor-snapshot ./methods.json
```

客户端使用与 stdio SDK profile 相同的按换行分隔 JSON-RPC 2.0 协议——`initialize`、`session/prompt`、会话与 subagent 通知、`shutdown`——只是经由 TCP 连接而非管道传输，因此客户端可以是本机上的任意进程，而不必是运行时的子进程。

| 旗标 | 默认值 | 行为 |
|---|---|---|
| `--host <host>` | `127.0.0.1` | 绑定主机。仅允许回环地址：在存在网络授权方案之前，其它取值都是用法错误。 |
| `--port <port>` | `19391` | 监听端口；传 `0` 由操作系统选择空闲端口。 |
| `--max-connections <count>` | `8` | 并发客户端连接数；超出的连接会收到一个无 id 的 `-32000` 错误帧并被关闭。 |
| `--descriptor-snapshot <path>` | — | 在配置树稳定后写出当前方法面快照（Typert 包模型，以及每条 schema 记录对应的一份 JSON Schema）。 |

`DSH_MAX_TOKENS_AS_SUCCESS` 保留 SDK 部署映射：未设置或 JSON `true` 把 token 达限的 subagent 完成报告为已接受，JSON `false` 则报告为错误。

**就绪与生命周期。** 运行时就绪的标志是套接字已绑定且配置树已稳定，而不是 stdin 结束——stdin 与 stdout 留给诊断输出。客户端的 `shutdown` 请求会先应答，再释放整个根运行时并以 0 退出，这就是任何客户端停止守护进程的方式。连接关闭只移除该客户端：此前请求创建的会话会存续到运行时退出，因此重连的客户端可用 `sessionId` 继续。

**一个运行时，一个身份。** 监听端是单租户的：所有连接共享同一个 `HarnessSdkJsonRpcServer`，因此首次成功的 `initialize` 会为所有会话固定提供方、模型与工作目录。此后携带不同参数的 `initialize` 会得到 JSON-RPC 错误，而不是静默重配其它客户端已持有的会话；对重连客户端而言，参数等价的重新初始化是幂等的。需要两个身份的部署请运行两个运行时。

<a id="model-experience"></a>
## 模型体验

### SDK coding agent persona

#### 模型看到什么

profile 在第一方指导之前提供 `You are a coding agent powered by the {{model}} model.`，并在独立的 persona 后缀中提供 `Your working directory is {{cwd}}.`。SDK 初始化路由与会话 cwd 会解析其中的占位符。默认文件工具 schema 包含 `read`、`write` 和 `edit`，不包含 `str_replace_editor`。

#### Token 影响

与 stdio SDK profile 相同：一段简短稳定的 persona，加上随数据变化的 base 提示词段落与所选工具 schema。传输方式不进入提示词。

#### KV Cache 影响

对固定 profile、提供方、模型与工具清单保持稳定。由于随附 SDK profile 使用仅启动时 patch，profile 变化会在下一个进程生效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有网络授权**：监听端提供 harness 的文件与 shell 工具，因此可达的端口对所有能打开它的人等同于远程代码执行。目前只接受回环绑定；要把服务开在非回环地址上，需要一套尚不存在的认证设计。
- **没有逐连接身份**：共享同一个能力面意味着每个进程只有一个提供方／模型／cwd。多租户服务（逐连接初始化、逐租户授权）已延期；请改为每个身份运行一个运行时。
- **任何客户端都能停止运行时**：`shutdown` 保留 stdio profile 的终结语义，因此一个客户端的请求会为所有客户端结束该进程。授权设计将需要决定谁有权发起它。
- **连接既未认证也未加密**：TLS 与客户端凭据尚未实现；该传输假定客户端与本机同机。
- **配置变化需要重启**：本组合包在 YAML 中禁用 HMR，因此活动连接不会观察到 server 或 agent 依赖被替换。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。该 bundle 增加网络传输与连接名册；旗标门控、监听生命周期、扇出、连接上限与单身份守卫由源码测试负责。
