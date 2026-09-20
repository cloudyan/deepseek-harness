/**
 * The SDK network listener: flag gating, TCP JSON-RPC serving, notification
 * fan-out, the connection limit, the single-identity guard, shutdown, and the
 * descriptor snapshot.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { z } from 'zod'
import * as net from '../src/index.ts'
import { SDK_NET_STARTUP_SERVICE, type SdkNetStartupValues } from '../src/startup.ts'
import * as startup from '../src/startup.ts'

/** The provider route the mock adapter owns, so no fallback adapter mounts. */
const MOCK_PROVIDER = 'sdk-net-mock'

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 25))
})

/** Adapter that completes one text turn without a provider request. */
class CompletingAdapter extends LlmAdapter {
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'net-done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'net-done' } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Poll until `get` yields a value, or fail the test. */
async function waitFor<T>(get: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** A started runtime with the listener mounted against a real ephemeral port. */
interface RunningNet {
  ctx: Context
  port: number
  exits: number[]
  logs: string[]
  dispose(): Promise<void>
}

/** Options for one runtime mount; defaults mirror the profile patch expressions. */
interface StartOptions {
  /** Extra flag-provider arguments; `--port 0` is always prepended. */
  flags?: string[]
  /** Listener config overrides. */
  config?: Partial<net.SdkNetConfig>
  /** Mount the Cordis Loader, as every shipped profile does. */
  withLoader?: boolean
  /** Mount a real Typert registry. */
  withRegistry?: boolean
  /** Provide this value under the `typert` service key instead of a real registry. */
  fakeRegistry?: unknown
  /** Do not mount the flag provider, so the listener row's injection stays pending. */
  skipStartup?: boolean
  /** Do not wait for the listener to report ready (mounts that never serve). */
  skipReadyWait?: boolean
}

/**
 * Mount the profile's two rows against a real TCP port: the flag provider
 * resolves the invocation, and the listener row reads the service it provided
 * with the same fallbacks the patch expresses. Returns once the listener
 * reports the port it bound, which the test then connects to.
 */
async function startNet(storageDir: string, options: StartOptions = {}): Promise<RunningNet> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: storageDir })
  if (options.withLoader === true) await ctx.plugin(Loader)
  if (options.withRegistry === true) await ctx.plugin(TypertRegistry)
  ctx.llm.registerAdapter([MOCK_PROVIDER], new CompletingAdapter())
  await new Promise(resolve => setTimeout(resolve, 50))
  if (options.fakeRegistry !== undefined) ctx.provide('typert', options.fakeRegistry)

  const exits: number[] = []
  const logs: string[] = []
  provideCmdline(ctx, {
    args: ['--port', '0', ...options.flags ?? []],
    exit: code => void exits.push(code),
    ready: { onReady: (listener) => { listener(); return () => {} } },
  })
  if (options.skipStartup !== true) await ctx.plugin(startup)

  const values = ctx.get(SDK_NET_STARTUP_SERVICE) as SdkNetStartupValues | undefined
  const mounting = ctx.plugin(net, {
    host: values?.host ?? '127.0.0.1',
    port: values?.port ?? 19391,
    maxConnections: values?.maxConnections ?? 8,
    ...values?.descriptorSnapshotPath !== undefined && { descriptorSnapshotPath: values.descriptorSnapshotPath },
    maxTokensAsSuccess: true,
    log: (message) => { logs.push(message) },
    exit: (code) => { exits.push(code) },
    ...options.config,
  })
  const running: RunningNet = {
    ctx,
    port: 0,
    exits,
    logs,
    dispose: async () => { await ctx.fiber.dispose() },
  }
  if (options.skipReadyWait === true) {
    await new Promise(resolve => setTimeout(resolve, 50))
    return running
  }
  await mounting
  const serving = await waitFor(
    () => logs.find(message => message.startsWith('sdk-net: serving')),
    `the listener to report ready: ${logs.join(' | ')}`,
  )
  running.port = Number(/on .*:(\d+)$/.exec(serving)?.[1])
  return running
}

