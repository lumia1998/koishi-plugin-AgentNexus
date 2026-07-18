const { buildSync } = require('esbuild')
const { spawnSync } = require('child_process')
const { rmSync } = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(__dirname, '..')
const output = path.join(
    os.tmpdir(),
    `agent-nexus-smoke-${process.pid}-${Date.now()}.cjs`
)

try {
    buildSync({
        entryPoints: [path.join(__dirname, 'smoke-agents.ts')],
        outfile: output,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node18',
        external: ['ssh2']
    })
    const result = spawnSync(
        process.execPath,
        [output, ...process.argv.slice(2)],
        {
            cwd: root,
            stdio: 'inherit',
            env: {
                ...process.env,
                NODE_PATH: path.join(root, 'node_modules')
            }
        }
    )
    process.exitCode = result.status ?? 1
} finally {
    rmSync(output, { force: true })
}
