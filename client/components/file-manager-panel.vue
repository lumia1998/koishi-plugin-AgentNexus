<template>
    <div class="file-manager-panel">
        <div class="panel-head">
            <div>
                <div class="panel-title">SFTP 文件管理</div>
                <div class="panel-description">
                    文件访问限制在设备工作目录内。支持浏览、预览、编辑、上传下载和目录管理。
                </div>
            </div>
            <el-tag size="small" effect="plain" :type="connected ? 'success' : 'info'">
                {{ connected ? 'SFTP 可用' : '按需连接' }}
            </el-tag>
        </div>

        <section class="file-card">
            <div class="toolbar primary-toolbar">
                <el-select
                    v-model="hostId"
                    class="host-select"
                    placeholder="选择 SSH 设备"
                    @change="changeHost"
                >
                    <el-option
                        v-for="host in config.hosts"
                        :key="host.id"
                        :label="hostLabel(host)"
                        :value="host.id"
                    />
                </el-select>
                <el-button :disabled="!listing?.parent || loading" @click="goUp">
                    上级
                </el-button>
                <el-input
                    v-model="pathInput"
                    class="path-input"
                    placeholder="远端路径"
                    @keyup.enter="load(pathInput)"
                />
                <el-button :loading="loading" @click="load(pathInput)">打开</el-button>
                <el-button :loading="loading" @click="refresh">刷新</el-button>
            </div>

            <div class="toolbar action-toolbar">
                <div class="scope-copy">
                    根目录：<code>{{ listing?.root || '连接后读取' }}</code>
                </div>
                <div class="toolbar-actions">
                    <el-button :disabled="!listing || mutating" @click="createFolder">
                        新建目录
                    </el-button>
                    <el-button
                        type="primary"
                        :disabled="!listing || mutating"
                        :loading="uploading"
                        @click="pickFiles"
                    >
                        上传文件
                    </el-button>
                    <input
                        ref="fileInput"
                        class="hidden-input"
                        type="file"
                        multiple
                        @change="uploadFiles"
                    />
                </div>
            </div>

            <div v-if="!config.hosts.length" class="empty-state">
                请先在 Computer 页面添加 SSH 设备。
            </div>
            <div v-else-if="error" class="error-state">{{ error }}</div>
            <div v-else class="file-table" v-loading="loading">
                <div class="file-row file-header">
                    <div>名称</div>
                    <div>大小</div>
                    <div>修改时间</div>
                    <div class="action-title">操作</div>
                </div>
                <button
                    v-for="entry in listing?.entries || []"
                    :key="entry.path"
                    class="file-row file-entry"
                    type="button"
                    @dblclick="openEntry(entry)"
                >
                    <div class="file-name" @click="openEntry(entry)">
                        <span class="file-kind">{{ kindIcon(entry.type) }}</span>
                        <span class="file-label">{{ entry.name }}</span>
                        <el-tag v-if="entry.type === 'symlink'" size="small" effect="plain">
                            链接
                        </el-tag>
                    </div>
                    <div class="file-meta">
                        {{ entry.type === 'directory' ? '—' : formatBytes(entry.size) }}
                    </div>
                    <div class="file-meta">{{ formatDate(entry.modifiedAt) }}</div>
                    <div class="row-actions" @click.stop>
                        <el-button
                            v-if="entry.type !== 'directory'"
                            text
                            size="small"
                            @click="previewEntry(entry)"
                        >
                            预览
                        </el-button>
                        <el-button
                            v-if="entry.type === 'file'"
                            text
                            size="small"
                            @click="downloadEntry(entry)"
                        >
                            下载
                        </el-button>
                        <el-button text size="small" @click="renameEntry(entry)">
                            重命名
                        </el-button>
                        <el-button text size="small" type="danger" @click="deleteEntry(entry)">
                            删除
                        </el-button>
                    </div>
                </button>
                <div v-if="listing && !listing.entries.length" class="empty-directory">
                    此目录为空
                </div>
            </div>

            <div class="file-footer">
                <span>{{ listing?.path || '尚未连接' }}</span>
                <span>{{ listing?.entries.length || 0 }} 项</span>
            </div>
        </section>

        <el-dialog
            v-model="previewVisible"
            :title="preview?.name || '文件预览'"
            width="min(920px, 92vw)"
            destroy-on-close
        >
            <div v-if="preview" class="preview-body">
                <div class="preview-meta">
                    <span>{{ preview.mimeType }}</span>
                    <span>{{ formatBytes(preview.size) }}</span>
                    <el-tag v-if="preview.truncated" size="small" type="warning" effect="plain">
                        仅显示前段内容
                    </el-tag>
                </div>
                <img
                    v-if="preview.encoding === 'base64'"
                    class="image-preview"
                    :src="`data:${preview.mimeType};base64,${preview.content}`"
                    :alt="preview.name"
                />
                <el-input
                    v-else-if="preview.encoding === 'utf8'"
                    v-model="previewText"
                    class="text-preview"
                    type="textarea"
                    :rows="24"
                    resize="vertical"
                />
                <div v-else class="unsupported-preview">
                    此文件类型不支持在线预览，请下载后查看。
                </div>
            </div>
            <template #footer>
                <el-button @click="previewVisible = false">关闭</el-button>
                <el-button
                    v-if="preview?.encoding === 'utf8'"
                    type="primary"
                    :disabled="preview.truncated"
                    :loading="saving"
                    @click="savePreview"
                >
                    保存
                </el-button>
            </template>
        </el-dialog>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { send } from '@koishijs/client'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
    NexusConfig,
    NexusStatus,
    RemoteFileEntry,
    RemoteFileListing,
    RemoteFilePreview,
    RemoteFileType,
    SshHostConfig
} from '../../src/types'

