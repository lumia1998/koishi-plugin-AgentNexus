import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'
import { randomUUID } from 'crypto'
import { Readable } from 'stream'
import type { ExecResult, SshHostConfig } from '../types'
import { resolveSecret } from '../utils/shell'
import { mimeType } from '../utils/mime'

export interface TerminalHandle {
    id: string
    onData(cb: (data: string) => void): () => void
    onClose(cb: () => void): () => void
    sendInput(data: string): void
    resize(cols: number, rows: number): void
    kill(): void
}

export class SshSession {
    readonly sessionId = randomUUID()
    readonly hostId: string
    private client = new Client()
    private connected = false
    private home = '~'
    private path = '/usr/local/bin:/usr/bin:/bin'
    private sftp?: SFTPWrapper
    private connecting?: Promise<void>
    private cancelConnecting?: (error: Error) => void
    private sftpConnecting?: Promise<SFTPWrapper>
    private activeOperations = 0
    private connectionGeneration = 0
    lastError?: string
    lastConnectedAt?: number
    lastActiveAt = Date.now()

    constructor(
        public readonly host: SshHostConfig,
        private readonly maxOutputBytes = 4 * 1024 * 1024
    ) {
        this.hostId = host.id
    }

    get cwd() {
        return this.host.cwd || this.home
    }

    isConnected() {
        return this.connected
    }

    isConnecting() {
        return !!this.connecting
    }

    hasActiveOperations() {
        return this.activeOperations > 0
    }

    touch() {
        this.lastActiveAt = Date.now()
    }

    async connect(): Promise<void> {
        if (this.connected) return
        if (this.connecting) return this.connecting

        const generation = ++this.connectionGeneration
        const client = new Client()
        this.client = client
        const isCurrent = () =>
            this.connectionGeneration === generation && this.client === client
        let task: Promise<void>
        task = new Promise<void>((resolve, reject) => {
            const cancel = (error: Error) => reject(error)
            this.cancelConnecting = cancel
            const auth = this.host.auth
            const config: Record<string, unknown> = {
                host: this.host.host,
                port: this.host.port || 22,
                username: this.host.username,
                readyTimeout: 20000,
                keepaliveInterval: 15000
            }

            if (auth.type === 'password') {
                config.password = resolveSecret(auth.password)
            } else {
                config.privateKey = resolveSecret(auth.privateKey)
                if (auth.passphrase) {
                    config.passphrase = resolveSecret(auth.passphrase)
                }
            }

            client
                .on('ready', () => {
                    if (!isCurrent()) {
                        client.end()
                        return
                    }
                    this.connected = true
                    this.lastError = undefined
                    this.lastConnectedAt = Date.now()
                    this.touch()
                    this.rawExec(PROBE_ENV_COMMAND, 10000, undefined, client)
                        .then((result) => {
                            if (!isCurrent()) return reject(new Error('SSH connection superseded'))
                            const lines = result.stdout.trim().split('\n')
                            const home = lines[0] || '~'
                            const path = lines[1] || this.path
                            this.home = home
                            this.path = enrichPath(path, home)
                            resolve()
                        })
                        .catch((err) => {
                            if (!isCurrent()) return reject(err)
                            this.connected = false
                            this.lastError = errorMessage(err)
                            client.end()
                            reject(err)
                        })
                })
                .on('error', (err) => {
                    if (!isCurrent()) return
                    this.connected = false
                    this.sftp = undefined
                    this.sftpConnecting = undefined
                    this.lastError = err.message
                    reject(err)
                })
                .on('end', () => {
                    if (!isCurrent()) return
                    this.connected = false
                    this.sftp = undefined
                    this.sftpConnecting = undefined
                })
                .on('close', () => {
                    if (!isCurrent()) return
                    this.connected = false
                    this.sftp = undefined
                    this.sftpConnecting = undefined
                })
                .connect(config as any)
        }).finally(() => {
            if (this.connecting === task) this.connecting = undefined
            this.cancelConnecting = undefined
        })

        this.connecting = task
        return task
    }

    async disconnect(): Promise<void> {
        const cancelConnecting = this.cancelConnecting
        this.connectionGeneration += 1
        const client = this.client
        this.connected = false
        this.sftp = undefined
        this.sftpConnecting = undefined
        client.end()
        cancelConnecting?.(new Error('SSH connection closed'))
    }

