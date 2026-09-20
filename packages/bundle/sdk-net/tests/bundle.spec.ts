/** The SDK net bundle's declared profile patch and manifest wiring. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

/** One parsed `!!js` scalar, as the entry-list dialect represents it. */
interface JsExpr {
  __jsExpr: string
}

interface PatchRow {
  id?: string
  disabled?: boolean
  inject?: string[]
  name?: string
  config?: Record<string, unknown>
}

describe('dsh-sdk-net bundle', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    exports?: Record<string, unknown>
    files?: string[]
    dsh?: { bundle?: { patch?: string } }
  }
  const patches = yaml.load(
    readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
    { schema: entryListSchema },
  ) as Array<PatchRow & { insert?: PatchRow[] }>

  it('ships the patch layer and both plugin entry points', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.exports).toHaveProperty('./startup')
    expect(manifest.exports).toHaveProperty('.')
    // The startup subpath is published, so the patch row can resolve it in a release.
    expect(manifest.files).toContain('lib/startup.js')
  })

  it('reuses the shared capability surface and the flag command line', () => {
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-sdk-jsonrpc-server')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-sdk-protocol')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-typert-registry')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-cmdline')
  })

  it('inherits the base HMR policy and the SDK persona without model titles', () => {
    expect(patches.find(patch => patch.id === 'hmr')).toMatchObject({ disabled: true })
    expect(patches.find(patch => patch.id === 'session-title-llm')).toMatchObject({ disabled: true })
    expect(patches.find(patch => patch.id === 'system-prompt')).toMatchObject({
      config: { personaSuffix: 'Your working directory is {{cwd}}.' },
    })
  })

  it('gates the listener row on the flag provider that owns the command line', () => {
    const rows = patches.flatMap(patch => patch.insert ?? [])
    expect(rows.map(row => row.id)).toEqual(['sdk-net-startup', 'sdk-net'])

    const provider = rows.find(row => row.id === 'sdk-net-startup')
    expect(provider?.name).toBe('@deepseek-ai/dsh-sdk-net/startup')
    // The provider injects nothing but the launcher command line, so help and
    // usage errors still resolve without any other service.
    expect(provider?.inject).toBeUndefined()

    const listener = rows.find(row => row.id === 'sdk-net')
    expect(listener?.name).toBe('@deepseek-ai/dsh-sdk-net')
    expect(listener?.inject).toEqual(['sdkNetStartup'])
  })

  it('lets an invocation flag beat each value written beside it', () => {
    const listener = patches.flatMap(patch => patch.insert ?? []).find(row => row.id === 'sdk-net')
    expect(listener?.config?.host).toEqual({ __jsExpr: "ctx.sdkNetStartup.host ?? '127.0.0.1'" } satisfies JsExpr)
    expect(listener?.config?.port).toEqual({ __jsExpr: 'ctx.sdkNetStartup.port ?? 19391' } satisfies JsExpr)
    expect(listener?.config?.maxConnections).toEqual({ __jsExpr: 'ctx.sdkNetStartup.maxConnections ?? 8' } satisfies JsExpr)
    expect(listener?.config?.descriptorSnapshotPath).toEqual({ __jsExpr: 'ctx.sdkNetStartup.descriptorSnapshotPath' } satisfies JsExpr)
    expect(listener?.config?.maxTokensAsSuccess).toHaveProperty('__jsExpr')
  })
})
