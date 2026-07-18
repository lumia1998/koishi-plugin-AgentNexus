import { readFile } from 'fs/promises'
import path from 'path'
import { listAdapters } from '../src/adapters'
import { AgentRunner, type DelegateResult } from '../src/runtime/runner'
import { SessionManager } from '../src/sessions/manager'
import { MemorySessionStorage } from '../src/sessions/storage'
import { SshSession } from '../src/ssh/session'
import type {
    AgentKind,
    AgentRuntimeOptions,
    DelegateInput,
    NexusConfig
} from '../src/types'

interface SmokeResult {
    agent: AgentKind
    installed: boolean
    executable?: string
    version?: string
    oneShot?: InvocationResult
    managed?: {
        first: InvocationResult
        second: InvocationResult
        remembered: boolean
        providerSession: boolean
    }
    error?: string
}

interface InvocationResult {
    ok: boolean
    exitCode?: number
    timedOut?: boolean
    text: string
    files?: number
    images?: number
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    if (!args.config) {
        throw new Error(
            'Usage: npm run test:agents -- --config <data/agent-nexus/config.json> [--host <name-or-id>] [--oneshot]'
        )
    }
    const config = JSON.parse(await readFile(args.config, 'utf8')) as NexusConfig
    const hosts = (config.hosts ?? []).filter((host) => host.enabled)
    const host = args.host
        ? hosts.find((item) => item.id === args.host || item.name === args.host)
        : hosts[0]
    if (!host) throw new Error('No matching enabled AgentNexus SSH host')

    const ssh = new SshSession(host)
    const runtime: AgentRuntimeOptions = {
        openclawAgent: 'default',
        claudeSkipPermissions: false,
        codexBypassSandbox: false,
        opencodeAuto: false,
        defaultTimeoutMs: 180000
    }
    const results: SmokeResult[] = []
    try {
        await ssh.connect()
        for (const adapter of listAdapters()) {
            const result: SmokeResult = {
                agent: adapter.kind,
                installed: false
            }
            results.push(result)
            try {
                const detected = await adapter.detect(ssh)
                result.installed = detected.installed
                result.executable = detected.path
                    ? path.posix.basename(detected.path)
                    : undefined
                result.version = detected.version
                if (!detected.installed) continue

                const execute = async (input: DelegateInput): Promise<DelegateResult> => {
                    const command = adapter.buildCommand({
                        prompt: input.prompt,
                        cwd: input.cwd,
                        model: input.model,
                        timeoutMs: input.timeoutMs,
                        openclawAgent: input.openclawAgent,
                        runtime,
                        sessionMode: input.sessionMode,
                        providerState: input.providerState,
                        executablePath: detected.path
                    })
                    const raw = await ssh.exec(command, {
                        cwd: input.cwd,
                        timeoutMs: input.timeoutMs ?? 180000,
                        signal: input.signal
                    })
                    return {
                        ...adapter.parseResult(
                            raw.stdout,
                            raw.stderr,
                            raw.exitCode,
                            raw.timedOut,
                            command
                        ),
                        hostId: host.id
                    }
                }

                const oneShot = await execute({
                    hostId: host.id,
                    agent: adapter.kind,
                    prompt: exactPrompt('AGENT_NEXUS_SMOKE_OK'),
                    sessionMode: 'oneshot'
                })
                result.oneShot = invocation(oneShot, 'AGENT_NEXUS_SMOKE_OK')

                if (!args.oneshot) {
                    result.managed = await managedSmoke(
                        adapter.kind,
                        host.id,
                        execute
                    )
                }
            } catch (error) {
                result.error = error instanceof Error ? error.message : String(error)
            }
        }
    } finally {
        await ssh.disconnect().catch(() => undefined)
    }

    const failed = results.some(
        (result) =>
            result.error ||
            (result.installed &&
                (!result.oneShot?.ok ||
                    (!args.oneshot && !result.managed?.remembered)))
    )
    console.log(
        JSON.stringify(
            {
                host: host.name,
                environment: ssh.environmentInfo,
                mode: args.oneshot ? 'oneshot' : 'oneshot+managed',
                results
            },
            null,
            2
        )
    )
    if (failed) process.exitCode = 1
}

async function managedSmoke(
    agent: AgentKind,
    hostId: string,
    execute: (input: DelegateInput) => Promise<DelegateResult>
) {
    const sessions = new SessionManager(new MemorySessionStorage())
    const runner = new AgentRunner(sessions, execute)
    const identity = {
        userId: `smoke-${agent}`,
        channelId: 'agent-nexus-smoke',
        platform: 'local',
        selfId: 'agent-nexus-smoke'
    }
    await runner.startInteractive(
        identity,
        { agent, hostId, sessionMode: 'managed' },
        10 * 60 * 1000
    )
    const first = await runner.resume(
        identity,
        'Do not call tools or access files. Remember the code BLUE-47 for the next turn. Output exactly AGENT_NEXUS_STEP1_OK and nothing else.'
    )
    const second = await runner.resume(
        identity,
        'Do not call tools or access files. Output exactly the code I asked you to remember, and nothing else.'
    )
    await runner.endInteractive(identity, agent, hostId)
    return {
        first: invocation(first.result, 'AGENT_NEXUS_STEP1_OK'),
        second: invocation(second.result, 'BLUE-47'),
        remembered: second.result?.text.trim() === 'BLUE-47',
        providerSession: Boolean(second.result?.providerState?.sessionId)
    }
}

function invocation(
    result: DelegateResult | undefined,
    expected: string
): InvocationResult {
    const text = result?.text.trim() ?? ''
    return {
        ok:
            Boolean(result) &&
            result!.exitCode === 0 &&
            !result!.timedOut &&
            text === expected &&
            result!.files.length === 0 &&
            result!.images.length === 0,
        exitCode: result?.exitCode,
        timedOut: result?.timedOut,
        text: text.replace(/\s+/g, ' ').slice(0, 240),
        files: result?.files.length,
        images: result?.images.length
    }
}

function exactPrompt(token: string) {
    return `Do not call tools. Do not read, create, or modify files. Output exactly ${token} and nothing else.`
}

function parseArgs(values: string[]) {
    const result: { config?: string; host?: string; oneshot: boolean } = {
        oneshot: false
    }
    for (let index = 0; index < values.length; index += 1) {
        const value = values[index]
        if (value === '--config') result.config = values[++index]
        else if (value === '--host') result.host = values[++index]
        else if (value === '--oneshot') result.oneshot = true
    }
    return result
}

void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
})