    async exec(
        command: string,
        options: {
            cwd?: string
            timeoutMs?: number
            env?: Record<string, string>
            signal?: AbortSignal
        } = {}
    ): Promise<ExecResult> {
        await this.connect()
        this.touch()

        const cwd = options.cwd || this.cwd
        const timeoutMs = options.timeoutMs ?? 120000
        const envPrefix = options.env
            ? Object.entries(options.env)
                  .map(([k, v]) => {
                      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
                          throw new Error(`Invalid environment variable name: ${k}`)
                      }
                      return `export ${k}=${shellPath(v)};`
                  })
                  .join(' ')
            : ''
        const wrapped = `export PATH=${shellPath(this.path)}; cd ${shellPath(cwd)} 2>/dev/null || cd; ${envPrefix}${command}`
        return this.rawExec(wrapped, timeoutMs, options.signal, this.client)
    }

    private rawExec(
        command: string,
        timeoutMs: number,
        abortSignal?: AbortSignal,
        client = this.client
    ): Promise<ExecResult> {
        this.activeOperations += 1
        return new Promise((resolve, reject) => {
            let stdout = ''
            let stderr = ''
            let outputBytes = 0
            let settled = false
            let timedOut = false
            let truncated = false
            let stream: ClientChannel | undefined

            const stop = (timeout: boolean, signal: string) => {
                timedOut = timeout
                try {
                    stream?.signal('KILL')
                    stream?.close()
                } catch {}
                finish(timeout ? 124 : 130, signal)
            }
            const timer = setTimeout(() => stop(true, 'SIGKILL'), timeoutMs)
            const abort = () => stop(false, 'SIGINT')
            abortSignal?.addEventListener('abort', abort, { once: true })

            const finish = (code: number, signal?: string) => {
                if (settled) return
                settled = true
                this.activeOperations -= 1
                clearTimeout(timer)
                abortSignal?.removeEventListener('abort', abort)
                this.touch()
                resolve({
                    exitCode: code ?? (timedOut ? 124 : 1),
                    stdout,
                    stderr,
                    timedOut,
                    signal,
                    truncated
                })
            }
            if (abortSignal?.aborted) abort()

            const append = (current: string, data: Buffer) => {
                const available = this.maxOutputBytes - outputBytes
                if (available <= 0) {
                    truncated = true
                    return current
                }
                const chunk = data.length > available ? data.subarray(0, available) : data
                outputBytes += chunk.length
                if (chunk.length < data.length) truncated = true
                return current + chunk.toString('utf8')
            }

            client.exec(command, (err, ch) => {
                if (settled) {
                    try {
                        ch?.signal('KILL')
                        ch?.close()
                    } catch {}
                    return
                }
                if (err) {
                    clearTimeout(timer)
                    abortSignal?.removeEventListener('abort', abort)
                    settled = true
                    this.activeOperations -= 1
                    reject(err)
                    return
                }
                stream = ch
                ch.on('data', (data: Buffer) => {
                    stdout = append(stdout, data)
                })
                ch.stderr.on('data', (data: Buffer) => {
                    stderr = append(stderr, data)
                })
                ch.on('close', (code: number, signal: string) => {
                    finish(code ?? 0, signal)
                })
            })
        })
    }

    async getSftp(): Promise<SFTPWrapper> {
        await this.connect()
        if (this.sftp) return this.sftp
        if (this.sftpConnecting) return this.sftpConnecting
        const client = this.client
        this.sftpConnecting = new Promise<SFTPWrapper>((resolve, reject) => {
            client.sftp((err, sftp) => {
                if (err) return reject(err)
                if (client !== this.client || !this.connected) {
                    sftp.end()
                    return reject(new Error('SSH connection changed during SFTP initialization'))
                }
                this.sftp = sftp
                const clear = () => {
                    if (this.sftp === sftp) this.sftp = undefined
                }
                sftp.once('close', clear)
                sftp.once('end', clear)
                sftp.once('error', clear)
                resolve(sftp)
            })
        }).finally(() => {
            this.sftpConnecting = undefined
        })
        return this.sftpConnecting
    }

    async readFile(remotePath: string): Promise<Buffer> {
        const sftp = await this.getSftp()
        this.touch()
        return new Promise((resolve, reject) => {
            sftp.readFile(remotePath, (err, data) => {
                if (err) reject(err)
                else resolve(data)
            })
        })
    }

    async openAsset(remotePath: string): Promise<{
        stream: Readable
        size?: number
        mimeType?: string
    }> {
        const sftp = await this.getSftp()
        this.touch()
        const stat = await new Promise<{ size: number }>((resolve, reject) => {
            sftp.stat(remotePath, (err, stats) => {
                if (err) reject(err)
                else resolve({ size: stats.size })
            })
        })
        const stream = sftp.createReadStream(remotePath)
        return {
            stream: stream as unknown as Readable,
            size: stat.size,
            mimeType: mimeType(remotePath)
        }
    }

    async writeFile(remotePath: string, content: Buffer | string): Promise<void> {
        const sftp = await this.getSftp()
        this.touch()
        const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
        await new Promise<void>((resolve, reject) => {
            sftp.writeFile(remotePath, buf, (err) => {
                if (err) reject(err)
                else resolve()
            })
        })
    }

    async createTerminal(options: {
        cols?: number
        rows?: number
        cwd?: string
        timeoutMs?: number
    } = {}): Promise<TerminalHandle> {
        await this.connect()
        this.touch()

        const cols = options.cols ?? 120
        const rows = options.rows ?? 30
        const cwd = options.cwd || this.cwd
        const timeoutMs = options.timeoutMs ?? 20_000
        const client = this.client

        return new Promise((resolve, reject) => {
            let settled = false
            const timer = setTimeout(() => {
                settled = true
                reject(new Error('SSH shell channel creation timed out'))
            }, timeoutMs)

            client.shell(
                { term: 'xterm-256color', cols, rows },
                (err, stream) => {
                    if (settled) {
                        try {
                            stream?.close()
                        } catch {}
                        return
                    }
                    settled = true
                    clearTimeout(timer)
                    if (err) return reject(err)

                    const id = randomUUID()
                    const listeners = new Set<(data: string) => void>()
                    const closeListeners = new Set<() => void>()
                    const touch = () => this.touch()
                    let pending = ''
                    let closed = false
                    this.activeOperations += 1

                    const markClosed = () => {
                        if (closed) return
                        closed = true
                        this.activeOperations -= 1
                        listeners.clear()
                        for (const cb of closeListeners) cb()
                        closeListeners.clear()
                    }

                    stream.write(`export TERM=xterm-256color; cd ${shellPath(cwd)} 2>/dev/null || true\n`)

                    stream.on('data', (chunk: Buffer) => {
                        this.touch()
                        const text = chunk.toString('utf8')
                        if (!listeners.size) {
                            pending = (pending + text).slice(-this.maxOutputBytes)
                        }
                        for (const cb of listeners) cb(text)
                    })

                    stream.on('close', markClosed)
                    stream.on('error', markClosed)

                    resolve({
                        id,
                        onData(cb) {
                            listeners.add(cb)
                            if (pending) {
                                cb(pending)
                                pending = ''
                            }
                            return () => listeners.delete(cb)
                        },
                        onClose(cb) {
                            if (closed) {
                                queueMicrotask(cb)
                                return () => undefined
                            }
                            closeListeners.add(cb)
                            return () => closeListeners.delete(cb)
                        },
                        sendInput(data) {
                            if (!closed) {
                                touch()
                                stream.write(data)
                            }
                        },
                        resize(c, r) {
                            if (!closed) stream.setWindow(r, c, 0, 0)
                        },
                        kill() {
                            if (!closed) {
                                markClosed()
                                stream.close()
                            }
                        }
                    })
                }
            )
        })
    }
}

