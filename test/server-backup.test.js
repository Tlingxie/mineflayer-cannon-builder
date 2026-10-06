const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { snapshotWorld, verifyWorldSnapshot, restoreWorld } = require('../scripts/server-backup')

async function backupWithTransport (transport) {
  const filename = require.resolve('../scripts/server-backup')
  const runtime = path.resolve(path.dirname(filename), '../.runtime/server')
  const state = { directory: runtime, host: '127.0.0.1', version: '1.21.4', port: 25566, rconPort: 25576, pid: process.pid, password: 'fixture-only' }
  const module = { exports: {} }
  const readFile = async (filename, ...args) => filename === path.join(runtime, 'run.json') ? JSON.stringify(state) : fs.readFile(filename, ...args)
  const isolatedRequire = name => {
    if (name === './server-local') return { rconCommand: (_, command) => transport(command) }
    if (name === 'node:fs/promises') return { ...fs, readFile }
    return require(name)
  }
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), { require: isolatedRequire, module, __dirname: path.dirname(filename), process, console }, { filename })
  return module.exports.backupManagedServer()
}

async function fixture (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-backup-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const world = path.join(root, 'world')
  await fs.mkdir(path.join(world, 'region'), { recursive: true })
  await fs.writeFile(path.join(world, 'level.dat'), 'original-level')
  await fs.writeFile(path.join(world, 'region/r.0.0.mca'), 'original-region')
  return { root, world, target: path.join(root, 'snapshot') }
}

test('world snapshot verifies every file and restores while retaining the replaced world', async t => {
  const f = await fixture(t)
  await snapshotWorld(f.world, f.target, { server: { version: '1.21.4' } })
  const verified = await verifyWorldSnapshot(f.target)
  assert.equal(verified.files.length, 2)
  await fs.writeFile(path.join(f.world, 'level.dat'), 'new-level')
  const before = path.join(f.root, 'before-restore')
  await restoreWorld(f.world, f.target, before)
  assert.equal(await fs.readFile(path.join(f.world, 'level.dat'), 'utf8'), 'original-level')
  assert.equal(await fs.readFile(path.join(before, 'world/level.dat'), 'utf8'), 'new-level')
  assert.equal(await fs.readFile(path.join(f.target, 'world/level.dat'), 'utf8'), 'original-level')
})

test('corrupt or incomplete snapshots are rejected before replacing the current world', async t => {
  const f = await fixture(t)
  await snapshotWorld(f.world, f.target, {})
  await fs.writeFile(path.join(f.target, 'world/region/r.0.0.mca'), 'corrupted-region')
  await assert.rejects(restoreWorld(f.world, f.target, path.join(f.root, 'before')), /checksum|manifest/)
  assert.equal(await fs.readFile(path.join(f.world, 'level.dat'), 'utf8'), 'original-level')
})

test('snapshot refuses symbolic links and never traverses outside the world', async t => {
  const f = await fixture(t)
  await fs.symlink(path.join(f.root, 'private'), path.join(f.world, 'external'))
  await assert.rejects(snapshotWorld(f.world, f.target, {}), /symbolic|regular/)
})

test('lost save-off response still restores automatic saving and reports unknown prior state', async () => {
  let automaticSaving = true
  const commands = []
  let failure
  try {
    await backupWithTransport(command => {
      commands.push(command)
      if (command === 'tick query') return 'The game is frozen'
      if (command === 'save-off') {
        automaticSaving = false
        throw new Error('RCON closed before command response')
      }
      if (command === 'save-on') {
        automaticSaving = true
        return 'Automatic saving is now enabled'
      }
      throw new Error(`Unexpected command: ${command}`)
    })
  } catch (error) { failure = error }
  assert.equal(automaticSaving, true)
  assert.deepEqual(commands, ['tick query', 'save-off', 'save-on'])
  assert.match(failure.message, /save-off outcome.*unknown.*prior.*unknown/i)
  assert.match(failure.message, /automatic saving.*enabled/i)
  assert.equal(failure.evidence.find(entry => entry.command === 'save-off').outcome, 'unknown')
})

test('lost restore response reports uncertain automatic saving and preserves both errors', async () => {
  const commands = []
  let failure
  try {
    await backupWithTransport(command => {
      commands.push(command)
      if (command === 'tick query') return 'The game is frozen'
      if (command === 'save-off') throw new Error('lost disable response')
      if (command === 'save-on') throw new Error('lost restore response')
      throw new Error(`Unexpected command: ${command}`)
    })
  } catch (error) { failure = error }
  assert.deepEqual(commands, ['tick query', 'save-off', 'save-on'])
  assert.match(failure.message, /lost disable response/)
  assert.match(failure.message, /lost restore response/)
  assert.match(failure.message, /automatic saving.*uncertain/i)
  assert.equal(failure.evidence.find(entry => entry.command === 'save-on').outcome, 'unknown')
})

test('confirmed prior save-off state is preserved when the flushed save fails', async () => {
  const commands = []
  await assert.rejects(backupWithTransport(command => {
    commands.push(command)
    if (command === 'tick query') return 'The game is frozen'
    if (command === 'save-off') return 'Saving is already turned off'
    if (command === 'save-all flush') throw new Error('flush failed')
    throw new Error(`Unexpected command: ${command}`)
  }), /flush failed/)
  assert.deepEqual(commands, ['tick query', 'save-off', 'save-all flush'])
})