const props = defineProps<{
    config: NexusConfig
    status: NexusStatus
    visible: boolean
}>()

const hostId = ref('')
const pathInput = ref('')
const listing = ref<RemoteFileListing>()
const preview = ref<RemoteFilePreview>()
const previewText = ref('')
const previewVisible = ref(false)
const loading = ref(false)
const mutating = ref(false)
const uploading = ref(false)
const saving = ref(false)
const error = ref('')
const fileInput = ref<HTMLInputElement>()
const hostFingerprint = ref('')
let loadSequence = 0
let previewSequence = 0

const connected = computed(
    () => props.status.hosts.find((item) => item.id === hostId.value)?.state === 'connected'
)

watch(
    () => [props.config.hosts, props.config.defaultHostId] as const,
    () => {
        if (!props.config.hosts.some((item) => item.id === hostId.value)) {
            hostId.value =
                props.config.defaultHostId ||
                props.config.hosts.find((item) => item.enabled)?.id ||
                props.config.hosts[0]?.id ||
                ''
        }
        const selected = props.config.hosts.find((item) => item.id === hostId.value)
        const fingerprint = selected
            ? [selected.id, selected.host, selected.port, selected.username, selected.cwd || ''].join('|')
            : ''
        if (fingerprint !== hostFingerprint.value) {
            hostFingerprint.value = fingerprint
            clearRemoteState()
        }
        if (props.visible && hostId.value && !listing.value) void load()
    },
    { immediate: true, deep: true }
)

watch(
    () => props.visible,
    (visible) => {
        if (visible && hostId.value && !listing.value) void load()
    }
)

async function load(target?: string) {
    if (!hostId.value) return
    const requestHostId = hostId.value
    const requestId = ++loadSequence
    loading.value = true
    error.value = ''
    try {
        const result = await send('agent-nexus/listFiles', {
            hostId: requestHostId,
            path: target?.trim() || undefined
        })
        if (requestId !== loadSequence || requestHostId !== hostId.value) return
        listing.value = result
        pathInput.value = result.path
    } catch (err: any) {
        if (requestId !== loadSequence || requestHostId !== hostId.value) return
        error.value = err?.message || String(err)
        ElMessage.error(error.value)
    } finally {
        if (requestId === loadSequence) loading.value = false
    }
}

