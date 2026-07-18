import type {
    AgentKind,
    AgentArtifact,
    AgentProviderState,
    AgentResult,
    AgentRuntimeOptions
} from '../types'
import type { SshSession } from '../ssh/session'
import { wrapPromptCommand } from '../utils/shell'

export interface DelegateOptions {
    prompt: string
    cwd?: string
    model?: string
    timeoutMs?: number
    openclawAgent?: string
    runtime: AgentRuntimeOptions
    sessionMode?: 'oneshot' | 'managed'
    providerState?: AgentProviderState
    executablePath?: string
}

export abstract class CodeAgentAdapter {
    abstract readonly kind: AgentKind
    abstract readonly binNames: string[]

    abstract skillDirs(home: string): string[]

    abstract buildInnerCommand(
        promptExpr: string,
        options: DelegateOptions
    ): string

    protected executable(options: DelegateOptions, fallback: string) {
        return options.executablePath
            ? shellQuote(options.executablePath)
            : fallback
    }

    async detect(session: SshSession) {
        for (const bin of this.binNames) {
            if (!/^[A-Za-z0-9._+-]+$/.test(bin)) continue
            const which = await session.exec(buildDetectCommand(bin), {
                timeoutMs: 12000
            })
            const path = pickExecutablePath(which.stdout)
            if (!path) continue
            const executablePath = path.startsWith('~/')
                ? session.resolveRemotePath(path)
                : path

            const ver = await session.exec(
                `${shellQuote(executablePath)} --version 2>/dev/null | head -n 1`,
                { timeoutMs: 8000 }
            )
            return {
                kind: this.kind,
                installed: true,
                path: executablePath,
                version: ver.stdout.trim() || undefined,
                skillDirs: this.skillDirs('~')
            }
        }

        return {
            kind: this.kind,
            installed: false,
            skillDirs: this.skillDirs('~')
        }
    }

    buildCommand(options: DelegateOptions): string {
        return wrapPromptCommand(
            (promptExpr) => this.buildInnerCommand(promptExpr, options),
            options.prompt
        )
    }

    parseResult(
        stdout: string,
        stderr: string,
        exitCode: number,
        timedOut: boolean,
        command: string
    ): AgentResult {
        const source = stdout + '\n' + stderr
        const artifacts = extractArtifacts(source)
        const files = Array.from(
            new Set([
                ...extractPaths(source),
                ...artifacts.map((artifact) => artifact.path)
            ])
        ).slice(0, 20)
        const text = formatArtifactReply(
            cleanAgentText(this.parseText(stdout, stderr), artifacts),
            artifacts
        )
        const images = files.filter((p) =>
            /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p)
        )
        return {
            agent: this.kind,
            text,
            files,
            images,
            artifacts: artifacts.length ? artifacts : undefined,
            raw: stdout || stderr,
            exitCode,
            timedOut,
            command
        }
    }

    protected parseText(stdout: string, stderr: string) {
        return pickText(stdout, stderr)
    }
}

function pickText(stdout: string, stderr: string) {
    const out = stdout.trim()
    if (!out) return stderr.trim()

    // try JSON result shapes (claude / opencode)
    try {
        const json = JSON.parse(out)
        if (typeof json === 'string') return json
        if (typeof json?.result === 'string') return json.result
        if (typeof json?.content === 'string') return json.content
        if (Array.isArray(json?.content)) {
            return json.content
                .map((item: any) =>
                    typeof item === 'string'
                        ? item
                        : item?.text || item?.content || ''
                )
                .filter(Boolean)
                .join('\n')
        }
        if (typeof json?.message?.content === 'string') {
            return json.message.content
        }
    } catch {}

    return out
}

