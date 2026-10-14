const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { WebBuildManager } = require('../lib/webBuildManager')

const metadata = { name: 'Test blueprint', blocks: 12, activeBlocks: 10, derivedBlocks: 2, layers: 3, dimensions: { x: 4, y: 3, z: 2 }, sourceMin: { x: -2, y: -1, z: 0 }, min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 2 }, requiresAlignment: false, warnings: [] }

async function until (predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Timed out waiting for manager state')
}

async function fixture (t, extra = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-builder-'))
  const spawned = []
  const attached = []
  const manager = new WebBuildManager({
    rootDir,
    inspect: async () => structuredClone(metadata),
    attach: async options => { attached.push(options); return { profilePath: options.output } },
    checkServer: async () => {},
    spawn: (command, args, options) => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.signals = []
      child.kill = signal => { child.signals.push(signal); return true }
      spawned.push({ command, args, options, child })
      return child
    },
    ...extra
  })
  t.after(async () => {
    for (const { child } of spawned) child.emit('close', 1, 'SIGINT')
    await manager.close()
    await fs.rm(rootDir, { recursive: true, force: true })
  })
  const blueprint = await manager.upload('test.litematic', Buffer.from('test'))
  const start = (options = {}) => manager.start({ blueprintId: blueprint.id, origin: { x: 128, y: 64, z: 128 }, originMode: 'schematic', bots: 5, ...options })
  return { manager, blueprint, start, spawned, attached, rootDir }
}

test('uploaded names cannot escape storage and only schematic formats are accepted', async t => {
  const { manager, blueprint, rootDir } = await fixture(t)
  assert.equal(blueprint.blocks, 12)
  await assert.rejects(manager.upload('../escape.litematic', Buffer.from('x')), /filename/i)
  await assert.rejects(manager.upload('server.js', Buffer.from('x')), /litematic|schem/i)
  await assert.rejects(manager.upload('empty.schem', Buffer.alloc(0)), /empty/i)
  assert.equal((await fs.readdir(path.join(rootDir, '.runtime/web/uploads'))).length, 1)
  assert.equal('path' in blueprint, false)
})

test('MIDI uploads compile into registered downloadable schematics and reuse the physical build path', async t => {
  const source = Buffer.from('MIDI input')
  const schematic = Buffer.from('compiled schematic')
  const music = { noteCount: 3, sourceNoteCount: 4, durationSeconds: 2, quantumSeconds: 0.1, maxTimingErrorMs: 20, octaveAdjustedNotes: 1, deduplicatedNotes: 1, instruments: [{ name: 'harp', notes: 3 }], start: { x: 0, y: 1, z: 2 }, warnings: ['Converted test warning'] }
  const compilations = []
  const { manager, rootDir, spawned } = await fixture(t, {
    compileMidi: async (buffer, options) => { compilations.push({ buffer, options }); return { schematic, music: { ...music, notes: [{ internal: true }], modules: [{ internal: true }] } } }
  })
  const blueprint = await manager.upload('我的音乐.MIDI', source)
  assert.equal(blueprint.filename, '我的音乐.schem')
  assert.equal(blueprint.sourceFilename, '我的音乐.MIDI')
  assert.deepEqual(blueprint.music, music)
  assert.ok(blueprint.warnings.includes('Converted test warning'))
  assert.equal(blueprint.downloadUrl, `/api/blueprints/${blueprint.id}/download`)
  assert.equal(compilations.length, 1)
  assert.deepEqual(compilations[0], { buffer: source, options: { version: '1.21.11', title: '我的音乐' } })
  const directory = path.join(rootDir, '.runtime/web/uploads', blueprint.id)
  assert.deepEqual(await fs.readFile(path.join(directory, 'source.mid')), source)
  assert.deepEqual(await fs.readFile(path.join(directory, 'blueprint.schem')), schematic)
  assert.deepEqual(await manager.getDownload(blueprint.id), { buffer: schematic, filename: '我的音乐.schem' })
  await assert.rejects(manager.getDownload('../source.mid'), error => error.statusCode === 404)
  await manager.start({ blueprintId: blueprint.id, origin: { x: 200, y: 64, z: 200 }, originMode: 'minimum', bots: 7 })
  await until(() => spawned.length === 1)
  const args = spawned[0].args
  assert.equal(args[args.indexOf('--schematic') + 1], path.join(directory, 'blueprint.schem'))
  assert.equal(args[args.indexOf('--bots') + 1], '7')
  assert.equal(args[args.indexOf('--origin') + 1], '200,64,200')
})

test('failed MIDI conversion removes source data and never registers a download', async t => {
  const { manager, rootDir, blueprint } = await fixture(t, { compileMidi: async () => { throw new Error('Invalid MIDI header') } })
  await assert.rejects(manager.upload('broken.mid', Buffer.from('bad')), /Invalid MIDI header/)
  assert.equal((await fs.readdir(path.join(rootDir, '.runtime/web/uploads'))).length, 1)
  await assert.rejects(manager.getDownload(blueprint.id), error => error.statusCode === 404)
})