function refresh() {
    return load(listing.value?.path || pathInput.value)
}

function goUp() {
    if (listing.value?.parent) void load(listing.value.parent)
}

function changeHost() {
    clearRemoteState()
    void load()
}

function openEntry(entry: RemoteFileEntry) {
    if (entry.type === 'directory') void load(entry.path)
    else void previewEntry(entry)
}

async function previewEntry(entry: RemoteFileEntry) {
    const requestHostId = requireListingHost()
    if (!requestHostId) return
    const requestId = ++previewSequence
    try {
        const result = await send('agent-nexus/previewFile', {
            hostId: requestHostId,
            path: entry.path
        })
        if (requestId !== previewSequence || requestHostId !== hostId.value) return
        preview.value = result
        previewText.value = result.encoding === 'utf8' ? result.content : ''
        previewVisible.value = true
    } catch (err: any) {
        ElMessage.error(err?.message || String(err))
    }
}

async function savePreview() {
    if (!preview.value || preview.value.encoding !== 'utf8') return
    if (preview.value.hostId !== hostId.value) {
        ElMessage.warning('设备已切换，请重新打开文件')
        return
    }
    saving.value = true
    try {
        await send('agent-nexus/saveTextFile', {
            hostId: preview.value.hostId,
            path: preview.value.path,
            content: previewText.value
        })
        preview.value = { ...preview.value, content: previewText.value }
        ElMessage.success('文件已保存')
        await refresh()
    } catch (err: any) {
        ElMessage.error(err?.message || String(err))
    } finally {
        saving.value = false
    }
}

async function createFolder() {
    if (!listing.value) return
    const operationHostId = requireListingHost()
    const operationDirectory = listing.value.path
    if (!operationHostId) return
    try {
        const result = await ElMessageBox.prompt('请输入目录名称', '新建目录', {
            confirmButtonText: '创建',
            cancelButtonText: '取消',
            inputPattern: /^(?!\s)(?!.*\s$)[^/\0]+$/,
            inputErrorMessage: '名称不能包含 / 或首尾空白'
        })
        mutating.value = true
        if (operationHostId !== hostId.value) throw new Error('设备已切换，请重试')
        await send('agent-nexus/createDirectory', {
            hostId: operationHostId,
            parent: operationDirectory,
            name: result.value
        })
        ElMessage.success('目录已创建')
        await refresh()
    } catch (err: any) {
        if (isCancelled(err)) return
        ElMessage.error(err?.message || String(err))
    } finally {
        mutating.value = false
    }
}

async function renameEntry(entry: RemoteFileEntry) {
    const operationHostId = requireListingHost()
    if (!operationHostId) return
    try {
        const result = await ElMessageBox.prompt('请输入新名称', `重命名 ${entry.name}`, {
            confirmButtonText: '重命名',
            cancelButtonText: '取消',
            inputValue: entry.name,
            inputPattern: /^(?!\s)(?!.*\s$)[^/\0]+$/,
            inputErrorMessage: '名称不能包含 / 或首尾空白'
        })
        if (result.value === entry.name) return
        mutating.value = true
        if (operationHostId !== hostId.value) throw new Error('设备已切换，请重试')
        await send('agent-nexus/renameFile', {
            hostId: operationHostId,
            path: entry.path,
            newName: result.value
        })
        ElMessage.success('重命名完成')
        await refresh()
    } catch (err: any) {
        if (isCancelled(err)) return
        ElMessage.error(err?.message || String(err))
    } finally {
        mutating.value = false
    }
}

async function deleteEntry(entry: RemoteFileEntry) {
    const operationHostId = requireListingHost()
    if (!operationHostId) return
    try {
        await ElMessageBox.confirm(
            entry.type === 'directory'
                ? `确定删除空目录“${entry.name}”吗？非空目录不会被删除。`
                : `确定删除“${entry.name}”吗？`,
            '删除远端文件',
            {
                confirmButtonText: '删除',
                cancelButtonText: '取消',
                type: 'warning'
            }
        )
        mutating.value = true
        if (operationHostId !== hostId.value) throw new Error('设备已切换，请重试')
        await send('agent-nexus/deleteFile', {
            hostId: operationHostId,
            path: entry.path
        })
        ElMessage.success('删除完成')
        await refresh()
    } catch (err: any) {
        if (isCancelled(err)) return
        ElMessage.error(err?.message || String(err))
    } finally {
        mutating.value = false
    }
}

