/**
 * The SDK network app's command-line provider: it parses the
 * `dsh --profile sdk-net` flag family (`--host`, `--port`,
 * `--max-connections`, `--descriptor-snapshot`) and its `--help` text, then
 * provides the immutable values as {@link SDK_NET_STARTUP_SERVICE}. Ordinary
 * rows inject that service before reading it from lazy config, so a flag beats
 * the value written beside it.
 *
 * The listener is an unauthenticated harness capability surface, so only
 * loopback bind addresses are accepted until a network authorization story
 * exists; see the package README.
 *
 * @module @deepseek-ai/dsh-sdk-net/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'sdk-net-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the listener row. */
export const SDK_NET_STARTUP_SERVICE = 'sdkNetStartup'

/** What the listener row reads from {@link SDK_NET_STARTUP_SERVICE}. */
export interface SdkNetStartupValues {
  /** `--host`, absent when the invocation did not name one. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /** `--max-connections`, absent when the invocation did not name one. */
  maxConnections?: number
  /** `--descriptor-snapshot`, absent when the invocation did not name one. */
  descriptorSnapshotPath?: string
}

/** The flag family, as commander parsed it. */
interface SdkNetOptions {
  host?: string
  maxConnections?: string
  descriptorSnapshot?: string
  port?: string
}

/**
 * Whether a bind host stays inside the machine. The listener serves the
 * complete harness capability surface with no authentication, so a
 * non-loopback address would be remote code execution for anyone who can
 * reach the port.
 * @param host - the `--host` value.
 * @returns true for loopback names and loopback IPv4 addresses.
 */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]'
    || host === '127.0.0.1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function sdkNetCommand(): Command {
  return new Command()
    .name('dsh --profile sdk-net')
    .description('Serve DeepSeek Harness SDK clients over a TCP NDJSON JSON-RPC listener.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host; loopback only until network authorization exists')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--max-connections <count>', 'maximum concurrent client connections')
    .option('--descriptor-snapshot <path>', 'write the method-face descriptor snapshot JSON to this path')
    .addHelpText('after', `
Examples:
  dsh --profile sdk-net                       serve on 127.0.0.1:19391
  dsh --profile sdk-net --port 0              serve on an OS-assigned port
  dsh --profile sdk-net --max-connections 1   admit one client at a time
`)
}

/**
 * Parse and provide the network invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; a non-loopback
 * `--host`, a non-numeric `--port`, or a non-positive `--max-connections` is a
 * usage error, so on rejection (and on `--help`) nothing is provided and no
 * listener row activates.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = sdkNetCommand()
  program.action(() => {
    const options = program.opts<SdkNetOptions>()
    if (options.host !== undefined && !isLoopbackHost(options.host)) {
      program.error(`error: --host ${options.host} is intentionally not supported yet for safety: the listener exposes harness tools with no authentication; use 127.0.0.1 instead`)
    }
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    if (options.maxConnections !== undefined && !/^[1-9]\d*$/.test(options.maxConnections)) {
      program.error(`error: --max-connections must be a positive integer, got ${JSON.stringify(options.maxConnections)}`)
    }
    ctx.provide(SDK_NET_STARTUP_SERVICE, {
      ...options.host !== undefined && { host: options.host },
      ...options.port !== undefined && { port: Number(options.port) },
      ...options.maxConnections !== undefined && { maxConnections: Number(options.maxConnections) },
      ...options.descriptorSnapshot !== undefined && { descriptorSnapshotPath: options.descriptorSnapshot },
    } satisfies SdkNetStartupValues)
  })
  parseCmdline(ctx, program)
}
