const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const nbt = require('prismarine-nbt')
const { snapshotWorld } = require('../scripts/server-backup')

function implementation () {
  let result
  try { result = require('../scripts/server-clone') } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
  }
  assert.ok(result, 'The isolated clone launcher is implemented')
  return result
}

async function fixture (t, { rules = {}, enabled = ['vanilla'], forced = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-clone-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source')
  const world = path.join(source, 'world')
  await fs.mkdir(path.join(world, 'data'), { recursive: true })
  const node = nbt.comp({
    Data: nbt.comp({
      GameRules: nbt.comp({ spawnChunkRadius: nbt.string('0'), ...rules }),
      SpawnX: nbt.int(0),
      SpawnZ: nbt.int(0),
      DataPacks: nbt.comp({ Enabled: nbt.list(nbt.string(enabled)) }),
      ScheduledEvents: nbt.list(nbt.comp([]))
    })
  })
  await fs.writeFile(path.join(world, 'level.dat'), zlib.gzipSync(nbt.writeUncompressed(node)))
  if (forced) {
    const chunk = nbt.comp({ data: nbt.comp({ Forced: { type: 'longArray', value: [[0, 4]] } }) })
    await fs.writeFile(path.join(world, 'data/chunks.dat'), zlib.gzipSync(nbt.writeUncompressed(chunk)))
  }
  const jar = Buffer.from('official-jar-fixture')
  await fs.writeFile(path.join(source, 'minecraft_server.1.21.4.jar'), jar)
  await fs.writeFile(path.join(source, 'download.json'), JSON.stringify({ version: '1.21.4', sha1: crypto.createHash('sha1').update(jar).digest('hex'), size: jar.length }))
  await fs.writeFile(path.join(source, 'eula.txt'), 'eula=true\n')
  await fs.writeFile(path.join(source, 'server.properties'), 'server-ip=127.0.0.1\nserver-port=25566\nrcon.port=25576\nrcon.password=main-secret\nlevel-name=world\npause-when-empty-seconds=60\nsimulation-distance=4\nview-distance=4\nallow-nether=false\n')
  const backup = path.join(root, 'snapshot')
  await snapshotWorld(world, backup, { server: { version: '1.21.4', host: '127.0.0.1', directory: source }, constructionFrozen: true })
  return { root, source, world, backup, target: path.join(root, 'clone') }
}

test('clone preparation preserves the verified world and isolates ports, players and empty-server pause', async t => {
  const { prepareClone } = implementation()
  const f = await fixture(t)
  const before = await fs.readFile(path.join(f.world, 'level.dat'))
  const state = await prepareClone(f.backup, f.target, { sourceDirectory: f.source })
  assert.deepEqual(await fs.readFile(path.join(f.target, 'world/level.dat')), before)
  assert.deepEqual(await fs.readFile(path.join(f.world, 'level.dat')), before)
  const properties = Object.fromEntries((await fs.readFile(path.join(f.target, 'server.properties'), 'utf8')).trim().split('\n').map(line => line.split('=')))
  assert.equal(properties['server-ip'], '127.0.0.1')
  assert.equal(properties['server-port'], '25567')
  assert.equal(properties['rcon.port'], '25577')
  assert.equal(properties['pause-when-empty-seconds'], '-1')
  assert.equal(properties['white-list'], 'true')
  assert.equal(properties['enforce-whitelist'], 'true')
  assert.equal(properties['simulation-distance'], '4')
  assert.equal(properties['allow-nether'], 'false')
  assert.notEqual(properties['rcon.password'], 'main-secret')
  assert.equal(state.host, '127.0.0.1')
  assert.equal(state.port, 25567)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.target, 'ops.json'))), [])
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.target, 'whitelist.json'))), [])
  await assert.rejects(prepareClone(f.backup, f.target, { sourceDirectory: f.source }), /exist/i)
})

