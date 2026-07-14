import type { NexusConfig, SshAuth, SshHostConfig } from '../types'
import { randomUUID } from 'crypto'

export function mergeHostSecrets(
    incoming: SshHostConfig,
    previous?: SshHostConfig
): SshHostConfig {
    if (!previous) return incoming

    if (!incoming.auth || isEmptyAuth(incoming.auth)) {
        return {
            ...incoming,
            auth: previous.auth
        }
    }

    if (incoming.auth.type !== previous.auth.type) return incoming

    if (incoming.auth.type === 'password' && previous.auth.type === 'password') {
        return {
            ...incoming,
            auth: {
                type: 'password',
                password: incoming.auth.password || previous.auth.password
            }
        }
    }

    if (incoming.auth.type === 'key' && previous.auth.type === 'key') {
        return {
            ...incoming,
            auth: {
                type: 'key',
                privateKey: incoming.auth.privateKey || previous.auth.privateKey,
                passphrase: incoming.auth.passphrase || previous.auth.passphrase
            }
        }
    }

    return incoming
}

function isEmptyAuth(auth: SshAuth) {
    if (auth.type === 'password') return !auth.password
    return !auth.privateKey
}

export function redactNexusConfig(config: NexusConfig): NexusConfig {
    return {
        ...config,
        hosts: config.hosts.map((host) => ({
            ...host,
            auth:
                host.auth.type === 'password'
                    ? { type: 'password', password: '' }
                    : { type: 'key', privateKey: '' }
        }))
    }
}

export function hostConnectionChanged(previous: SshHostConfig, next: SshHostConfig) {
    return (
        previous.host !== next.host ||
        previous.port !== next.port ||
        previous.username !== next.username ||
        previous.enabled !== next.enabled ||
        JSON.stringify(previous.auth) !== JSON.stringify(next.auth)
    )
}

export function repairHostIds(hosts: SshHostConfig[]) {
    const seen = new Set<string>()
    let changed = false
    const repaired = hosts.map((host) => {
        if (host.id && !seen.has(host.id)) {
            seen.add(host.id)
            return host
        }
        changed = true
        const id = randomUUID()
        seen.add(id)
        return { ...host, id }
    })
    return { hosts: repaired, changed }
}

export function normalizeHostName(name: string) {
    return name.trim()
}

export function assertUniqueHostName(
    hosts: SshHostConfig[],
    name: string,
    excludeId?: string
) {
    const normalized = normalizeHostName(name)
    if (!normalized) throw new Error('设备名称不能为空')
    const conflict = hosts.find(
        (host) =>
            host.id !== excludeId &&
            normalizeHostName(host.name).toLowerCase() === normalized.toLowerCase()
    )
    if (conflict) {
        throw new Error(`设备名称“${normalized}”已存在，请换一个唯一名称`)
    }
    return normalized
}

export function patchHostConfig(
    previous: SshHostConfig,
    input: Partial<SshHostConfig>
): SshHostConfig {
    const next: SshHostConfig = {
        ...previous,
        ...input,
        id: previous.id,
        auth: previous.auth
    }

    if (input.auth) {
        if (isEmptyAuth(input.auth) && input.auth.type === previous.auth.type) {
            next.auth = previous.auth
        } else if (isEmptyAuth(input.auth) && input.auth.type !== previous.auth.type) {
            // switching type with empty secret is invalid; keep previous
            next.auth = previous.auth
        } else {
            next.auth = input.auth
        }
    }

    return mergeHostSecrets(next, previous)
}

export function resolveHostReference(hosts: SshHostConfig[], reference: string) {
    const idMatch = hosts.find((host) => host.id === reference)
    if (idMatch) return idMatch

    const value = reference.trim().toLowerCase()
    const matches = hosts.filter((host) => {
        const address = host.host.toLowerCase()
        const name = host.name.toLowerCase()
        const port = host.port || 22
        const user = host.username.toLowerCase()
        return (
            name === value ||
            address === value ||
            `${address}:${port}` === value ||
            `${user}@${address}` === value ||
            `${user}@${address}:${port}` === value
        )
    })

    if (matches.length > 1) {
        throw new Error(`设备引用“${reference}”有歧义，请使用设备 ID。`)
    }
    return matches[0]
}

export function routeCommandHost(
    hosts: SshHostConfig[],
    prompt: string,
    reference?: string
) {
    const enabled = hosts.filter((host) => host.enabled)
    if (!enabled.length) throw new Error('No enabled SSH host configured.')

    if (reference) {
        const host = resolveHostReference(enabled, reference)
        if (!host) throw new Error(`Host not found: ${reference}`)
        return { hostId: host.id, prompt }
    }

    if (enabled.length === 1) return { hostId: enabled[0].id, prompt }

    const value = prompt.trimStart()
    const matches = enabled
        .map((host) => ({ host, name: normalizeHostName(host.name) }))
        .filter(({ name }) => {
            if (!name) return false
            return (
                value.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0 ||
                value.toLocaleLowerCase().startsWith(`${name.toLocaleLowerCase()} `)
            )
        })
        .sort((a, b) => b.name.length - a.name.length)

    if (!matches.length) {
        throw new Error(
            `已配置多台设备，请在任务前指定设备名称：${enabled.map((host) => host.name).join('、')}`
        )
    }

    // longest name wins; if two equal-length names both match (duplicate names), reject
    const best = matches[0]
    const tied = matches.filter((item) => item.name.length === best.name.length)
    if (tied.length > 1) {
        throw new Error('设备名称重复，请使用 -H 指定设备 ID。')
    }

    const task = value.slice(best.name.length).trimStart()
    if (!task) throw new Error(`请在设备名称 ${best.name} 后填写任务内容。`)
    return { hostId: best.host.id, prompt: task }
}
