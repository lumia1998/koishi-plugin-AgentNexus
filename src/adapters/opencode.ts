import { CodeAgentAdapter, parseJsonLines, type DelegateOptions } from './base'
import { quoteShell } from '../utils/shell'

export class OpenCodeAdapter extends CodeAgentAdapter {
    readonly kind = 'opencode' as const
    readonly binNames = ['opencode']

    skillDirs(home: string) {
        return [
            `${home}/.config/opencode/skills`,
            `${home}/.opencode/skills`,
            `${home}/.claude/skills`
        ]
    }

    buildInnerCommand(promptExpr: string, options: DelegateOptions) {
        const parts = ['opencode', 'run', '--format', 'json']
        if (options.runtime.opencodeAuto) parts.push('--auto')
        if (options.model) parts.push('-m', quoteShell(options.model))
        parts.push(promptExpr)
        return parts.join(' ')
    }

    protected parseText(stdout: string, stderr: string) {
        return parseJsonLines(stdout) || stdout.trim() || stderr.trim()
    }
}