export function cleanAgentText(
    text: string,
    artifacts: AgentArtifact[] = []
) {
    return text
        .replace(/<nexus_files>[\s\S]*?<\/nexus_files>/gi, '')
        .split(/\r?\n/)
        .filter(
            (line) =>
                !artifacts.length || !ARTIFACT_LINE.test(line.trim())
        )
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

const ARTIFACT_LINE = /^(?:pdf_path|file_path|pdf_size|file_size|pdf_password|password|manga|title|漫画|文件大小|文件密码|解压密码)\s*[:=]/i

export function extractArtifacts(text: string): AgentArtifact[] {
    const artifacts: AgentArtifact[] = []
    let current: Partial<AgentArtifact> | undefined
    const flush = () => {
        if (current?.path && isLocalPath(current.path)) {
            artifacts.push(current as AgentArtifact)
        }
        current = undefined
    }
    for (const line of text.split(/\r?\n/)) {
        const match = line
            .trim()
            .match(/^(pdf_path|file_path|pdf_size|file_size|pdf_password|password|manga|title|漫画|文件大小|文件密码|解压密码)\s*[:=]\s*(.*)$/i)
        if (!match) continue
        const key = match[1].toLowerCase()
        const value = match[2].trim()
        if (key === 'pdf_path' || key === 'file_path') {
            flush()
            current = { path: value }
            continue
        }
        current ??= {}
        if (
            key === 'pdf_size' ||
            key === 'file_size' ||
            key === '文件大小'
        ) {
            current.size = value
        } else if (
            key === 'pdf_password' ||
            key === 'password' ||
            key === '文件密码' ||
            key === '解压密码'
        ) {
            current.password = value
        } else if (key === 'manga' || key === 'title' || key === '漫画') {
            current.title = value
        }
    }
    flush()
    return artifacts
}

function formatArtifactReply(text: string, artifacts: AgentArtifact[]) {
    const details: string[] = []
    for (const artifact of artifacts) {
        if (artifact.title && !text.includes(artifact.title)) {
            details.push(`漫画：${artifact.title}`)
        }
        if (artifact.size && !text.includes(artifact.size)) {
            details.push(`文件大小：${artifact.size}`)
        }
        if (
            artifact.password !== undefined &&
            (!artifact.password || !text.includes(artifact.password))
        ) {
            details.push(
                `解压密码：${artifact.password || 'Skill 未返回密码'}`
            )
        }
    }
    return [text, ...details].filter(Boolean).join('\n')
}

const FILE_EXT =
    /\.(png|jpe?g|gif|webp|bmp|svg|pdf|zip|tar|gz|tgz|csv|json|md|txt|html?|xml|xlsx?|docx?|pptx?|py|ts|js|mjs|cjs|go|rs|java|kt|swift|rb|php|sh|yml|yaml|toml|log|mp4|webm|mp3|wav)$/i

export function extractPaths(text: string): string[] {
    const found = new Set<string>()

    const blocks = text.matchAll(/<nexus_files>([\s\S]*?)<\/nexus_files>/gi)
    for (const block of blocks) {
        for (const line of block[1].split(/\r?\n/)) {
            const p = artifactPath(line.trim()) ?? line.trim()
            if (isLocalPath(p)) found.add(p)
        }
    }

    for (const artifact of extractArtifacts(text)) found.add(artifact.path)

    const md = text.matchAll(/!?\[[^\]]*]\(([^)\s]+)\)/g)
    for (const item of md) {
        const p = item[1]
        if (isLocalPath(p) && FILE_EXT.test(p)) {
            found.add(p)
        }
    }

    return Array.from(found).slice(0, 20)
}

function artifactPath(value: string) {
    const match = value.match(/^(?:pdf_path|file_path)\s*[:=]\s*(.+)$/i)
    return match?.[1].trim()
}

function isLocalPath(value: string) {
    return (
        !/^https?:\/\//i.test(value) &&
        (value.startsWith('/') || value.startsWith('./') || value.startsWith('~/'))
    )
}

function shellQuote(value: string) {
    return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Prefer login PATH + common user install locations for CLI tools like hermes. */
function buildDetectCommand(bin: string) {
    const q = shellQuote(bin)
    return [
        `bin=${q};`,
        `found="";`,
        // 1) current PATH (already enriched by SSH session)
        `found=$(command -v "$bin" 2>/dev/null || true);`,
        // 2) login/profile PATH (nvm, pyenv, user bins often missing in non-interactive shells)
        `if [ -z "$found" ]; then`,
        `  found=$(bash -lc 'command -v '"$bin"' 2>/dev/null' 2>/dev/null || true);`,
        `fi;`,
        // 3) well-known install prefixes
        `if [ -z "$found" ]; then`,
        `  for d in`,
        `    "$HOME/.local/bin"`,
        `    "$HOME/.hermes/bin"`,
        `    "$HOME/.openclaw/bin"`,
        `    "$HOME/.cargo/bin"`,
        `    "$HOME/.npm-global/bin"`,
        `    "$HOME/go/bin"`,
        `    "$HOME/.opencode/bin"`,
        `    "$HOME/.claude/bin"`,
        `    "$HOME/.codex/bin"`,
        `    "$HOME/bin"`,
        `    /usr/local/bin`,
        `    /opt/homebrew/bin`,
        `    /home/linuxbrew/.linuxbrew/bin;`,
        `  do`,
        `    if [ -x "$d/$bin" ]; then found="$d/$bin"; break; fi;`,
        `  done;`,
        `fi;`,
        // 4) python user scripts / pipx
        `if [ -z "$found" ]; then`,
        `  for d in "$HOME/.local/pipx/venvs"/*"/bin" "$HOME/.pyenv/shims"; do`,
        `    if [ -x "$d/$bin" ]; then found="$d/$bin"; break; fi;`,
        `  done;`,
        `fi;`,
        `printf '%s\\n' "$found"`
    ].join(' ')
}

function pickExecutablePath(stdout: string) {
    for (const line of stdout.split(/\r?\n/)) {
        const value = line.trim()
        if (!value) continue
        if (value.startsWith('/') || value.startsWith('~/')) return value
    }
    return ''
}

export function parseJsonLines(text: string) {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
            try {
                const value = JSON.parse(line)
                return collectText(value)
            } catch {
                return []
            }
        })
        .filter(Boolean)
        .join('\n')
}

function collectText(value: any): string[] {
    if (typeof value === 'string') return [value]
    if (!value || typeof value !== 'object') return []
    if (typeof value.result === 'string') return [value.result]
    if (typeof value.content === 'string') return [value.content]
    if (typeof value.text === 'string') return [value.text]
    if (typeof value.message?.content === 'string') return [value.message.content]
    if (Array.isArray(value.content)) return value.content.flatMap(collectText)
    if (Array.isArray(value.parts)) return value.parts.flatMap(collectText)
    if (value.item) return collectText(value.item)
    if (value.part) return collectText(value.part)
    if (value.data) return collectText(value.data)
    return []
}
