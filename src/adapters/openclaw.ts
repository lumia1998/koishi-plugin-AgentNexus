import { CodeAgentAdapter, type DelegateOptions } from './base'
import { quoteShell } from '../utils/shell'

export class OpenClawAdapter extends CodeAgentAdapter {
    readonly kind = 'openclaw' as const
    readonly binNames = ['openclaw']

    skillDirs(home: string) {
        return [`${home}/.openclaw/skills`, `${home}/.openclaw/workspace/skills`]
    }

    buildInnerCommand(promptExpr: string, options: DelegateOptions) {
        const agent = options.openclawAgent || options.runtime.openclawAgent || 'default'
        const executable = this.executable(options, 'openclaw')
        return `${executable} agent --local --agent ${quoteShell(agent)} --message ${promptExpr} --json`
    }

    protected parseText(stdout: string, stderr: string) {
        const out = stdout.trim()
        if (!out) return stderr.trim()
        try {
            const json = JSON.parse(out)
            const text = json?.payloads
                ?.map((item: any) => item?.text)
                .filter((item: unknown): item is string => typeof item === 'string')
                .join('\n')
            return text || out
        } catch {
            return out
        }
    }
}
