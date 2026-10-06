const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const vm = require('node:vm')

async function harness ({ saving = true, pending = false, interrupt = false, advance = false, failDisable = false, failEnable = false, failFlush = false } = {}) {
  const filename = require.resolve('../scripts/server-clone')
  const root = path.resolve(path.dirname(filename), '../.runtime/clones')
  const state = { kind: 'initialization-clone', host: '127.0.0.1', version: '1.21.4', port: 25567, rconPort: 25577, pid: process.pid, password: 'clone-backup-secret', directory: path.join(root, 'run-fixture'), startedAt: 'fixture', initialized: true, pendingStep: pending ? { before: 100, ticks: 1, target: 101 } : null, initialization: pending ? { pendingTick: { index: 1 }, halted: { code: 'PRIMED_TNT' } } : {} }
  const commands = []
  const writes = []
  const snapshots = []
  let clock = 0
  let times = 0
  const isolatedRequire = name => {
    if (name === './server-local') {
      return {
        rconCommand: async (_credentials, command) => {
          commands.push(command)
          if (command === 'tick query') return 'The game is frozen'
          if (command === 'tick step stop') return interrupt ? 'Interrupted the current tick step' : 'No tick step in progress'
          if (command === 'time query gametime') return `The time is ${100 + (advance ? times++ : 0)}`
          if (command === 'save-off') {
            const enabled = saving
            saving = false
            if (failDisable) throw new Error('lost disable reply')
            return enabled ? 'Automatic saving is now disabled' : 'Saving is already turned off'
          }
          if (command === 'save-on') {
            saving = true
            if (failEnable) throw new Error('lost enable reply')
            return 'Automatic saving is now enabled'
          }
          if (command === 'save-all flush') {
            if (failFlush) throw new Error('flush failed')
            return 'Saved the game'
          }
          throw new Error(`Unexpected command: ${command}`)
        }
      }
    }
    if (name === './server-backup') {
      return {
        snapshotWorld: async (source, target, metadata) => {
          snapshots.push({ source, target, metadata: JSON.parse(JSON.stringify(metadata)) })
          return { ...metadata, createdAt: 'snapshot-time', files: [{ path: 'level.dat', bytes: 9 }] }
        }
      }
    }
    if (name === 'node:fs/promises') {
      return {
        ...fs,
        readFile: async filename => {
          assert.equal(filename, path.join(root, 'run.json'))
          return JSON.stringify(state)
        },
        mkdir: async directory => assert.equal(directory, path.resolve(root, '../backups')),
        writeFile: async (filename, data) => { writes.push({ filename, data: JSON.parse(data) }) }
      }
    }
    return require(name)
  }
  const module = { exports: {} }
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), { require: isolatedRequire, module, __dirname: path.dirname(filename), process, console }, { filename })
  assert.equal(typeof module.exports.backupClone, 'function', 'Clone backup is implemented')
  return { state, commands, snapshots, writes, saving: () => saving, run: () => module.exports.backupClone({ wait: async ms => { clock += ms }, now: () => clock }) }
}

test('clone backup stops latent ticks, proves quiescence, preserves pending evidence and restores enabled saving', async () => {
  const h = await harness({ pending: true, interrupt: true })
  const original = JSON.stringify(h.state)
  const result = await h.run()
  assert.equal(result.constructionFrozen, true)
  assert.equal(h.saving(), true)
  assert.deepEqual(h.commands.slice(0, 5), ['tick query', 'tick step stop', 'time query gametime', 'time query gametime', 'tick query'])
  assert.deepEqual(h.commands.slice(-3), ['save-off', 'save-all flush', 'save-on'])
  assert.equal(h.commands.some(command => /^tick step \d/.test(command)), false)
  assert.equal(JSON.stringify(h.state), original)
  assert.equal(h.snapshots.length, 1)
  const snapshot = h.snapshots[0]
  assert.equal(snapshot.source, path.join(h.state.directory, 'world'))
  assert.match(snapshot.target, /backups\/clone-/)
  assert.equal(snapshot.metadata.server.kind, 'initialization-clone')
  assert.equal(snapshot.metadata.server.port, 25567)
  assert.equal(snapshot.metadata.server.directory, h.state.directory)
  assert.deepEqual(snapshot.metadata.pending.step, h.state.pendingStep)
  assert.deepEqual(snapshot.metadata.pending.initializationTick, h.state.initialization.pendingTick)
  assert.equal(snapshot.metadata.pending.halted.code, 'PRIMED_TNT')
  assert.equal(snapshot.metadata.quiescence.sampleMs, 150)
  assert.equal(h.writes.length, 1)
  assert.match(h.writes[0].filename, /operations.json$/)
  assert.equal(JSON.stringify({ result, snapshot, writes: h.writes }).includes(h.state.password), false)
})

test('clone backup preserves a confirmed disabled saving state', async () => {
  const h = await harness({ saving: false })
  await h.run()
  assert.equal(h.saving(), false)
  assert.equal(h.commands.includes('save-on'), false)
})

test('clone backup restores saving after an unknown save-off outcome and preserves the uncertainty', async () => {
  const h = await harness({ failDisable: true })
  await assert.rejects(h.run(), error => /save-off outcome.*unknown/.test(error.message) && /saving.*enabled/.test(error.message) && error.evidence.some(item => item.command === 'save-off' && item.outcome === 'unknown'))
  assert.equal(h.saving(), true)
  assert.equal(h.commands.at(-1), 'save-on')
  assert.equal(h.snapshots.length, 0)
})

test('clone backup retains both flush and saving-restore failures', async () => {
  const h = await harness({ failFlush: true, failEnable: true })
  await assert.rejects(h.run(), error => /flush failed/.test(error.message) && /lost enable reply/.test(error.message) && /uncertain/.test(error.message))
  assert.equal(h.snapshots.length, 0)
})

test('advancing gametime prevents clone backup before changing automatic saving', async () => {
  const h = await harness({ advance: true })
  await assert.rejects(h.run(), /gametime.*changed|quiescen/i)
  assert.equal(h.commands.includes('save-off'), false)
  assert.equal(h.snapshots.length, 0)
})