for (const [label, settings] of [
  ['spawn chunks', { rules: { spawnChunkRadius: nbt.string('2') } }],
  ['non-vanilla datapacks', { enabled: ['vanilla', 'file/startup'] }],
  ['persisted forced chunks', { forced: true }]
]) {
  test(`clone rejects ${label} before creating or starting its world`, async t => {
    const { prepareClone } = implementation()
    const f = await fixture(t, settings)
    await assert.rejects(prepareClone(f.backup, f.target, { sourceDirectory: f.source }), /spawn|datapack|forced/i)
    await assert.rejects(fs.access(f.target), { code: 'ENOENT' })
  })
}

test('clone rejects a changed backup before copying it', async t => {
  const { prepareClone } = implementation()
  const f = await fixture(t)
  await fs.writeFile(path.join(f.backup, 'world/level.dat'), 'corrupt')
  await assert.rejects(prepareClone(f.backup, f.target, { sourceDirectory: f.source }), /checksum/i)
  await assert.rejects(fs.access(f.target), { code: 'ENOENT' })
})

function clockHarness ({ initial = 100, existingStep = false, freeze = true, advance = 1, lostReply = false } = {}) {
  const state = { host: '127.0.0.1', version: '1.21.4' }
  const commands = []
  const records = []
  let gameTime = initial
  let remaining = 0
  let wall = 0
  return {
    state,
    commands,
    records,
    settings: {
      now: () => wall,
      wait: async ms => {
        wall += ms
        const ticks = Math.min(remaining, advance)
        gameTime = (gameTime + ticks) % 2147483647
        remaining -= ticks
      },
      timeoutMs: 500,
      saveState: async value => { records.push(JSON.parse(JSON.stringify(value))) },
      command: async text => {
        commands.push(text)
        if (text === 'tick freeze') { freeze = true; return 'The game is frozen' }
        if (text === 'tick query') return freeze ? 'The game is frozen' : 'The game is running normally'
        if (text === 'tick step stop') {
          if (existingStep || remaining) {
            existingStep = false
            remaining = 0
            return 'Interrupted the current tick step'
          }
          return 'No tick step in progress'
        }
        if (text === 'time query gametime') return `The time is ${gameTime}`
        if (/^tick step \d+$/.test(text)) {
          assert.ok(records.at(-1)?.pendingStep, 'Intent must be durable before the mutating command')
          remaining = Number(text.split(' ')[2])
          if (lostReply) throw new Error('lost step response')
          return `Stepping ${remaining} tick(s)`
        }
        throw new Error(`Unexpected command: ${text}`)
      }
    }
  }
}

test('step waits for the exact gametime delta despite query already reporting frozen', async () => {
  const { stepFrozen } = implementation()
  const h = clockHarness()
  const result = await stepFrozen(h.state, 3, h.settings)
  assert.equal(result.before, 100)
  assert.equal(result.after, 103)
  assert.equal(result.ticks, 3)
  assert.equal(h.state.pendingStep, null)
  assert.ok(h.commands.filter(command => command === 'time query gametime').length >= 4)
  assert.equal(h.commands.filter(command => command === 'tick step 3').length, 1)
})

test('step handles the gametime command integer wraparound', async () => {
  const { stepFrozen } = implementation()
  const h = clockHarness({ initial: 2147483646 })
  const result = await stepFrozen(h.state, 2, h.settings)
  assert.equal(result.after, 1)
  assert.equal(result.ticks, 2)
})

test('step refuses a previous pending operation without sending another command', async () => {
  const { stepFrozen } = implementation()
  const h = clockHarness()
  h.state.pendingStep = { before: 99, ticks: 5 }
  await assert.rejects(stepFrozen(h.state, 1, h.settings), /pending/i)
  assert.deepEqual(h.commands, [])
})

test('step safely interrupts externally pending ticks and refuses to add new ticks', async () => {
  const { stepFrozen } = implementation()
  const h = clockHarness({ existingStep: true })
  await assert.rejects(stepFrozen(h.state, 1, h.settings), /previous|existing|progress/i)
  assert.ok(!h.commands.includes('tick step 1'))
})

test('step refuses an unfrozen server and invalid tick counts', async () => {
  const { stepFrozen } = implementation()
  const h = clockHarness({ freeze: false })
  await assert.rejects(stepFrozen(h.state, 1, h.settings), /frozen/i)
  for (const ticks of [0, -1, 1.5, 10001, NaN]) await assert.rejects(stepFrozen(h.state, ticks, h.settings), /tick/i)
  assert.ok(!h.commands.some(command => /^tick step /.test(command)))
})

