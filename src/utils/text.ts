export function splitMessage(text: string, limit = 3500) {
    if (text.length <= limit) return [text]

    const chunks: string[] = []
    let remaining = text
    while (remaining.length > limit) {
        let end = remaining.lastIndexOf('\n', limit)
        if (end < limit / 2) end = limit
        chunks.push(remaining.slice(0, end))
        remaining = remaining.slice(end).replace(/^\n/, '')
    }
    if (remaining) chunks.push(remaining)
    return chunks
}
