import { CodeAgentAdapter, type DelegateOptions } from './base'
import { quoteShell } from '../utils/shell'

export class HermesAdapter extends CodeAgentAdapter {
    readonly kind = 'hermes' as const
    readonly binNames = ['hermes']

    skillDirs(home: string) {
        return [`${home}/.hermes/skills`]
    }

    buildInnerCommand(promptExpr: string, options: DelegateOptions) {
        const executable = this.executable(options, 'hermes')
        if (options.sessionMode === 'managed') {
            const sessionId = providerSessionId(options.providerState)
            const sessionArg = sessionId
                ? ` --resume ${quoteShell(sessionId)}`
                : ' --source agent-nexus'
            return `${executable} chat --quiet --yolo${sessionArg} -q ${promptExpr}`
        }
        return `${executable} -z ${promptExpr}`
    }

    protected parseText(stdout: string, stderr: string) {
        return mergeHermesOutput(
            cleanHermesCliNoise(stdout),
            cleanHermesCliNoise(stderr)
        )
    }

    parseResult(
        stdout: string,
        stderr: string,
        exitCode: number,
        timedOut: boolean,
        command: string
    ) {
        const result = super.parseResult(
            stdout,
            stderr,
            exitCode,
            timedOut,
            command
        )
        result.raw = mergeHermesOutput(
            cleanHermesCliNoise(stdout),
            cleanHermesCliNoise(stderr)
        )
        const sessionId = extractHermesSessionId(`${stdout}\n${stderr}`)
        if (sessionId) result.providerState = { sessionId }
        return result
    }
}

/** Remove Hermes CLI metadata that must not be shown as the agent reply. */
export function cleanHermesCliNoise(text: string) {
    return stripHermesMcpShutdownNoise(
        text
        .split(/\r?\n/)
        .map((line) => stripAnsi(line))
        .join('\n')
    )
        .split(/\r?\n/)
        .filter(
            (line) => {
                const value = line.trim()
                return (
                    !/^Warning:\s*Unknown toolsets:\s*.+$/i.test(value) &&
                    !/^session_id:\s*\S+\s*$/i.test(value) &&
                    !/^[↻⟳]?\s*Resumed session\s+\S+\s+\(.+\)\s*$/i.test(
                        value
                    )
                )
            }
        )
        .join('\n')
        .trim()
}

export function stripHermesMcpShutdownNoise(text: string) {
    const output: string[] = []
    let candidate: string[] | undefined
    for (const line of text.split(/\r?\n/)) {
        const value = stripAnsi(line).trim()
        const starts = /^Exception ignored in:\s*<coroutine object MCPServerTask\.run(?: at 0x[0-9a-f]+)?>$/i.test(
            value
        )
        if (!candidate) {
            if (starts) candidate = [line]
            else output.push(line)
            continue
        }
        if (starts) {
            output.push(...candidate)
            candidate = [line]
            continue
        }
        candidate.push(line)
        if (/^RuntimeError:\s*Event loop is closed$/i.test(value)) {
            candidate = undefined
        } else if (candidate.length > 200) {
            output.push(...candidate)
            candidate = undefined
        }
    }
    if (candidate) output.push(...candidate)
    return output.join('\n')
}

export function extractHermesSessionId(stderr: string) {
    let sessionId: string | undefined
    for (const line of stderr.split(/\r?\n/)) {
        const match = stripAnsi(line).match(/^session_id:\s*(\S+)\s*$/i)
        if (match) sessionId = match[1]
    }
    return sessionId
}

export function mergeHermesOutput(stdout: string, stderr: string) {
    const out = stdout.trim()
    const err = stderr.trim()
    if (!out) return err
    if (!err) return out
    if (out.includes(err)) return out
    if (err.includes(out)) return err
    return `${err}\n${out}`
}

function providerSessionId(state: DelegateOptions['providerState']) {
    return typeof state?.sessionId === 'string' && state.sessionId.trim()
        ? state.sessionId.trim()
        : undefined
}

const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g

function stripAnsi(value: string) {
    return value.replace(ANSI_ESCAPE, '')
}