test('timeout stops remaining ticks and preserves the unresolved durable intent', async () => {
  const { stepFrozen } = implementation()
  const h = clockHarness({ advance: 0 })
  await assert.rejects(stepFrozen(h.state, 2, h.settings), /timed out/i)
  assert.equal(h.state.pendingStep.ticks, 2)
  assert.equal(h.commands.filter(command => command === 'tick step 2').length, 1)
  assert.equal(h.commands.at(-1), 'tick step stop')
})

test('a lost mutation reply is never retried and retains an uncertain pending operation', async () => {
  const { stepFrozen } = implementation()
  const h = clockHarness({ lostReply: true })
  await assert.rejects(stepFrozen(h.state, 1, h.settings), /lost step response/i)
  assert.equal(h.commands.filter(command => command === 'tick step 1').length, 1)
  assert.equal(h.state.pendingStep.ticks, 1)
  assert.equal(h.commands.at(-1), 'tick step stop')
})

test('failure to persist completion retains the pending operation and blocks another step', async () => {
  const { stepFrozen } = implementation()
  const h = clockHarness()
  const save = h.settings.saveState
  h.settings.saveState = async state => {
    if (!state.pendingStep) throw new Error('disk full')
    await save(state)
  }
  await assert.rejects(stepFrozen(h.state, 1, h.settings), /disk full/)
  await assert.rejects(stepFrozen(h.state, 1, h.settings), /pending/)
  assert.equal(h.commands.filter(command => command === 'tick step 1').length, 1)
})

test('unexpected unfreezing after a step is frozen and stopped before reporting failure', async () => {
  const { stepFrozen } = implementation()
  const h = clockHarness()
  const command = h.settings.command
  let queryCount = 0
  h.settings.command = async text => {
    const result = await command(text)
    if (text === 'tick query' && ++queryCount === 2) return 'The game is running normally'
    return result
  }
  await assert.rejects(stepFrozen(h.state, 1, h.settings), /no longer frozen/)
  assert.deepEqual(h.commands.slice(-2), ['tick freeze', 'tick step stop'])
  assert.ok(h.state.pendingStep)
})

async function isolatedLauncher (t, { loaded = false, gateReady = true } = {}) {
  const f = await fixture(t)
  const runtime = path.join(f.root, '.runtime')
  await fs.mkdir(runtime)
  await fs.rename(f.source, path.join(runtime, 'server'))
  const manifest = JSON.parse(await fs.readFile(path.join(f.backup, 'manifest.json'), 'utf8'))
  manifest.server.directory = path.join(runtime, 'server')
  await fs.writeFile(path.join(f.backup, 'manifest.json'), JSON.stringify(manifest))
  const commands = []
  const signals = []
  const javaArguments = []
  let launched = 0
  const command = async (config, text) => {
    assert.equal(config.port, 25577)
    commands.push(text)
    if (text === 'tick freeze') return 'The game is frozen'
    if (text === 'tick query') return 'The game is frozen'
    if (text === 'time query gametime') return 'The time is 200'
    if (text.startsWith('execute if loaded ')) return loaded ? 'Test passed' : 'Test failed'
    throw new Error(`Unexpected startup command: ${text}`)
  }
  const filename = require.resolve('../scripts/server-clone')
  const module = { exports: {} }
  const isolatedRequire = name => {
    if (name === './server-backup') return require('../scripts/server-backup')
    if (name === './server-local') return { selectPort: async ports => ports[0], rconCommand: command }
    if (name === './build-observer-gate') return { buildObserverGate: async () => ({ agentJar: path.join(f.root, 'agent.jar'), bridgeJar: path.join(f.root, 'bridge.jar'), sha256: { agent: 'a'.repeat(64), bridge: 'b'.repeat(64) }, targetJarSha256: 'c'.repeat(64) }) }
    if (name === 'node:child_process') {
      return {
        spawnSync: () => ({ status: 0, stderr: 'openjdk version "21.0.5"' }),
        spawn: (_file, _args, options) => {
          launched++
          javaArguments.push([..._args])
          const child = new EventEmitter()
          child.pid = process.pid
          child.unref = () => {}
          child.kill = signal => signals.push(signal)
          Promise.all([
            fs.writeFile(path.join(options.cwd, 'server.log'), 'Done (0.1s)!'),
            fs.writeFile(path.join(options.cwd, 'observer-gate-status.json'), JSON.stringify({ pid: process.pid, hooksReady: gateReady, activeMode: 'HOLD', controlValid: true }))
          ]).then(() => child.emit('spawn'), error => child.emit('error', error))
          return child
        }
      }
    }
    return require(name)
  }
  vm.runInNewContext(await fs.readFile(filename, 'utf8'), { require: isolatedRequire, module, __dirname: path.join(f.root, 'scripts'), process, console: { log: () => {} }, setTimeout }, { filename })
  return { ...f, manager: module.exports, commands, signals, javaArguments, launches: () => launched }
}