/** One NDJSON JSON-RPC client over a real socket. */
class NetClient {
  private readonly pending = new Map<number, (frame: Record<string, unknown>) => void>()
  private readonly raw: string[] = []
  private buffer = ''
  private nextId = 0
  readonly notifications: Array<{ method: string; params: Record<string, unknown> }> = []

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line === '') continue
        const frame = JSON.parse(line) as Record<string, unknown>
        if (typeof frame.id === 'number') this.pending.get(frame.id)?.(frame)
        else if (typeof frame.method === 'string') {
          this.notifications.push({ method: frame.method, params: (frame.params ?? {}) as Record<string, unknown> })
        } else this.raw.push(line)
      }
    })
  }

  static connect(port: number): Promise<NetClient> {
    return new Promise((resolvePromise, rejectPromise) => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => { resolvePromise(new NetClient(socket)) })
      socket.once('error', rejectPromise)
    })
  }

  /** Frames that carry neither a numeric id nor a method (the limit rejection). */
  get unmatched(): readonly string[] {
    return this.raw
  }

  get closed(): boolean {
    return this.socket.destroyed
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const id = ++this.nextId
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, resolvePromise)
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      setTimeout(() => {
        if (this.pending.delete(id)) rejectPromise(new Error(`timed out waiting for ${method}`))
      }, timeoutMs)
    })
  }

  /** A request whose frame carries no `params` member at all. */
  requestWithoutParams(method: string): Promise<Record<string, unknown>> {
    const id = ++this.nextId
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, resolvePromise)
      this.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method })}\n`)
      setTimeout(() => {
        if (this.pending.delete(id)) rejectPromise(new Error(`timed out waiting for ${method}`))
      }, 5000)
    })
  }

  async waitForNotification(method: string): Promise<{ method: string; params: Record<string, unknown> }> {
    return waitFor(() => this.notifications.find(entry => entry.method === method), `notification ${method}`)
  }

  /** Resolve when the peer closes this connection. */
  waitForClose(): Promise<void> {
    return new Promise((resolvePromise) => {
      if (this.socket.destroyed) resolvePromise()
      else this.socket.once('close', () => { resolvePromise() })
    })
  }

  end(): void {
    this.socket.end()
  }

  destroy(): void {
    this.socket.destroy()
  }
}

/** One complete `initialize` request for the mock provider. */
function initializeParams(cwd: string, model = 'mock-model'): Record<string, unknown> {
  return { cwd, provider: MOCK_PROVIDER, model }
}

describe('sdk-net listener', () => {
  it('serves initialize and a prompt turn over TCP and fans notifications to every client', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    const runtime = await startNet(storageDir, { withLoader: true, withRegistry: true })
    try {
      const first = await NetClient.connect(runtime.port)
      const second = await NetClient.connect(runtime.port)

      const init = await first.request('initialize', initializeParams(storageDir))
      expect(init.result).toEqual({ serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } })

      const prompt = await first.request('session/prompt', {
        sessionId: 'net-session',
        contentBlocks: [{ type: 'text', text: 'hello over tcp' }],
      })
      expect((prompt.result as { messageId?: unknown }).messageId).toBeTypeOf('string')

      // Both the requesting client and the idle observer see the same stream.
      const [won, seen] = await Promise.all([
        first.waitForNotification('session.event'),
        second.waitForNotification('session.event'),
      ])
      expect(won.params).toMatchObject({ sessionId: 'net-session' })
      expect(seen.params).toEqual(won.params)

      first.end()
      second.end()
    } finally {
      await runtime.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('serves without a Loader service, since readiness is optional in a hand-built tree', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    const runtime = await startNet(storageDir)
    try {
      const client = await NetClient.connect(runtime.port)
      const init = await client.request('initialize', initializeParams(storageDir))
      expect(init.result).toMatchObject({ serverInfo: { name: 'deepseek-harness-sdk-runtime' } })
      client.end()
    } finally {
      await runtime.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('accepts an equivalent re-initialization and refuses different parameters', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    const runtime = await startNet(storageDir, { withRegistry: true })
    try {
      const client = await NetClient.connect(runtime.port)
      await client.request('initialize', initializeParams(storageDir))
      // A reconnecting client repeats the handshake: identical parameters are idempotent.
      const again = await client.request('initialize', initializeParams(storageDir))
      expect(again.result).toMatchObject({ serverInfo: { name: 'deepseek-harness-sdk-runtime' } })
      // A second identity would silently reconfigure sessions the first client holds.
      const refused = await client.request('initialize', initializeParams(storageDir, 'other-model'))
      expect(refused.error).toMatchObject({ code: -32603 })
      expect(String((refused.error as { message?: string }).message)).toContain('already initialized with different parameters')
      client.end()
    } finally {
      await runtime.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('leaves the identity unset when an initialize is rejected', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    const runtime = await startNet(storageDir, { withRegistry: true })
    try {
      const client = await NetClient.connect(runtime.port)
      // A frame with no parameters at all reaches the capability surface and fails there.
      const malformed = await client.requestWithoutParams('initialize')
      expect(malformed.error).toMatchObject({ code: -32603 })
      // Only a successful initialize fixes the identity, so the corrected
      // handshake is still accepted instead of being refused as a change.
      const accepted = await client.request('initialize', initializeParams(storageDir))
      expect(accepted.result).toMatchObject({ serverInfo: { name: 'deepseek-harness-sdk-runtime' } })
      client.end()
    } finally {
      await runtime.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('accepts a handshake that caps output tokens', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    const runtime = await startNet(storageDir)
    try {
      const client = await NetClient.connect(runtime.port)
      const init = await client.request('initialize', { ...initializeParams(storageDir), maxTokens: 64 })
      expect(init.result).toMatchObject({ serverInfo: { name: 'deepseek-harness-sdk-runtime' } })
      client.end()
    } finally {
      await runtime.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('keeps serving after a client disconnects so sessions survive reconnects', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    const runtime = await startNet(storageDir, { withRegistry: true })
    try {
      const first = await NetClient.connect(runtime.port)
      await first.request('initialize', initializeParams(storageDir))
      await first.request('session/prompt', {
        sessionId: 'durable-session',
        contentBlocks: [{ type: 'text', text: 'persist me' }],
      })
      first.destroy()
      await new Promise(resolve => setTimeout(resolve, 25))

      const second = await NetClient.connect(runtime.port)
      const prompt = await second.request('session/prompt', {
        sessionId: 'durable-session',
        contentBlocks: [{ type: 'text', text: 'again' }],
      })
      expect((prompt.result as { messageId?: unknown }).messageId).toBeTypeOf('string')
      second.end()
    } finally {
      await runtime.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('rejects and closes a connection beyond the configured limit', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    const runtime = await startNet(storageDir, { flags: ['--max-connections', '1'] })
    try {
      const admitted = await NetClient.connect(runtime.port)
      await admitted.request('initialize', initializeParams(storageDir))

      const refused = await NetClient.connect(runtime.port)
      await refused.waitForClose()
      await waitFor(() => refused.unmatched[0], 'the limit rejection frame')
      expect(JSON.parse(refused.unmatched[0]!)).toMatchObject({
        id: null,
        error: { code: -32000, message: 'sdk-net: connection limit reached (1)' },
      })

      // Closing the admitted client frees the single slot. The server reaps the
      // close asynchronously, so probe with a short timeout until it is admitted.
      admitted.destroy()
      let successor: NetClient | undefined
      for (let attempt = 0; attempt < 10 && successor === undefined; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 25))
        const candidate = await NetClient.connect(runtime.port).catch(() => undefined)
        if (candidate === undefined) continue
        const answer = await candidate.request('initialize', initializeParams(storageDir), 250).catch(() => undefined)
        if (answer?.result !== undefined) successor = candidate
        else candidate.destroy()
      }
      expect(successor).toBeDefined()
      successor?.end()
    } finally {
      await runtime.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('answers shutdown terminally: flushed response, root disposal, and exit 0', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    const runtime = await startNet(storageDir, { withRegistry: true })
    const client = await NetClient.connect(runtime.port)
    try {
      await client.request('initialize', initializeParams(storageDir))
      const shutdown = await client.request('shutdown')
      expect(shutdown.result).toEqual({})

      await waitFor(() => runtime.exits[0], 'the exit record')
      expect(runtime.exits).toEqual([0])
      // The response was flushed and the listener stopped, so the runtime is gone.
      await client.waitForClose()
      await expect(NetClient.connect(runtime.port)).rejects.toThrow()
    } finally {
      client.destroy()
      await runtime.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('exits 1 and reports the reason when the port is already taken', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    const otherDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    const taken = await startNet(storageDir)
    try {
      const second = await startNet(otherDir, {
        config: { port: taken.port },
        skipReadyWait: true,
      })
      await waitFor(() => second.exits[0], 'the exit record')
      expect(second.exits).toEqual([1])
      expect(second.logs.some(message => message.includes('sdk-net: listener error'))).toBe(true)
      await second.dispose()
    } finally {
      await taken.dispose()
      await rm(storageDir, { recursive: true, force: true })
      await rm(otherDir, { recursive: true, force: true })
    }
  })

  it('stops serving on a bare fiber dispose without calling exit', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    const runtime = await startNet(storageDir)
    const client = await NetClient.connect(runtime.port)
    await client.request('initialize', initializeParams(storageDir))

    await runtime.dispose()
    await client.waitForClose()
    expect(runtime.exits).toEqual([])
    await rm(storageDir, { recursive: true, force: true })
  })

  it('never opens a port when the invocation only prints help', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    // `--help` provides no flag service, so the listener row's injection stays
    // pending and no socket is bound.
    const runtime = await startNet(storageDir, { flags: ['--help'], skipReadyWait: true })
    try {
      expect(runtime.exits).toEqual([0])
      expect(runtime.logs).toEqual([])
      expect(runtime.ctx.get(SDK_NET_STARTUP_SERVICE)).toBeUndefined()
    } finally {
      await runtime.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('stays pending when no flag provider is mounted at all', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    const runtime = await startNet(storageDir, { skipStartup: true, skipReadyWait: true })
    try {
      expect(runtime.logs).toEqual([])
      expect(runtime.exits).toEqual([])
    } finally {
      await runtime.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })
})

describe('sdk-net descriptor snapshot', () => {
  it('writes package models and JSON Schemas once the listener is up', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    const snapshotPath = join(storageDir, 'nested', 'methods.json')
    const runtime = await startNet(storageDir, {
      withRegistry: true,
      config: { descriptorSnapshotPath: snapshotPath },
    })
    try {
      await waitFor(
        () => runtime.logs.find(message => message.includes('descriptor snapshot written')),
        'the snapshot log line',
      )
      const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
        format: string
        packages: unknown[]
        schemas: unknown[]
      }
      expect(snapshot.format).toBe('dsh.sdk-net.descriptor-snapshot/1')
      expect(snapshot.packages).toEqual([])
      expect(snapshot.schemas).toEqual([])
    } finally {
      await runtime.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('reports a failed snapshot without stopping the runtime', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    // A regular file where the snapshot wants a directory makes mkdir fail.
    const blocker = join(storageDir, 'blocker')
    await writeFile(blocker, 'not a directory')
    const runtime = await startNet(storageDir, {
      withRegistry: true,
      config: { descriptorSnapshotPath: join(blocker, 'nested', 'methods.json') },
    })
    try {
      const failure = await waitFor(
        () => runtime.logs.find(message => message.includes('descriptor snapshot failed')),
        'the snapshot failure log line',
      )
      expect(failure).toContain('ENOTDIR')
      // Serving continues: the client still completes a handshake.
      const client = await NetClient.connect(runtime.port)
      expect(await client.request('initialize', initializeParams(storageDir))).toMatchObject({ result: {} })
      client.end()
    } finally {
      await runtime.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })

  it('reports a non-Error snapshot failure by value', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'sdk-net-'))
    const runtime = await startNet(storageDir, {
      fakeRegistry: { listPackages: () => { throw 'registry exploded' } },
      config: { descriptorSnapshotPath: join(storageDir, 'methods.json') },
    })
    try {
      const failure = await waitFor(
        () => runtime.logs.find(message => message.includes('descriptor snapshot failed')),
        'the snapshot failure log line',
      )
      expect(failure).toContain('registry exploded')
    } finally {
      await runtime.dispose()
      await rm(storageDir, { recursive: true, force: true })
    }
  })
})

describe('sdk-net fan-out peer', () => {
  it('fans notifications to children and rejects server-initiated requests', async () => {
    const fanout = new net.SdkNetFanoutPeer()
    const seen: string[] = []
    const child = {
      request: (): Promise<unknown> => Promise.resolve(),
      notify: (method: string) => { seen.push(method) },
    }
    expect(fanout.size).toBe(0)
    fanout.add(child)
    expect(fanout.size).toBe(1)
    fanout.notify('session.event', { sessionId: 's1' })
    expect(seen).toEqual(['session.event'])
    fanout.remove(child)
    fanout.notify('session.event', { sessionId: 's2' })
    expect(seen).toEqual(['session.event'])
    expect(fanout.size).toBe(0)
    await expect(fanout.request()).rejects.toThrow('server-initiated requests are not supported')
  })
})

describe('sdk-net snapshot writer', () => {
  it('writes package models and JSON Schemas from a real registry', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    const registry = ctx.get('typert')
    if (registry === undefined) throw new Error('registry missing')
    registry.register({
      package: 'test-pkg',
      face: 'host',
      schemas: [{ name: 'TestShape', create: () => z.object({ label: z.string() }) }],
      model: {
        services: [{
          key: 'test-service',
          exportName: 'TestService',
          members: [{ kind: 'method', name: 'doThing', signature: 'doThing(): void' }],
          types: [],
          tags: [],
        }],
        events: [],
        objects: [],
      },
      invocations: [],
    })
    const dir = await mkdtemp(join(tmpdir(), 'sdk-net-snapshot-'))
    try {
      const path = join(dir, 'nested', 'snapshot.json')
      await net.writeDescriptorSnapshot(ctx, path)
      const snapshot = JSON.parse(await readFile(path, 'utf8')) as {
        format: string
        packages: Array<{ key: string; package: string; face: string; model: { services: unknown[] } }>
        schemas: Array<{ key: string; name: string; face: string; jsonSchema: Record<string, unknown> }>
      }
      expect(snapshot.format).toBe('dsh.sdk-net.descriptor-snapshot/1')
      expect(snapshot.packages[0]).toMatchObject({ package: 'test-pkg', face: 'host' })
      expect(snapshot.packages[0]?.model.services[0]).toMatchObject({ key: 'test-service' })
      expect(snapshot.schemas[0]).toMatchObject({ name: 'TestShape', face: 'host' })
      expect(snapshot.schemas[0]?.jsonSchema).toMatchObject({ type: 'object' })
    } finally {
      await rm(dir, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('fails loud when the typert registry service is missing', async () => {
    const ctx = new Context()
    await expect(net.writeDescriptorSnapshot(ctx, 'unused.json')).rejects.toThrow('typert registry service is missing')
  })
})
