import type { IncomingMessage } from 'http'
import type { WebSocket } from 'ws'
import type { Context } from 'koishi'
import type { AgentNexusService } from './service'

export class NexusTerminalProxy {
    private layer?: { close(): void }
    private sockets = new Set<WebSocket>()

    constructor(
        private ctx: Context,
        private service: AgentNexusService
    ) {}

    start() {
        if (!this.ctx.server) return

        this.layer = this.ctx.server.ws(
            /^\/agent-nexus\/terminal\/([^/?]+)\/([^/?]+)(?:\?.*)?$/,
            (socket, request) => {
                this.accept(socket, request).catch(() => {
                    try {
                        socket.close()
                    } catch {}
                })
            }
        )
    }

    stop() {
        this.layer?.close()
        this.layer = undefined
        for (const socket of this.sockets) {
            try {
                socket.close()
            } catch {}
        }
        this.sockets.clear()
    }

    private async accept(socket: WebSocket, request: IncomingMessage) {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const parts = url.pathname.split('/')
        const sessionId = parts[3]
        const terminalId = parts[4]
        const token = url.searchParams.get('token') || ''

        const origin = request.headers.origin
        const host = request.headers.host
        if (origin && host && new URL(origin).host !== host) {
            socket.close()
            return
        }

        const item = this.service.claimTerminal(sessionId, terminalId, token)
        if (!item) {
            socket.close()
            return
        }
        this.sockets.add(socket)

        let cleaned = false
        let offData: () => void = () => undefined
        let offTerminalClose: () => void = () => undefined
        const cleanup = () => {
            if (cleaned) return
            cleaned = true
            offData()
            offTerminalClose()
            this.sockets.delete(socket)
            this.service.handleTerminalClose(sessionId, terminalId)
        }

        socket.once('close', cleanup)
        socket.once('error', cleanup)
        offTerminalClose = item.terminal.onClose(() => {
            cleanup()
            try {
                socket.close()
            } catch {}
        })
        offData = item.terminal.onData((data) => {
            if (socket.readyState !== socket.OPEN) return
            if (socket.bufferedAmount > 2 * 1024 * 1024) {
                item.terminal.kill()
                socket.close(1013, 'terminal output backpressure limit exceeded')
                return
            }
            socket.send(JSON.stringify({ type: 'data', data }), (err) => {
                if (err) cleanup()
            })
        })

        socket.on('message', (chunk) => {
            if (terminalMessageSize(chunk) > 64 * 1024) {
                socket.close(1009, 'terminal message too large')
                return
            }
            const text = Buffer.isBuffer(chunk)
                ? chunk.toString('utf8')
                : String(chunk)
            try {
                const msg = JSON.parse(text)
                if (msg.type === 'input') {
                    const data = String(msg.data ?? '')
                    if (Buffer.byteLength(data) <= 64 * 1024) {
                        item.terminal.sendInput(data)
                    }
                    return
                }
                if (msg.type === 'resize') {
                    const cols = Math.min(500, Math.max(2, Number(msg.cols) || 80))
                    const rows = Math.min(300, Math.max(1, Number(msg.rows) || 24))
                    item.terminal.resize(cols, rows)
                    return
                }
                if (msg.type === 'kill') {
                    item.terminal.kill()
                }
            } catch {
                item.terminal.sendInput(text)
            }
        })
    }
}

export function terminalMessageSize(chunk: unknown) {
    if (Buffer.isBuffer(chunk)) return chunk.length
    if (chunk instanceof ArrayBuffer) return chunk.byteLength
    if (Array.isArray(chunk)) {
        return chunk.reduce((size, item) => size + terminalMessageSize(item), 0)
    }
    return Buffer.byteLength(String(chunk))
}