test('validates bot count, translated height and every aligned schematic axis before launching', async t => {
  const { manager, start, spawned } = await fixture(t, { inspect: async () => ({ ...metadata, requiresAlignment: true }) })
  await assert.rejects(start({ bots: 31 }), /1.*30/)
  await assert.rejects(start({ origin: { x: 128, y: -64, z: 128 } }), /height/i)
  await assert.rejects(start({ origin: { x: 128, y: 65, z: 128 } }), /16/)
  await assert.rejects(start({ origin: { x: 128, y: 64, z: 128 }, originMode: 'minimum' }), /16/)
  await assert.rejects(start({ blueprintId: 'missing' }), /blueprint/i)
  assert.equal((await manager.snapshot()).job, null)
  assert.equal(spawned.length, 0)
})

test('reserves one job during attachment and starts the fixed CLI with physical worker options', async t => {
  let release
  const attaching = new Promise(resolve => { release = resolve })
  const { manager, start, spawned, rootDir } = await fixture(t, { attach: async options => { await attaching; return { profilePath: options.output } } })
  const job = await start()
  assert.equal(job.status, 'preparing')
  await assert.rejects(start(), error => error.statusCode === 409)
  release()
  await until(() => spawned.length === 1)
  const { command, args, options } = spawned[0]
  assert.equal(command, process.execPath)
  assert.equal(args[0], path.join(rootDir, 'examples/strictBuilder.js'))
  assert.equal(args[args.indexOf('--schematic-origin') + 1], '128,64,128')
  assert.equal(args[args.indexOf('--bots') + 1], '5')
  assert.ok(args.includes('--prepare-workers'))
  assert.equal(args[args.indexOf('--port') + 1], '25566')
  assert.match(args[args.indexOf('--prefix') + 1], /^[A-Za-z0-9_]{1,14}$/)
  assert.equal(options.shell, false)
  assert.equal((await manager.snapshot()).job.status, 'running')
})

test('server attachment errors become failed jobs without spawning bots', async t => {
  const { manager, start, spawned } = await fixture(t, { attach: async () => { throw new Error('Server offline') } })
  await start()
  await until(async () => (await manager.snapshot()).job.status === 'failed')
  const { job } = await manager.snapshot()
  assert.match(job.error, /Server offline/)
  assert.ok(job.endedAt)
  assert.equal(spawned.length, 0)
})

test('freeze-required blueprint fails read-only preflight before spawning', async t => {
  let checks = 0
  const { manager, start, spawned } = await fixture(t, {
    inspect: async () => ({ ...metadata, requiresFrozen: true }),
    checkFrozen: async () => { checks++; throw new Error('Construction requires frozen game ticks') }
  })
  await start()
  await until(async () => (await manager.snapshot()).job.status === 'failed')
  assert.equal(checks, 1)
  assert.equal(spawned.length, 0)
  assert.match((await manager.snapshot()).job.error, /冻结/)
})

test('progress follows own report and only a verified successful exit is completed', async t => {
  const { manager, start, spawned, rootDir } = await fixture(t)
  await start()
  await until(() => spawned.length === 1)
  const child = spawned[0].child
  const runDir = path.join(rootDir, '.runtime/builds/test-run')
  await fs.mkdir(runDir, { recursive: true })
  child.stdout.write(JSON.stringify({ runDir }) + '\n')
  await fs.writeFile(path.join(runDir, 'status.json'), JSON.stringify({ status: 'waiting-natural-generation', completed: 4, currentLayer: 63, layers: [{ y: 63 }], connectedBots: 5, activeWorkers: 3 }))
  const running = (await manager.snapshot()).job
  assert.equal(running.progress.completed, 4)
  assert.equal(running.progress.phase, 'waiting-natural-generation')
  assert.equal(running.progress.connectedBots, 5)
  assert.equal(running.progress.completedLayers, 1)
  await fs.writeFile(path.join(runDir, 'report.json'), JSON.stringify({ status: 'verified', completed: 10, layers: [{ y: 63 }, { y: 64 }, { y: 65 }], connectedBots: 5, elapsedSeconds: 12 }))
  child.emit('close', 0, null)
  await until(async () => (await manager.snapshot()).job.status === 'completed')
  const done = (await manager.snapshot()).job
  assert.equal(done.progress.completed, 10)
  assert.equal(done.progress.activeBots, 0)
  assert.equal(done.progress.elapsedSeconds, 12)
})

test('unverified exit and forged run directory cannot report success or expose files', async t => {
  const { manager, start, spawned, rootDir } = await fixture(t)
  await start()
  await until(() => spawned.length === 1)
  await fs.writeFile(path.join(rootDir, 'report.json'), JSON.stringify({ status: 'verified', error: 'private marker' }))
  spawned[0].child.stdout.write(JSON.stringify({ runDir: rootDir }) + '\n')
  spawned[0].child.emit('close', 0, null)
  await until(async () => (await manager.snapshot()).job.status === 'failed')
  assert.doesNotMatch((await manager.snapshot()).job.error, /private marker/)
})