async function downloadEntry(entry: RemoteFileEntry) {
    const operationHostId = requireListingHost()
    if (!operationHostId) return
    try {
        const result = await send('agent-nexus/downloadFile', {
            hostId: operationHostId,
            path: entry.path
        })
        const link = document.createElement('a')
        link.href = result.url
        link.download = result.name
        link.target = '_blank'
        link.rel = 'noopener'
        document.body.appendChild(link)
        link.click()
        link.remove()
    } catch (err: any) {
        ElMessage.error(err?.message || String(err))
    }
}

function pickFiles() {
    fileInput.value?.click()
}

async function uploadFiles(event: Event) {
    const input = event.target as HTMLInputElement
    const files = Array.from(input.files || [])
    input.value = ''
    if (!files.length || !listing.value) return
    const operationHostId = requireListingHost()
    const operationDirectory = listing.value.path
    const operationEntries = listing.value.entries
    if (!operationHostId) return
    uploading.value = true
    try {
        for (const file of files) {
            if (operationHostId !== hostId.value) throw new Error('设备已切换，上传已停止')
            const existing = operationEntries.find((item) => item.name === file.name)
            if (existing) {
                try {
                    await ElMessageBox.confirm(
                        `“${file.name}”已存在，确定覆盖吗？`,
                        '覆盖远端文件',
                        {
                            confirmButtonText: '覆盖',
                            cancelButtonText: '跳过',
                            type: 'warning'
                        }
                    )
                } catch (err) {
                    if (isCancelled(err)) continue
                    throw err
                }
            }
            await send('agent-nexus/uploadFile', {
                hostId: operationHostId,
                path: joinRemote(operationDirectory, file.name),
                contentBase64: await fileBase64(file)
            })
        }
        ElMessage.success('文件上传完成')
        await refresh()
    } catch (err: any) {
        ElMessage.error(err?.message || String(err))
    } finally {
        uploading.value = false
    }
}

function fileBase64(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(reader.error || new Error('读取本地文件失败'))
        reader.onload = () => {
            const value = String(reader.result || '')
            resolve(value.slice(value.indexOf(',') + 1))
        }
        reader.readAsDataURL(file)
    })
}

function hostLabel(host: SshHostConfig) {
    return `${host.name} · ${host.username}@${host.host}`
}

function kindIcon(type: RemoteFileType) {
    if (type === 'directory') return '▰'
    if (type === 'symlink') return '↗'
    if (type === 'file') return '·'
    return '◇'
}

function formatBytes(value: number) {
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
    return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function formatDate(value: number) {
    return value ? new Date(value).toLocaleString() : '—'
}

function joinRemote(directory: string, name: string) {
    return `${directory.replace(/\/$/, '')}/${name}`
}

function isCancelled(err: unknown) {
    return err === 'cancel' || err === 'close'
}

function clearRemoteState() {
    loadSequence += 1
    previewSequence += 1
    listing.value = undefined
    preview.value = undefined
    previewText.value = ''
    previewVisible.value = false
    pathInput.value = ''
    error.value = ''
    loading.value = false
}

function requireListingHost() {
    const value = listing.value?.hostId
    if (!value || value !== hostId.value) {
        ElMessage.warning('文件列表已失效，请刷新后重试')
        return undefined
    }
    return value
}

</script>

<style scoped>
.file-manager-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.panel-head,
.toolbar,
.toolbar-actions,
.preview-meta,
.file-footer {
    display: flex;
    align-items: center;
    gap: 12px;
}

.panel-head,
.action-toolbar,
.file-footer {
    justify-content: space-between;
}

.panel-title {
    font-size: 18px;
    font-weight: 650;
    color: var(--k-text-dark);
}

.panel-description,
.scope-copy,
.file-meta,
.file-footer,
.preview-meta,
.empty-state,
.empty-directory,
.unsupported-preview {
    font-size: 13px;
    line-height: 1.55;
    color: var(--k-text-light);
}

.panel-description {
    margin-top: 5px;
}

.file-card {
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 18%);
    border-radius: 14px;
    background: color-mix(in srgb, var(--k-side-bg), var(--k-page-bg) 18%);
}

