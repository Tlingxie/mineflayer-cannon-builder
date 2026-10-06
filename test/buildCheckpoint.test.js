const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { Vec3 } = require('vec3')
const { buildIdentity, loadRecovery } = require('../lib/buildRecovery')
const { resolveState } = require('../lib/strictSchematic')

for (const port of [25566, 25567]) {
  test(`checkpoint on ${port} binds an immutable completed-layer report to its world backup and resumes independently of the growing source journal`, async () => {
    const { createLayerCheckpoint } = require('../lib/buildCheckpoint')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-checkpoint-'))
    try {
      const runDir = path.join(root, 'run')
      const directory = path.join(root, 'backup')
      await fs.mkdir(runDir)
      await fs.mkdir(directory)
      const journal = JSON.stringify({ type: 'layer-complete', phase: 'layer', layer: 64 }) + '\n'
      await fs.writeFile(path.join(runDir, 'events.jsonl'), journal)
      const version = '1.21.4'
      const pos = new Vec3(0, 64, 0)
      const state = resolveState('stone', {}, version).stateId
      const support = { id: 'tower:2,64,0', type: 'place', pos: new Vec3(2, 64, 0), state: resolveState('dirt', {}, version).stateId, name: 'dirt', scaffold: true, persistent: true }
      const plan = { name: 'test', filename: '/test.litematic', version, origin: { x: 0, y: 64, z: 0 }, layers: [64, 65], air: [], entities: [], tasks: [{ id: '0,64,0', name: 'stone', type: 'place', pos, state }, { id: '0,65,0', name: 'stone', type: 'place', pos: pos.offset(0, 1, 0), state }] }
      const options = { host: '127.0.0.1', port }
      const worldManifest = { schema: 1, files: [], constructionFrozen: true, server: { host: options.host, port: options.port, version, ...(port === 25567 ? { kind: 'initialization-clone' } : {}) } }
      await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(worldManifest))
      const report = { identity: buildIdentity(plan, options), currentLayer: 64, highestPlacedLayer: 64, completed: 1, activeWorkers: 0, layers: [{ y: 64, blocks: 1 }], persistentOwned: [support], constructionPlan: { startLayer: 64, tasks: [support], fluidStaging: [] }, entities: [{ id: 'cart', verified: true, entityId: 5 }] }
      const before = JSON.stringify(report)
      let backups = 0
      const checkpoint = createLayerCheckpoint({ runDir, backup: async endpoint => { backups++; assert.deepEqual(endpoint, { ...options, version }); assert.equal(JSON.stringify(report), before); return { directory, constructionFrozen: true } } })
      const events = []
      const result = await checkpoint({ layer: 64, report, emit: event => events.push(event) })
      assert.equal(backups, 1)
      assert.equal(result.directory, path.join(directory, 'build-checkpoint'))
      const saved = JSON.parse(await fs.readFile(path.join(result.directory, 'report.json'), 'utf8'))
      assert.equal(saved.completed, 1)
      assert.deepEqual(saved.layers, [{ y: 64, blocks: 1 }])
      assert.equal(saved.checkpoint.sourceEvents.sha256, createHash('sha256').update(journal).digest('hex'))
      assert.equal(saved.checkpoint.sourceEvents.bytes, Buffer.byteLength(journal))
      assert.equal(saved.checkpoint.worldManifestPath, path.join(directory, 'manifest.json'))
      assert.equal(await fs.readFile(path.join(result.directory, 'events.jsonl'), 'utf8'), '')
      assert.equal(events.at(-1).type, 'checkpoint-complete')
      await fs.appendFile(path.join(runDir, 'events.jsonl'), JSON.stringify({ type: 'task-start', layer: 65 }) + '\n')
      report.currentLayer = 65
      report.layers.push({ y: 65, blocks: 1 })
      const recovered = await loadRecovery(result.directory, plan, options)
      assert.equal(recovered.highestLayer, 64)
      assert.deepEqual(recovered.completedLayers, [64])
      assert.equal(recovered.persistentOwned[0].id, support.id)
      assert.equal(recovered.entities[0].entityId, 5)
      assert.equal(JSON.parse(await fs.readFile(path.join(result.directory, 'report.json'), 'utf8')).currentLayer, 64)
      await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ ...worldManifest, changed: true }))
      await assert.rejects(loadRecovery(result.directory, plan, options), /checkpoint.*manifest/i)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
}

test('checkpoint rejects active workers before asking the server for a backup', async () => {
  const { createLayerCheckpoint } = require('../lib/buildCheckpoint')
  let called = false
  const checkpoint = createLayerCheckpoint({ runDir: '/unused', backup: async () => { called = true } })
  await assert.rejects(checkpoint({ layer: 64, report: { currentLayer: 64, activeWorkers: 1, layers: [{ y: 64 }] }, emit: () => {} }), /drained/)
  assert.equal(called, false)
})

test('managed backup command selects only the fixed clone or main CLI without running either in the test', async () => {
  const { backupManagedWorld } = require('../lib/buildCheckpoint')
  const project = path.resolve(__dirname, '..')
  const calls = []
  const executeFile = async (node, args) => {
    assert.equal(node, process.execPath)
    calls.push(args)
    return { stdout: JSON.stringify({ directory: path.join(project, '.runtime/backups/fixture'), constructionFrozen: true }) }
  }
  await backupManagedWorld({ host: '127.0.0.1', port: 25567, version: '1.21.4' }, { executeFile })
  assert.deepEqual(calls[0], [path.join(project, 'scripts/server-clone.js'), 'backup'])
  await backupManagedWorld({ host: '127.0.0.1', port: 25566, version: '1.21.4' }, { executeFile })
  assert.deepEqual(calls[1], [path.join(project, 'scripts/server-backup.js'), 'backup'])
  for (const patch of [{ host: 'localhost' }, { port: 25565 }, { version: '1.21.5' }]) await assert.rejects(backupManagedWorld({ host: '127.0.0.1', port: 25567, version: '1.21.4', ...patch }, { executeFile }), /managed.*endpoint/i)
  assert.equal(calls.length, 2)
})