test('startup freezes first and verifies every machine chunk remains unloaded without stepping or forceloading', async t => {
  const f = await isolatedLauncher(t)
  const result = await f.manager.main(['start', f.backup])
  assert.equal(result.initialized, true)
  assert.equal(result.frozen, true)
  assert.equal(result.password, undefined)
  assert.equal(f.commands[0], 'tick freeze')
  assert.equal(f.commands.filter(command => command.startsWith('execute if loaded ')).length, 12)
  assert.ok(!f.commands.some(command => command.startsWith('tick step') || command.startsWith('forceload')))
  assert.equal(f.launches(), 1)
  assert.deepEqual(f.signals, [])
})

test('a machine chunk already loaded at startup causes the owned clone to stop without further actions', async t => {
  const f = await isolatedLauncher(t, { loaded: true })
  await assert.rejects(f.manager.main(['start', f.backup]), /loaded before/)
  assert.equal(f.launches(), 1)
  assert.deepEqual(f.signals, ['SIGTERM'])
  assert.ok(!f.commands.some(command => command.startsWith('tick step') || command.startsWith('forceload')))
})

test('explicit observer hold launches only the clone with a valid HOLD control and ready hooks', async t => {
  const f = await isolatedLauncher(t)
  const result = await f.manager.main(['start', f.backup, '--observer-hold'])
  assert.equal(result.observerGate.initialMode, 'HOLD')
  assert.equal(await fs.readFile(result.observerGate.controlFile, 'utf8'), 'HOLD\n')
  assert.ok(f.javaArguments[0].some(arg => arg === `-javaagent:${result.observerGate.agentJar}=${result.observerGate.controlFile}`))
  assert.equal(f.commands[0], 'tick freeze')
  assert.equal(result.gateStatus.hooksReady, true)
  assert.equal(result.gateStatus.pid, process.pid)
})

test('observer hold refuses to return a ready server when either hook is absent', async t => {
  const f = await isolatedLauncher(t, { gateReady: false })
  await assert.rejects(f.manager.main(['start', f.backup, '--observer-hold']), /observer.*hook/i)
  assert.deepEqual(f.signals, ['SIGTERM'])
  assert.ok(!f.commands.some(command => command.startsWith('tick step') || command.startsWith('forceload')))
})

test('observer gate status rejects stale identity, invalid control, or mode disagreement', async t => {
  const f = await isolatedLauncher(t)
  const started = await f.manager.main(['start', f.backup, '--observer-hold'])
  for (const changes of [{ pid: process.pid + 1 }, { controlValid: false }, { activeMode: 'OFF' }]) {
    await fs.writeFile(started.observerGate.statusFile, JSON.stringify({ pid: process.pid, hooksReady: true, activeMode: 'HOLD', controlValid: true, ...changes }))
    await assert.rejects(f.manager.inspectObserverGate(started), /observer/i)
  }
  await fs.writeFile(started.observerGate.controlFile, 'bad\n')
  await assert.rejects(f.manager.inspectObserverGate(started), /control/i)
})
