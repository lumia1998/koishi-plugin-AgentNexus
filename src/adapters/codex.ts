import { CodeAgentAdapter, parseJsonLines, type DelegateOptions } from './base'
import { quoteShell } from '../utils/shell'

export class CodexAdapter extends CodeAgentAdapter {
    readonly kind = 'codex' as const
    readonly binNames = ['codex']

    skillDirs(home: string) {
        return [`${home}/.codex/skills`, `${home}/.agents/skills`]
    }

    buildInnerCommand(promptExpr: string, options: DelegateOptions) {
        const parts = ['codex', 'exec', '--json', '--skip-git-repo-check']
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
        return parseJsonLines(stdout) || stdout.trim() || stderr.trim()
    }
}
