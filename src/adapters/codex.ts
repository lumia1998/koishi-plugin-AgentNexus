import { CodeAgentAdapter, type DelegateOptions } from './base'
import { quoteShell } from '../utils/shell'

export class CodexAdapter extends CodeAgentAdapter {
    readonly kind = 'codex' as const
    readonly binNames = ['codex']

    skillDirs(home: string) {
        return [`${home}/.codex/skills`, `${home}/.agents/skills`]
    }

    buildInnerCommand(promptExpr: string, options: DelegateOptions) {
        const parts = ['codex', 'exec', '--json', '--ephemeral', '--skip-git-repo-check']
        if (options.cwd) {
            parts.push('-C', quoteShell(options.cwd))
        }
        if (options.model) {
            parts.push('-m', quoteShell(options.model))
        }
        if (options.runtime.codexBypassSandbox) {
            parts.push('--dangerously-bypass-approvals-and-sandbox')
        }
        parts.push(promptExpr)
        return parts.join(' ')
    }

    protected parseText(stdout: string, stderr: string) {
        const text = stdout
            .split(/\r?\n/)
            .map((line) => {
                try {
                    const event = JSON.parse(line)
                    return event?.type === 'item.completed' &&
                        event?.item?.type === 'agent_message' &&
                        typeof event.item.text === 'string'
                        ? event.item.text
                        : ''
                } catch {
                    return ''
                }
            })
            .filter(Boolean)
            .join('\n')
        return text || stdout.trim() || stderr.trim()
    }
}
