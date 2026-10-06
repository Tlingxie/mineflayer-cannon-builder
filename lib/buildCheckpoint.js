const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execute = promisify(execFile)
const project = path.resolve(__dirname, '..')
const digest = contents => createHash('sha256').update(contents).digest('hex')

function checkSignal (signal) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('Build checkpoint cancelled'), { name: 'AbortError' })
}

async function backupManagedWorld (server, { executeFile = execute } = {}) {
  if (server?.host !== '127.0.0.1' || ![25566, 25567].includes(server.port) || server.version !== '1.21.4') throw new Error('Unsupported managed backup endpoint')
  const script = server.port === 25567 ? 'server-clone.js' : 'server-backup.js'
  // Do not kill this child on cancellation: its finally block must restore saving.
  const { stdout } = await executeFile(process.execPath, [path.join(project, 'scripts', script), 'backup'], { cwd: project, maxBuffer: 1024 * 1024 })
  const result = JSON.parse(stdout)
  const relative = typeof result.directory === 'string' ? path.relative(path.join(project, '.runtime/backups'), result.directory) : ''
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Backup CLI returned a directory outside managed backups')
  return result
}

function createLayerCheckpoint ({ runDir, backup = backupManagedWorld }) {
  const sourceRunDir = path.resolve(runDir)
  return async ({ layer, report, signal, emit = () => {} }) => {
    checkSignal(signal)
    if (report.activeWorkers !== 0) throw new Error('Build checkpoint requires drained workers')
    if (report.currentLayer !== layer || report.layers?.at(-1)?.y !== layer || !report.identity) throw new Error('Build checkpoint requires a completed layer and build identity')
    const snapshot = JSON.parse(JSON.stringify(report))
    const sourcePath = path.join(sourceRunDir, 'events.jsonl')
    const journal = await fs.readFile(sourcePath)
    const started = Date.now()
    emit({ type: 'checkpoint-start', phase: 'checkpoint', layer })
    const result = await backup({ ...snapshot.identity.server, version: snapshot.identity.version })
    checkSignal(signal)
    if (!path.isAbsolute(result.directory || '') || result.constructionFrozen !== true) throw new Error('Backup did not confirm a frozen world snapshot')
    const worldManifestPath = path.join(result.directory, 'manifest.json')
    const manifestData = await fs.readFile(worldManifestPath)
    const manifest = JSON.parse(manifestData)
    const identity = snapshot.identity
    if (manifest.schema !== 1 || !Array.isArray(manifest.files) || manifest.constructionFrozen !== true || manifest.server?.host !== identity.server.host || manifest.server?.port !== identity.server.port || manifest.server?.version !== identity.version) throw new Error('World backup manifest differs from the build server identity')
    const directory = path.join(result.directory, 'build-checkpoint')
    const checkpoint = {
      schema: 1,
      layer,
      directory,
      backupDirectory: result.directory,
      createdAt: new Date().toISOString(),
      sourceRunDir,
      sourceEvents: { path: sourcePath, bytes: journal.length, sha256: digest(journal) },
      worldManifestPath,
      worldManifestSha256: digest(manifestData)
    }
    snapshot.checkpoint = checkpoint
    snapshot.checkpoints = [...(snapshot.checkpoints || []), { layer, directory, backupDirectory: result.directory }]
    const text = JSON.stringify(snapshot, null, 2) + '\n'
    const staging = path.join(result.directory, `.build-checkpoint-${randomUUID()}`)
    await fs.mkdir(staging, { mode: 0o700 })
    try {
      for (const name of ['run.json', 'report.json']) await fs.writeFile(path.join(staging, name), text, { mode: 0o400, flag: 'wx' })
      await fs.writeFile(path.join(staging, 'events.jsonl'), '', { mode: 0o400, flag: 'wx' })
      await fs.rename(staging, directory)
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true })
      throw error
    }
    report.checkpoints = snapshot.checkpoints
    emit({ type: 'checkpoint-complete', phase: 'checkpoint', layer, directory, backupDirectory: result.directory, elapsedMs: Date.now() - started })
    checkSignal(signal)
    return checkpoint
  }
}

module.exports = { createLayerCheckpoint, backupManagedWorld }
