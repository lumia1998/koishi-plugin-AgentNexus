import { Context, h, type Session } from 'koishi'
import type { AgentNexusService } from './service'
import type { AgentKind, PublishResult } from './types'
import type { Config } from './config'
import { getErrorMessage } from './utils/shell'
import { splitMessage } from './utils/text'
import { routeCommandHost } from './utils/config'

const COMMANDS: Array<[name: string, agent: AgentKind, description: string]> = [
    ['nexus.hermes', 'hermes', '直接调用远端 Hermes Code Agent'],
    ['nexus.openclaw', 'openclaw', '直接调用远端 OpenClaw Code Agent'],
    ['nexus.claudecode', 'claude', '直接调用远端 Claude Code'],
    ['nexus.opencode', 'opencode', '直接调用远端 OpenCode'],
    ['nexus.codex', 'codex', '直接调用远端 Codex']
]

export function registerNexusCommands(
    ctx: Context,
    nexus: AgentNexusService,
    config: Config
) {
    const active = new Map<string, Set<AbortController>>()
    ctx.on('dispose', () => {
        for (const tasks of active.values()) {
            for (const controller of tasks) controller.abort()
        }
        active.clear()
    })

    for (const [name, agent, description] of COMMANDS) {
        const command = ctx
            .command(`${name} <prompt:text>`, description, {
                authority: config.commandAuthority
            })
            .option('host', '-H <host:string> 指定 SSH 主机 ID、地址或名称')
            .option('cwd', '-C <cwd:string> 指定远端工作目录')
            .option('model', '-m <model:string> 指定模型')
            .option('timeout', '-t <seconds:posint> 超时时间（秒）')
            .option('openclawAgent', '-a <name:string> OpenClaw Agent 名称')
            .check(({ session }) => checkAccess(session, config))
            .action(async ({ session, options }, prompt) => {
                if (!session) return '当前会话不可用。'
                let route: ReturnType<typeof routeCommandHost>
                try {
                    route = routeCommandHost(nexus.getConfig().hosts, prompt, options?.host)
                } catch (err) {
                    return getErrorMessage(err)
                }
                const key = `${session.platform}:${session.userId}`
                const tasks = active.get(key) || new Set<AbortController>()
                if (tasks.size >= config.maxConcurrentPerUser) {
                    return `你已有 ${tasks.size} 个 Agent 任务正在执行，请先等待或使用 nexus.cancel。`
                }
                const controller = new AbortController()
                tasks.add(controller)
                active.set(key, tasks)
                await session.send(`正在调用 ${agent}，使用 nexus.cancel 可中止任务。`)
                try {
                    await executeNexusCommand(nexus, session, agent, route.prompt, {
                        hostId: route.hostId,
                        cwd: options?.cwd,
                        model: options?.model,
                        timeoutMs: options?.timeout ? options.timeout * 1000 : undefined,
                        openclawAgent: options?.openclawAgent,
                        signal: controller.signal
                    })
                } finally {
                    tasks.delete(controller)
                    if (!tasks.size) active.delete(key)
                }
            })

        if (name === 'nexus.claudecode') command.alias('nexus.claude')
    }

    ctx.command('nexus.cancel', '中止当前用户正在执行的 Agent 任务', {
        authority: config.commandAuthority
    }).check(({ session }) => checkAccess(session, config)).action(({ session }) => {
        if (!session) return '当前会话不可用。'
        const tasks = active.get(`${session.platform}:${session.userId}`)
        if (!tasks?.size) return '当前没有正在执行的 Agent 任务。'
        for (const controller of tasks) controller.abort()
        return `已请求中止 ${tasks.size} 个 Agent 任务。`
    })
}

function checkAccess(session: Session | undefined, config: Config) {
    if (!session) return '当前会话不可用。'
    if (
        config.commandUsers.length &&
        !config.commandUsers.includes(session.userId || '')
    ) {
        return '你不在 AgentNexus 命令用户白名单中。'
    }
    if (
        config.commandChannels.length &&
        !config.commandChannels.includes(session.channelId || '')
    ) {
        return '当前频道不允许使用 AgentNexus 命令。'
    }
}

export async function executeNexusCommand(
    nexus: AgentNexusService,
    session: Session,
    agent: AgentKind,
    prompt: string,
    options: {
        hostId?: string
        cwd?: string
        model?: string
        timeoutMs?: number
        openclawAgent?: string
        signal?: AbortSignal
    } = {}
) {
    try {
        const result = await nexus.delegate({
            agent,
            prompt,
            publishFiles: true,
            ...options
        })

        const text = result.text.trim()
        if (text) {
            for (const chunk of splitMessage(text)) {
                await session.send(h.text(chunk))
            }
        } else {
            const status = result.timedOut
                ? `${agent} 执行超时。`
                : `${agent} 执行完成，没有返回文本。`
            await session.send(status)
        }

        for (const file of result.published || []) {
            await sendPublishedFile(session, file)
        }

        if (result.files.length && !result.published?.length) {
            await session.send('Agent 返回了文件路径，但文件未能发布。')
        }

        if (result.exitCode !== 0 && !result.timedOut) {
            await session.send(`${agent} 退出码：${result.exitCode}`)
        }
        if (result.truncated) {
            await session.send('Agent 输出超过捕获上限，以上内容已截断。')
        }
    } catch (err) {
        await session.send(`AgentNexus 调用失败：${getErrorMessage(err)}`)
    }
}

async function sendPublishedFile(session: Session, file: PublishResult) {
    if (!file.url) {
        await session.send(`文件 ${file.name} 发送失败：${file.error || '未知错误'}`)
        return
    }

    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name)) {
        await session.send(h.image(file.url, { title: file.name }))
    } else {
        await session.send(h.file(file.url, { filename: file.name }))
    }
}
