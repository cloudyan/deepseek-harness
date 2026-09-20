---
description: "SDK network application profile for users and maintainers exposing a JSON-RPC harness runtime over a local TCP listener."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-sdk-net`

English | [中文](README.zh.md)

## Summary

The SDK network application as a `dsh` profile bundle over [`dsh-base`](../base/README.md), served beside — not instead of — the stdio [`sdk-app`](../sdk-app/README.md) profile. It inherits the base's disabled module-HMR policy; its patch sets the coding-agent persona, mounts an app-owned flag provider (`--host`, `--port`, `--max-connections`, `--descriptor-snapshot`), and starts the listener only after that provider accepts the invocation. `dsh --profile sdk-net --help` therefore writes help and exits without opening a port.

The capability surface is not reimplemented: the bundle reuses [`HarnessSdkJsonRpcServer`](../../sdk/server/README.md) unchanged and adds only a connection listener with a notification fan-out, so one runtime serves many network clients.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

```sh
dsh --profile sdk-net                      # serve on 127.0.0.1:19391
dsh --profile sdk-net --port 0             # serve on an OS-assigned port
dsh --profile sdk-net --descriptor-snapshot ./methods.json
```

Clients speak the same newline-delimited JSON-RPC 2.0 protocol as the stdio SDK profile — `initialize`, `session/prompt`, session and subagent notifications, `shutdown` — over a TCP connection instead of a pipe, so a client may be any process on the machine rather than a child of the runtime.

| Flag | Default | Behavior |
|---|---|---|
| `--host <host>` | `127.0.0.1` | Bind host. Loopback only: any other value is a usage error until network authorization exists. |
| `--port <port>` | `19391` | Listen port; `0` lets the OS pick a free one. |
| `--max-connections <count>` | `8` | Concurrent client connections; a connection beyond the limit receives an id-less `-32000` error frame and is closed. |
| `--descriptor-snapshot <path>` | — | Write the current method-face snapshot (Typert package models plus one JSON Schema per schema record) after the tree settles. |

`DSH_MAX_TOKENS_AS_SUCCESS` retains the SDK deployment mapping: unset or JSON `true` reports token-limited subagent completion as accepted, while JSON `false` reports it as an error.

**Readiness and lifetime.** The runtime is ready when the socket is bound and the tree has settled, not when stdin ends — stdin and stdout stay free for diagnostics. A client's `shutdown` request answers, disposes the complete root runtime, and exits 0, which is how any client stops a running daemon. A connection closing removes only that client: sessions created through earlier requests survive until the runtime exits, so a reconnecting client resumes by `sessionId`.

**One runtime, one identity.** The listener is single-tenant: every connection shares one `HarnessSdkJsonRpcServer`, so the first successful `initialize` fixes the provider, model, and working directory for all sessions. A later `initialize` carrying different parameters is refused with a JSON-RPC error instead of silently reconfiguring sessions other clients already hold; an equivalent re-initialization is idempotent for reconnecting clients. Deployments needing two identities run two runtimes.

<a id="model-experience"></a>
## Model Experience

### SDK coding-agent persona

#### What the model sees

The profile supplies `You are a coding agent powered by the {{model}} model.` before first-party guidance and `Your working directory is {{cwd}}.` in a separate persona suffix. The SDK initialization route and session cwd resolve the placeholders. Default file tool schemas include `read`, `write`, and `edit`; they omit `str_replace_editor`.

#### Token effect

Identical to the stdio SDK profile: one short stable persona plus the data-dependent base prompt sections and selected tool schemas. The transport does not enter the prompt.

#### KV Cache effect

Stable for a fixed profile, provider, model, and tool roster. Profile changes take effect on the next process because the shipped SDK profile uses startup-only patches.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No network authorization** — the listener serves harness file and shell tools, so a reachable port is remote code execution for anyone who can open it. Only loopback binds are accepted; serving a non-loopback address requires an authentication design that does not exist yet.
- **No per-connection identity** — one shared capability surface means one provider/model/cwd per process. Multi-tenant serving (per-connection initialization, per-tenant authorization) is deferred; run one runtime per identity instead.
- **Any client can stop the runtime** — `shutdown` retains the stdio profile's terminal semantics, so one client's request ends the process for all clients. An authorization design would have to decide who may request it.
- **Connections are not authenticated or encrypted** — TLS and client credentials are unimplemented; the transport assumes a same-machine client.
- **Configuration changes require restart** — the bundle disables HMR in YAML so a live connection never observes a replacement server or Agent dependency.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The bundle adds a network transport and a connection roster; source tests own flag gating, listener lifecycle, fan-out, the connection limit, and the single-identity guard.
