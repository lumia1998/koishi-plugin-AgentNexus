import path from 'path'
import { randomUUID } from 'crypto'
import type { Stats } from 'ssh2'
import type {
    RemoteFileDownload,
    RemoteFileEntry,
    RemoteFileListing,
    RemoteFilePreview,
    RemoteFileType
} from '../types'
import type { SshSession } from '../ssh/session'
import { mimeType } from '../utils/mime'
import { isRemotePathWithinRoot } from '../utils/security'

export interface SftpFileManagerLimits {
    maxUploadBytes: number
    maxPreviewBytes: number
}

export class SftpFileManager {
    private constructor(
        private readonly session: SshSession,
        private readonly hostId: string,
        readonly root: string,
        private readonly limits: SftpFileManagerLimits
    ) {}

    static async create(
        session: SshSession,
        hostId: string,
        requestedRoot: string | undefined,
        limits: SftpFileManagerLimits
    ) {
        const root = await session.realpath(
            session.resolveRemotePath(requestedRoot || session.cwd)
        )
        const stats = await session.stat(root)
        if (!stats.isDirectory()) {
            throw new Error(`文件管理根路径不是目录：${root}`)
        }
        return new SftpFileManager(session, hostId, normalize(root), limits)
    }

    async list(requestedPath?: string): Promise<RemoteFileListing> {
        const directory = await this.resolveExisting(requestedPath || this.root, true)
        const stats = await this.session.stat(directory)
        if (!stats.isDirectory()) throw new Error('目标不是目录')
        const entries = (await this.session.listDirectory(directory))
            .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
            .map<RemoteFileEntry>((entry) => ({
                name: entry.filename,
                path: path.posix.join(directory, entry.filename),
                type: fileType(entry.attrs),
                size: entry.attrs.size,
                modifiedAt: entry.attrs.mtime * 1000,
                mode: entry.attrs.mode
            }))
            .sort((a, b) => {
                const aDirectory = a.type === 'directory' ? 0 : 1
                const bDirectory = b.type === 'directory' ? 0 : 1
                return aDirectory - bDirectory || a.name.localeCompare(b.name)
            })

        return {
            hostId: this.hostId,
            root: this.root,
            path: directory,
            parent:
                directory === this.root
                    ? undefined
                    : boundedParent(directory, this.root),
            entries
        }
    }

    async preview(requestedPath: string): Promise<RemoteFilePreview> {
        const file = await this.resolveExisting(requestedPath, true)
        const stats = await this.session.stat(file)
        if (!stats.isFile()) throw new Error('只能预览普通文件')
        const type = mimeType(file)
        const encoding = previewEncoding(file, type)
        if (encoding === 'none') {
            return {
                hostId: this.hostId,
                path: file,
                name: path.posix.basename(file),
                size: stats.size,
                mimeType: type,
                encoding,
                content: '',
                truncated: false
            }
        }

        const data = await this.session.readFile(
            file,
            this.limits.maxPreviewBytes + 1
        )
        const truncated = stats.size > this.limits.maxPreviewBytes ||
            data.length > this.limits.maxPreviewBytes
        const visible = truncated
            ? data.subarray(0, this.limits.maxPreviewBytes)
            : data
        if (encoding === 'utf8' && visible.includes(0)) {
            return {
                hostId: this.hostId,
                path: file,
                name: path.posix.basename(file),
                size: stats.size,
                mimeType: type,
                encoding: 'none',
                content: '',
                truncated
            }
        }
        return {
            hostId: this.hostId,
            path: file,
            name: path.posix.basename(file),
            size: stats.size,
            mimeType: type,
            encoding,
            content:
                encoding === 'base64'
                    ? visible.toString('base64')
                    : visible.toString('utf8'),
            truncated
        }
    }

    async writeBase64(requestedPath: string, content: string) {
        const estimated = Math.floor((content.length * 3) / 4)
        if (estimated > this.limits.maxUploadBytes + 2) {
            throw new Error(`文件超过上传上限 ${formatBytes(this.limits.maxUploadBytes)}`)
        }
        const data = Buffer.from(content, 'base64')
        if (data.length > this.limits.maxUploadBytes) {
            throw new Error(`文件超过上传上限 ${formatBytes(this.limits.maxUploadBytes)}`)
        }
        const target = await this.resolveTarget(requestedPath)
        if (await this.session.pathExists(target)) {
            const current = await this.session.stat(target, false)
            if (!current.isFile()) throw new Error('只能覆盖普通文件')
        }
        await this.writeAtomically(target, data)
        return target
    }

    async writeText(requestedPath: string, content: string) {
        const data = Buffer.from(content, 'utf8')
        if (data.length > this.limits.maxUploadBytes) {
            throw new Error(`文件超过保存上限 ${formatBytes(this.limits.maxUploadBytes)}`)
        }
        const target = await this.resolveTarget(requestedPath)
        if (await this.session.pathExists(target)) {
            const current = await this.session.stat(target, false)
            if (!current.isFile()) throw new Error('只能保存普通文件')
        }
        await this.writeAtomically(target, data)
        return target
    }

