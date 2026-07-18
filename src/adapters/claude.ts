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
            'json'
        ]
        const sessionId = providerSessionId(options.providerState)
        if (options.sessionMode === 'managed') {
            if (sessionId) parts.push('--resume', quoteShell(sessionId))
            parts.push('--append-system-prompt', quoteShell(NEXUS_SYSTEM_PROMPT))
        } else {
            parts.push('--no-session-persistence')
        }
        if (options.model) {
            parts.push('--model', quoteShell(options.model))
        }
        if (options.runtime.claudeSkipPermissions) {
            parts.push('--dangerously-skip-permissions')
        }
        return parts.join(' ')
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
        if (!command.includes('--no-session-persistence')) {
            try {
                const value = JSON.parse(stdout)
                const sessionId =
                    typeof value?.session_id === 'string'
                        ? value.session_id.trim()
                        : ''
                if (sessionId) result.providerState = { sessionId }
            } catch {}
        }
        return result
    }
}

const NEXUS_SYSTEM_PROMPT =
    'You are connected through AgentNexus. Continue the current user task across turns. If you need user input or confirmation, append a <nexus_session> JSON block with status waiting_input or waiting_confirm, a prompt, and optional options/data. Otherwise answer normally.'

function providerSessionId(state: DelegateOptions['providerState']) {
    return typeof state?.sessionId === 'string' && state.sessionId.trim()
        ? state.sessionId.trim()
        : undefined
}
