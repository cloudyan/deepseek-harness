/** The SDK net flag provider: loopback gating, numeric validation, and help. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { apply, isLoopbackHost, SDK_NET_STARTUP_SERVICE } from '../src/startup.ts'
import type { SdkNetStartupValues } from '../src/startup.ts'

afterEach(() => {
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

/** Run the flag provider with captured command output and exit requests. */
function start(args: string[]): { ctx: Context; exits: number[]; out: () => string } {
  const ctx = new Context()
  const exits: number[] = []
  let out = ''
  const capture = { write: (chunk: string) => { out += chunk; return true } }
  internals.stdout = capture
  internals.stderr = capture
  provideCmdline(ctx, {
    args,
    exit: code => void exits.push(code),
    ready: { onReady: (listener) => { listener(); return () => {} } },
  })
  apply(ctx)
  return { ctx, exits, out: () => out }
}

describe('sdk-net host validation', () => {
  it('accepts loopback names and loopback IPv4 addresses only', () => {
    for (const host of ['localhost', '::1', '[::1]', '127.0.0.1', '127.9.8.7']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
    for (const host of ['0.0.0.0', '192.168.1.10', 'example.com', '128.0.0.1', '::']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})

describe('sdk-net startup flags', () => {
  it('provides no values when the invocation names no flag', async () => {
    const { ctx, exits } = start([])
    expect(ctx.get(SDK_NET_STARTUP_SERVICE)).toEqual({})
    expect(exits).toEqual([])
    await ctx.fiber.dispose()
  })

  it('provides every value the invocation named', async () => {
    const { ctx } = start([
      '--host', 'localhost',
      '--port', '0',
      '--max-connections', '3',
      '--descriptor-snapshot', '/tmp/methods.json',
    ])
    expect(ctx.get(SDK_NET_STARTUP_SERVICE)).toEqual({
      host: 'localhost',
      port: 0,
      maxConnections: 3,
      descriptorSnapshotPath: '/tmp/methods.json',
    } satisfies SdkNetStartupValues)
    await ctx.fiber.dispose()
  })

  it('rejects a non-loopback host with the safety reason and provides nothing', () => {
    const { ctx, exits, out } = start(['--host', '0.0.0.0'])
    expect(out()).toContain('--host 0.0.0.0 is intentionally not supported yet for safety')
    expect(out()).toContain('use 127.0.0.1 instead')
    expect(ctx.get(SDK_NET_STARTUP_SERVICE)).toBeUndefined()
    expect(exits).toEqual([1])
  })

  it('rejects a non-numeric port and provides nothing', () => {
    const { ctx, exits, out } = start(['--port', 'http'])
    expect(out()).toContain('--port must be a number, got "http"')
    expect(ctx.get(SDK_NET_STARTUP_SERVICE)).toBeUndefined()
    expect(exits).toEqual([1])
  })

  it('rejects a non-positive connection limit and provides nothing', () => {
    const { ctx, exits, out } = start(['--max-connections', '0'])
    expect(out()).toContain('--max-connections must be a positive integer, got "0"')
    expect(ctx.get(SDK_NET_STARTUP_SERVICE)).toBeUndefined()
    expect(exits).toEqual([1])
  })

  it('prints help without providing values or opening a listener', () => {
    const { ctx, exits, out } = start(['--help'])
    expect(out()).toContain('dsh --profile sdk-net')
    expect(out()).toContain('--descriptor-snapshot')
    expect(ctx.get(SDK_NET_STARTUP_SERVICE)).toBeUndefined()
    expect(exits).toEqual([0])
  })
})