test('stop drains the existing process before permitting another build', async t => {
  const { manager, start, spawned } = await fixture(t)
  const job = await start()
  await until(() => spawned.length === 1)
  const child = spawned[0].child
  assert.equal((await manager.stop(job.id)).status, 'stopping')
  assert.deepEqual(child.signals, ['SIGINT'])
  await assert.rejects(start(), error => error.statusCode === 409)
  child.emit('close', 1, null)
  await until(async () => (await manager.snapshot()).job.status === 'cancelled')
  assert.ok((await manager.snapshot()).job.endedAt)
  assert.equal((await start()).status, 'preparing')
})

test('stopping during attachment never spawns a construction process', async t => {
  let release
  const attaching = new Promise(resolve => { release = resolve })
  const { manager, start, spawned } = await fixture(t, { attach: async () => attaching })
  const job = await start()
  await manager.stop(job.id)
  release()
  await until(async () => (await manager.snapshot()).job.status === 'cancelled')
  assert.equal(spawned.length, 0)
})

test('a forced stop stays failed until the child actually closes', async t => {
  const { manager, start, spawned } = await fixture(t, { stopTimeoutMs: 10 })
  const job = await start()
  await until(() => spawned.length === 1)
  const child = spawned[0].child
  await manager.stop(job.id)
  await until(() => child.signals.includes('SIGKILL'))
  assert.equal((await manager.snapshot()).job.status, 'stopping')
  await assert.rejects(start(), error => error.statusCode === 409)
  child.emit('close', null, 'SIGKILL')
  await until(async () => (await manager.snapshot()).job.status === 'failed')
  assert.match((await manager.snapshot()).job.error, /强制停止/)
})

test('isolated inspection accepts real schematic bytes and rejects malformed NBT', async t => {
  const rootDir = path.resolve(__dirname, '..')
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-inspect-'))
  const manager = new WebBuildManager({ rootDir, runtimeDir })
  t.after(async () => { await manager.close(); await fs.rm(runtimeDir, { recursive: true, force: true }) })
  const nbt = require('prismarine-nbt')
  const schematic = nbt.writeUncompressed({
    type: 'compound',
    name: 'Schematic',
    value: {
      Version: { type: 'int', value: 2 },
      Width: { type: 'short', value: 1 },
      Height: { type: 'short', value: 2 },
      Length: { type: 'short', value: 1 },
      Palette: { type: 'compound', value: { 'minecraft:stone': { type: 'int', value: 0 }, 'minecraft:glass': { type: 'int', value: 1 } } },
      BlockData: { type: 'byteArray', value: [0, 1] }
    }
  })
  const blueprint = await manager.upload('My structure.schem', schematic)
  assert.equal(blueprint.name, 'My structure.schem')
  assert.equal(blueprint.blocks, 2)
  assert.equal(blueprint.layers, 2)
  assert.equal(blueprint.requiresFrozen, false)
  assert.deepEqual(blueprint.dimensions, { x: 1, y: 2, z: 1 })
  await assert.rejects(manager.upload('broken.schem', Buffer.from('invalid data')), error => error.statusCode === 400)
  assert.equal((await fs.readdir(path.join(runtimeDir, 'uploads'))).length, 1)
})

test('real MIDI bytes compile, inspect and download through the web manager', async t => {
  const rootDir = path.resolve(__dirname, '..')
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-midi-'))
  const manager = new WebBuildManager({ rootDir, runtimeDir })
  t.after(async () => { await manager.close(); await fs.rm(runtimeDir, { recursive: true, force: true }) })
  const track = Buffer.from([0, 0x90, 60, 100, 0x83, 0x60, 0x80, 60, 0, 0, 0xff, 0x2f, 0])
  const trackLength = Buffer.alloc(4)
  trackLength.writeUInt32BE(track.length)
  const source = Buffer.concat([Buffer.from('4d546864000000060000000101e04d54726b', 'hex'), trackLength, track])
  const blueprint = await manager.upload('One note.mid', source)
  assert.equal(blueprint.sourceFilename, 'One note.mid')
  assert.equal(blueprint.filename, 'One note.schem')
  assert.equal(blueprint.music.noteCount, 1)
  assert.equal(blueprint.music.quantumSeconds, 0.1)
  assert.ok(blueprint.blocks > 1)
  assert.ok(blueprint.activeBlocks > 1)
  assert.ok(blueprint.layers >= 2)
  const download = await manager.getDownload(blueprint.id)
  const nbt = require('prismarine-nbt')
  const parsed = await nbt.parse(download.buffer)
  const contents = nbt.simplify(parsed.parsed)
  const palette = contents.Palette || contents.Blocks?.Palette
  assert.ok(Object.keys(palette).some(state => state.startsWith('minecraft:note_block[')))
})