function shellPath(path: string) {
    return `'${path.replaceAll("'", `'\\''`)}'`
}

function errorMessage(err: unknown) {
    return err instanceof Error ? err.message : String(err)
}

/** Login-ish env probe: many CLIs live only in interactive profile PATH. */
const PROBE_ENV_COMMAND = [
    `bash -lc '`,
    `for f in "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do`,
    `  [ -f "$f" ] && . "$f" >/dev/null 2>&1 || true;`,
    `done;`,
    `printf "%s\\n%s" "$HOME" "$PATH"`,
    `'`
].join(' ')

const EXTRA_PATH_DIRS = [
    '.local/bin',
    '.hermes/bin',
    '.cargo/bin',
    '.npm-global/bin',
    'go/bin',
    '.opencode/bin',
    '.claude/bin',
    '.codex/bin',
    'bin'
]

function enrichPath(pathValue: string, home: string) {
    const parts = pathValue
        .split(':')
        .map((item) => item.trim())
        .filter(Boolean)
    const seen = new Set(parts)
    for (const rel of EXTRA_PATH_DIRS) {
        const dir = home === '~' ? `~/${rel}` : `${home.replace(/\/$/, '')}/${rel}`
        if (!seen.has(dir)) {
            parts.unshift(dir)
            seen.add(dir)
        }
    }
    // Keep system defaults last so user bins win.
    for (const dir of ['/usr/local/bin', '/usr/bin', '/bin']) {
        if (!seen.has(dir)) {
            parts.push(dir)
            seen.add(dir)
        }
    }
    return parts.join(':')
}
