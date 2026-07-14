import path from 'path'

const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.xml': 'application/xml',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav'
}

export function mimeType(file: string) {
    return types[path.posix.extname(file.replaceAll('\\', '/')).toLowerCase()]
        || 'application/octet-stream'
}
