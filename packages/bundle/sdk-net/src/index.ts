/**
 * The SDK network application: NDJSON JSON-RPC harness capability serving over
 * TCP. The shared {@link HarnessSdkJsonRpcServer} capability surface (turns,
 * sessions, events, shutdown) is reused unchanged from
 * `@deepseek-ai/dsh-sdk-jsonrpc-server`; this package adds a connection
 * listener with a notification fan-out, so one runtime serves network clients.
 *
 * The process streams stay untouched: stdin/stdout remain available for
 * diagnostics, and the stdio SDK profile is unaffected. Readiness is bound to
 * the listener instead of stdin EOF, so the runtime lives until a client
 * requests `shutdown` or the tree is disposed.
 *
 * The runtime is single-tenant by design — one provider/model/cwd per process,
 * exactly like the stdio profile. Every live connection shares the one
 * capability surface, so the first successful `initialize` fixes the runtime
 * identity and a later `initialize` carrying different parameters is rejected
 * rather than silently reconfiguring the sessions other clients already hold.
 *
 * The contract follows the runtime's latest-only policy: the method surface is
 * whatever the running version exposes (see {@link writeDescriptorSnapshot}
 * for the machine-readable face); no cross-version compatibility is promised.
 *
 * @module @deepseek-ai/dsh-sdk-net
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { JsonRpcLineTransport, type JsonRpcTransportPeer } from '@deepseek-ai/dsh-sdk-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { SDK_NET_STARTUP_SERVICE } from './startup.ts'

/** Stable Cordis plugin name. */
export const name = 'sdk-net'

/**
 * Required services: the flag provider that gates this row, and the agent
 * factory the capability surface creates sessions through.
 */
export const inject = [SDK_NET_STARTUP_SERVICE, 'agents']

/** Network listener configuration. */
export interface SdkNetConfig {
  /** Listen host; loopback only (the flag provider rejects anything else). */
  host?: string
  /** Listen port; `0` lets the OS pick a free one. */
  port?: number
  /** Maximum concurrent client connections. */
  maxConnections?: number
  /** Report max-token turn/subagent termination as a successful SDK result. */
  maxTokensAsSuccess?: boolean
  /** When set, write a Typert method-face snapshot JSON once the tree settles. */
  descriptorSnapshotPath?: string
  /** Process-exit override; production uses `process.exit` (runtime test hook). */
  exit?: (code: number) => void
  /** Diagnostics sink override; production uses `process.stderr` (runtime test hook). */
  log?: (message: string) => void
}

/** Validate and default the listener configuration. */
export const Config: Schema<SdkNetConfig> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.number().default(19391),
  maxConnections: Schema.number().default(8),
  maxTokensAsSuccess: Schema.boolean().default(false),
  descriptorSnapshotPath: Schema.string(),
})

/** The configuration the plugin consumes after schema defaulting. */
type ResolvedSdkNetConfig = SdkNetConfig & {
  host: string
  port: number
  maxConnections: number
  maxTokensAsSuccess: boolean
}

/** One admitted connection: its protocol transport and the socket underneath. */
interface NetConnection {
  transport: JsonRpcLineTransport
  socket: Socket
}

/**
 * Fan one shared capability server's notifications out to every live
 * connection. The shared server only issues notifications back to its
 * transport peer; server-initiated requests are rejected as unsupported.
 */
export class SdkNetFanoutPeer implements JsonRpcTransportPeer {
  private readonly children = new Set<JsonRpcTransportPeer>()

  /** Track one connection's transport so later notifications reach it. */
  add(child: JsonRpcTransportPeer): void {
    this.children.add(child)
  }

  /** Stop tracking a closed connection's transport. */
  remove(child: JsonRpcTransportPeer): void {
    this.children.delete(child)
  }

  /** Live connection count. */
  get size(): number {
    return this.children.size
  }

  request(): Promise<unknown> {
    return Promise.reject(new Error('sdk-net: server-initiated requests are not supported'))
  }

  notify(method: string, params?: object): void {
    for (const child of this.children) child.notify(method, params)
  }
}

/**
 * The `initialize` parameters that decide what every session on this runtime
 * does, in a fixed order so the identity string is comparable.
 */
const IDENTITY_FIELDS = ['cwd', 'provider', 'model', 'reasoningEffort', 'maxTokens'] as const

/**
 * The wire identity of an `initialize` invocation: the parameters that decide
 * what every session on this runtime does. Compared as a whole so an
 * equivalent re-initialization (an SDK client reconnecting) is idempotent while
 * a different one is refused.
 * @param params - the raw params object from the wire, absent when the frame carried none.
 * @returns a stable string that changes whenever the identity changes.
 */
function initializeIdentity(params: Record<string, unknown> | undefined): string {
  return JSON.stringify(IDENTITY_FIELDS.map(field => params?.[field] ?? null))
}

/**
 * Export the registry's current method face as a machine-readable snapshot:
 * one entry per contributed package model plus one JSON Schema per schema
 * record. Written after the tree settles, so a source checkout without
 * generated contributor modules produces an empty-but-valid snapshot.
 * @param ctx - plugin context carrying the Typert registry service.
 * @param filePath - snapshot destination; parent directories are created.
 */
