import { CodeAgentAdapter, type DelegateOptions } from './base'
import { quoteShell } from '../utils/shell'

export class ClaudeAdapter extends CodeAgentAdapter {
    readonly kind = 'claude' as const
    readonly binNames = ['claude']

    skillDirs(home: string) {
        return [`${home}/.claude/skills`]
    }

    buildInnerCommand(promptExpr: string, options: DelegateOptions) {
        const parts = [
            this.executable(options, 'claude'),
            '-p',
            promptExpr,
            '--output-format',
            'json',
            '--no-session-persistence'
        ]
        if (options.model) {
            parts.push('--model', quoteShell(options.model))
        }
        if (options.runtime.claudeSkipPermissions) {
            parts.push('--dangerously-skip-permissions')
        }
        return parts.join(' ')
    }
}