.toolbar {
    padding: 14px 16px;
}

.primary-toolbar {
    border-bottom: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 28%);
}

.action-toolbar {
    border-bottom: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 28%);
}

.host-select {
    width: min(300px, 28vw);
}

.path-input {
    flex: 1;
    min-width: 180px;
}

.scope-copy {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.scope-copy code {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    color: var(--k-text-dark);
}

.hidden-input {
    display: none;
}

.file-table {
    min-height: 320px;
}

.file-row {
    display: grid;
    grid-template-columns: minmax(260px, 1fr) 120px 190px minmax(230px, auto);
    align-items: center;
    width: 100%;
    min-height: 46px;
    padding: 0 16px;
    border: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--k-color-divider), transparent 38%);
    box-sizing: border-box;
    text-align: left;
}

.file-header {
    min-height: 38px;
    background: color-mix(in srgb, var(--k-page-bg), transparent 28%);
    color: var(--k-text-light);
    font-size: 12px;
    font-weight: 650;
}

.file-entry {
    background: transparent;
    color: var(--k-text-dark);
    cursor: default;
    font: inherit;
}

.file-entry:hover {
    background: color-mix(in srgb, var(--k-color-primary), transparent 94%);
}

.file-name,
.row-actions {
    display: flex;
    align-items: center;
    min-width: 0;
}

.file-name {
    gap: 10px;
    cursor: pointer;
}

.file-kind {
    display: inline-grid;
    width: 22px;
    height: 22px;
    place-items: center;
    border-radius: 6px;
    background: color-mix(in srgb, var(--k-color-primary), transparent 88%);
    color: var(--k-color-primary);
    font-size: 13px;
}

.file-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.row-actions {
    justify-content: flex-end;
    gap: 2px;
}

.action-title {
    text-align: right;
}

.empty-state,
.empty-directory,
.error-state {
    padding: 54px 20px;
    text-align: center;
}

.error-state {
    color: var(--el-color-danger);
    font-size: 13px;
}

.file-footer {
    padding: 10px 16px;
    background: color-mix(in srgb, var(--k-page-bg), transparent 42%);
}

.file-footer span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.preview-body {
    min-height: 320px;
}

.preview-meta {
    margin-bottom: 12px;
}

.image-preview {
    display: block;
    max-width: 100%;
    max-height: 68vh;
    margin: 0 auto;
    object-fit: contain;
}

.text-preview :deep(textarea) {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    line-height: 1.55;
}

.unsupported-preview {
    display: grid;
    min-height: 300px;
    place-items: center;
}

@media (max-width: 980px) {
    .primary-toolbar,
    .action-toolbar {
        align-items: stretch;
        flex-wrap: wrap;
    }

    .host-select {
        width: 100%;
    }

    .path-input {
        order: 3;
        flex-basis: 100%;
    }

    .file-row {
        grid-template-columns: minmax(220px, 1fr) 100px minmax(210px, auto);
    }

    .file-row > :nth-child(3) {
        display: none;
    }
}

@media (max-width: 680px) {
    .panel-head,
    .action-toolbar,
    .toolbar-actions {
        align-items: stretch;
        flex-direction: column;
    }

    .file-row {
        grid-template-columns: minmax(180px, 1fr) auto;
    }

    .file-row > :nth-child(2),
    .file-row > :nth-child(3) {
        display: none;
    }

    .row-actions {
        flex-wrap: wrap;
    }
}
</style>