export async function writeDescriptorSnapshot(ctx: Context, filePath: string): Promise<void> {
  const registry = ctx.get('typert')
  if (registry === undefined) throw new Error('sdk-net: typert registry service is missing')
  const packages = registry.listPackages().map(record => ({
    key: record.key,
    package: record.package,
    face: record.face,
    model: record.model,
  }))
  const schemas = registry.list().map(record => ({
    key: record.key,
    package: record.package,
    name: record.name,
    face: record.face,
    jsonSchema: registry.toJSONSchema(record.key),
  }))
  const snapshot = {
    format: 'dsh.sdk-net.descriptor-snapshot/1',
    generatedAt: new Date().toISOString(),
    packages,
    schemas,
  }
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`)
}

/**
 * Accept an invocation and serve NDJSON JSON-RPC over TCP. Help exits without
 * opening a port, because this row never activates without the flag provider's
 * service. One client's protocol `shutdown` answers, disposes the complete
 * root runtime, and exits 0 — the same terminal semantics as the stdio SDK
 * profile, and therefore the way any client stops the daemon. A connection
 * closing removes only that client: sessions and agents created through
 * earlier requests survive until the runtime exits.
 * @param ctx - plugin context carrying the flag service and the agent factory.
 * @param config - listener configuration with schema defaults applied.
 */
export function apply(ctx: Context, config: SdkNetConfig): void {
  // Cordis applies the schema defaults before invoking the plugin.
  const resolved = config as ResolvedSdkNetConfig
  /* v8 ignore next -- production stderr wiring; tests always inject the hook */
  const log = config.log ?? ((message: string): void => { process.stderr.write(`${message}\n`) })
  /* v8 ignore next -- production exit wiring; tests always inject the runtime hooks */
  const exit = config.exit ?? ((code: number): void => { process.exit(code) })
  const rootFiber = ctx.root.fiber

  const fanout = new SdkNetFanoutPeer()
  const server = new HarnessSdkJsonRpcServer(ctx, fanout, {
    maxTokensAsSuccess: resolved.maxTokensAsSuccess,
  })
  const connections = new Set<NetConnection>()
  let identity: string | undefined

  /** Stop accepting connections, drain answered frames, then drop every socket. */
  const closeServing = async (): Promise<void> => {
    listener.close()
    await Promise.allSettled([...connections].map(entry => entry.transport.flush()))
    for (const entry of connections) entry.socket.destroy()
  }

  // A protocol shutdown owns the complete runtime process, so it must await the
  // root lifecycle (including persistence) before exiting. The exit task is
  // shared, so a racing second shutdown answers but changes nothing.
  let exitTask: Promise<void> | undefined
  const disposeAndExit = (): void => {
    exitTask ??= (async () => {
      await closeServing()
      await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())])
      exit(0)
    })()
  }

  const handleRequest = async (method: string, params: Record<string, unknown> | undefined): Promise<unknown> => {
    // `initialize` is the SDK's readiness boundary: do not advertise a ready
    // runtime until the complete current tree has settled.
    if (method === 'initialize') {
      await ctx.get('loader')?.await()
      // Only a successful initialize fixes the identity, so a rejected first
      // attempt can still be retried with corrected parameters.
      if (identity !== undefined && identity !== initializeIdentity(params)) {
        throw new Error('sdk-net: this runtime is already initialized with different parameters; every connection shares one provider, model, and working directory, so start another sdk-net runtime instead')
      }
    }
    const result = await server.handleRequest(method, params)
    if (method === 'initialize') identity = initializeIdentity(params)
    else if (method === 'shutdown') setImmediate(disposeAndExit)
    return result
  }

  const listener = createServer((socket: Socket) => {
    if (connections.size >= resolved.maxConnections) {
      // Pre-protocol rejection: no frame has been read yet, so the reason
      // travels as an id-less JSON-RPC error frame before the close.
      socket.end(`${JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: `sdk-net: connection limit reached (${resolved.maxConnections})` },
      })}\n`)
      return
    }
    const transport = new JsonRpcLineTransport(socket, socket)
    const connection: NetConnection = { transport, socket }
    connections.add(connection)
    fanout.add(transport)
    socket.once('close', () => {
      connections.delete(connection)
      fanout.remove(transport)
    })
    transport.onRequest(handleRequest)
    transport.start()
  })
  listener.on('error', (error: Error) => {
    log(`sdk-net: listener error: ${error.message}`)
    exit(1)
  })
  listener.listen(resolved.port, resolved.host, () => {
    const address = listener.address()
    /* v8 ignore next -- a listening TCP server always reports an AddressInfo */
    const endpoint = address === null || typeof address === 'string'
      ? String(address)
      : `${address.address}:${address.port}`
    log(`sdk-net: serving NDJSON JSON-RPC on ${endpoint}`)
    if (resolved.descriptorSnapshotPath !== undefined) {
      const path = resolved.descriptorSnapshotPath
      void Promise.resolve(ctx.get('loader')?.await())
        .then(() => writeDescriptorSnapshot(ctx, path))
        .then(
          () => { log(`sdk-net: descriptor snapshot written to ${path}`) },
          (error: unknown) => {
            log(`sdk-net: descriptor snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
          },
        )
    }
  })

  ctx.effect(() => () => {
    // A protocol shutdown already stopped serving; unloading the fiber
    // afterwards must not repeat that work.
    if (exitTask !== undefined) return
    return Promise.resolve().then(async () => {
      await server.shutdown()
      await closeServing()
    })
  }, 'sdk-net.serve')
}