    async createDirectory(parentPath: string, name: string) {
        const safeName = validateFileName(name)
        const parent = await this.resolveExisting(parentPath, true)
        const parentStats = await this.session.stat(parent)
        if (!parentStats.isDirectory()) throw new Error('父路径不是目录')
        const target = path.posix.join(parent, safeName)
        this.assertWithinRoot(target)
        if (await this.session.pathExists(target)) throw new Error('同名文件或目录已存在')
        await this.session.makeDirectory(target)
        return target
    }

    async rename(requestedPath: string, newName: string) {
        const safeName = validateFileName(newName)
        const source = await this.resolveExisting(requestedPath, false)
        this.assertNotRoot(source)
        const target = path.posix.join(path.posix.dirname(source), safeName)
        this.assertWithinRoot(target)
        if (await this.session.pathExists(target)) throw new Error('同名文件或目录已存在')
        await this.session.rename(source, target)
        return target
    }

    async remove(requestedPath: string) {
        const target = await this.resolveExisting(requestedPath, false)
        this.assertNotRoot(target)
        const stats = await this.session.stat(target, false)
        if (stats.isDirectory() && !stats.isSymbolicLink()) {
            await this.session.removeDirectory(target)
        } else {
            await this.session.unlink(target)
        }
    }

    async openDownload(requestedPath: string): Promise<{
        asset: Awaited<ReturnType<SshSession['openAsset']>>
        result: Omit<RemoteFileDownload, 'url'>
    }> {
        const file = await this.resolveExisting(requestedPath, true)
        const stats = await this.session.stat(file)
        if (!stats.isFile()) throw new Error('只能下载普通文件')
        return {
            asset: await this.session.openAsset(file),
            result: {
                hostId: this.hostId,
                path: file,
                name: path.posix.basename(file)
            }
        }
    }

    private async resolveExisting(requestedPath: string, followSymlink: boolean) {
        const candidate = await this.resolveTarget(requestedPath)
        if (candidate === this.root) return this.root
        await this.session.stat(candidate, false)
        if (!followSymlink) return candidate
        const resolved = normalize(await this.session.realpath(candidate))
        this.assertWithinRoot(resolved)
        return resolved
    }

    private async resolveTarget(requestedPath: string) {
        const absolute = this.requestedAbsolute(requestedPath)
        if (absolute === this.root) return this.root
        const name = validateFileName(path.posix.basename(absolute))
        const parent = normalize(
            await this.session.realpath(path.posix.dirname(absolute))
        )
        this.assertWithinRoot(parent)
        const candidate = path.posix.join(parent, name)
        this.assertWithinRoot(candidate)
        return candidate
    }

    private requestedAbsolute(requestedPath: string) {
        const value = requestedPath
        if (!value.trim()) return this.root
        return normalize(
            value.startsWith('/')
                ? value
                : path.posix.resolve(this.root, value)
        )
    }

    private assertWithinRoot(target: string) {
        if (!isRemotePathWithinRoot(target, this.root)) {
            throw new Error(`路径超出文件管理根目录：${this.root}`)
        }
    }

    private assertNotRoot(target: string) {
        if (normalize(target) === this.root) {
            throw new Error('不能修改或删除文件管理根目录')
        }
    }

    private async writeAtomically(target: string, data: Buffer) {
        const temporary = path.posix.join(
            path.posix.dirname(target),
            `.${path.posix.basename(target)}.agent-nexus-${randomUUID()}.tmp`
        )
        await this.session.writeFileExclusive(temporary, data)
        try {
            await this.session.replaceFile(temporary, target)
        } catch (err) {
            await this.session.unlink(temporary).catch(() => undefined)
            throw err
        }
    }
}

function normalize(value: string) {
    return path.posix.normalize(value).replace(/\/$/, '') || '/'
}

function boundedParent(value: string, root: string) {
    const parent = normalize(path.posix.dirname(value))
    return isRemotePathWithinRoot(parent, root) ? parent : root
}

function validateFileName(value: string) {
    const name = value
    if (
        !name.trim() ||
        name !== name.trim() ||
        name === '.' ||
        name === '..' ||
        /[\0/]/.test(name)
    ) {
        throw new Error('文件名无效')
    }
    return name
}

function fileType(stats: Stats): RemoteFileType {
    if (stats.isDirectory()) return 'directory'
    if (stats.isFile()) return 'file'
    if (stats.isSymbolicLink()) return 'symlink'
    return 'other'
}

function previewEncoding(
    file: string,
    type: string
): RemoteFilePreview['encoding'] {
    if (type.startsWith('image/')) return 'base64'
    if (
        type.startsWith('text/') ||
        /(?:json|xml|yaml|javascript|typescript|toml|shellscript)/i.test(type) ||
        TEXT_EXTENSIONS.has(path.posix.extname(file).toLowerCase())
    ) {
        return 'utf8'
    }
    return 'none'
}

function formatBytes(value: number) {
    return `${Math.ceil(value / 1024 / 1024)} MB`
}

const TEXT_EXTENSIONS = new Set([
    '.c',
    '.cc',
    '.conf',
    '.cpp',
    '.css',
    '.env',
    '.go',
    '.ini',
    '.java',
    '.js',
    '.jsx',
    '.kt',
    '.log',
    '.lua',
    '.mjs',
    '.php',
    '.properties',
    '.py',
    '.rb',
    '.rs',
    '.sh',
    '.sql',
    '.svelte',
    '.toml',
    '.ts',
    '.tsx',
    '.vue'
])
