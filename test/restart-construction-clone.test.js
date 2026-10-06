const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const os = require('node:os')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const nbt = require('prismarine-nbt')
const { snapshotWorld } = require('../scripts/server-backup')

const implementation = () => require('../scripts/restart-construction-clone')

test('restart requires an explicit backup and exact current process identity', () => {
  const { parseOptions } = implementation()
  const args = ['--backup', '/backup', '--expected-current-pid', '86758', '--expected-started-at', '2026-10-03T19:44:09.587Z']
  assert.deepEqual(parseOptions(args), { backup: '/backup', expectedCurrentPid: 86758, expectedStartedAt: '2026-10-03T19:44:09.587Z' })
  assert.throws(() => parseOptions([]), /backup/)
  assert.throws(() => parseOptions(args.slice(0, -2)), /started/)
  assert.throws(() => parseOptions(args.map(value => value === '86758' ? '0' : value)), /pid/)
  assert.throws(() => parseOptions([...args, '--force']))
})

function harness () {
  const calls = []
  const events = []
  const current = { pid: 86758, startedAt: '2026-10-03T19:44:09.587Z', directory: '/owned/old', host: '127.0.0.1', port: 25567, version: '1.21.4', password: 'secret' }
  const next = { ...current, pid: 123, startedAt: '2026-10-04T01:00:00.000Z', directory: '/owned/new', password: 'new-secret', initialized: true, running: true, frozen: true, gateStatus: { activeMode: 'HOLD' } }
  let live = current
  const options = { backup: '/verified/backup', expectedCurrentPid: current.pid, expectedStartedAt: current.startedAt }
  const dependencies = {
    acquireLock: async () => { calls.push('lock'); return async () => calls.push('unlock') },
    readCurrent: async () => ({ ...live }),
    preflight: async () => { calls.push('preflight'); return { backup: options.backup, manifestSha256: 'a'.repeat(64), sourceDirectory: current.directory, runtimeDirectory: '/official', expectedJarSha1: 'official' } },
    backupCurrent: async () => { calls.push('backup'); return { directory: '/preserved/failure', constructionFrozen: true } },
    verifyPreserved: async () => { calls.push('verify-preserved') },
    stopCurrent: async () => { calls.push('stop'); return { running: false, pid: live.pid } },
    startNew: async (backup, settings) => {
      calls.push('start')
      assert.equal(backup, options.backup)
      assert.equal(settings.observerHold, true)
      assert.equal(settings.sourceDirectory, current.directory)
      assert.equal(settings.expectedManifestSha256, 'a'.repeat(64))
      live = next
      const { password, ...publicState } = next
      return publicState
    },
    attestNew: async state => { calls.push('attest'); assert.equal(state.pid, next.pid); return { frozen: true, quiescent: true, gameTime: 10, gateMode: 'HOLD' } },
    openWhitelist: async state => { calls.push('whitelist-off'); assert.equal(state.pid, next.pid); assert.equal(state.password, 'new-secret'); return 'Whitelist is now turned off' },
    quarantineNew: async () => { calls.push('quarantine'); return [] },
    record: async event => events.push(event)
  }
  return { calls, events, current, next, options, dependencies, setLive: state => { live = state } }
}

test('restart validates first, preserves the failed world, stops, starts HOLD and only then opens the frozen clone', async () => {
  const { restartConstructionClone } = implementation()
  const h = harness()
  const result = await restartConstructionClone(h.options, h.dependencies)
  assert.deepEqual(h.calls, ['lock', 'preflight', 'backup', 'verify-preserved', 'stop', 'start', 'attest', 'whitelist-off', 'attest', 'unlock'])
  assert.equal(result.preserved.directory, '/preserved/failure')
  assert.equal(result.current.pid, 123)
  assert.equal(JSON.stringify(h.events).includes('secret'), false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('invalid backup and changed current identity never stop the existing clone', async () => {
  const { restartConstructionClone } = implementation()
  for (const failure of ['preflight', 'identity', 'backup', 'verify-preserved']) {
    const h = harness()
    if (failure === 'identity') h.current.pid++
    else if (failure === 'preflight') h.dependencies.preflight = async () => { throw new Error('invalid backup') }
    else if (failure === 'backup') h.dependencies.backupCurrent = async () => { throw new Error('backup failed') }
    else h.dependencies.verifyPreserved = async () => { throw new Error('checksum mismatch') }
    await assert.rejects(restartConstructionClone(h.options, h.dependencies))
    assert.equal(h.calls.includes('stop'), false)
    assert.equal(h.calls.at(-1), 'unlock')
  }
})

test('a state change while stop intent is persisted prevents stop and a startup failure never opens whitelist', async () => {
  const { restartConstructionClone } = implementation()
  const h = harness()
  h.dependencies.record = async event => { if (event.type === 'stop-intent') h.setLive({ ...h.current, pid: 999 }) }
  await assert.rejects(restartConstructionClone(h.options, h.dependencies), /identity/)
  assert.equal(h.calls.includes('stop'), false)
  const failed = harness()
  failed.dependencies.startNew = async () => { failed.calls.push('start'); throw new Error('startup failed') }
  await assert.rejects(restartConstructionClone(failed.options, failed.dependencies), /startup failed/)
  assert.equal(failed.calls.includes('whitelist-off'), false)
  assert.equal(failed.events.some(event => event.type === 'failed' && event.preserved?.directory === '/preserved/failure'), true)
})

test('unfrozen or wrong HOLD attestation never opens whitelist', async () => {
  const { restartConstructionClone } = implementation()
  for (const patch of [{ frozen: false }, { quiescent: false }, { gateMode: 'OFF' }]) {
    const h = harness()
    h.dependencies.attestNew = async () => ({ frozen: true, quiescent: true, gateMode: 'HOLD', ...patch })
    await assert.rejects(restartConstructionClone(h.options, h.dependencies), /frozen|HOLD/)
    assert.equal(h.calls.includes('whitelist-off'), false)
    assert.equal(h.calls.includes('quarantine'), true)
  }
})

test('clone backup inspection separates its real source identity from official runtime files without copying or editing source', async t => {
  const { prepareClone } = require('../scripts/server-clone')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clone-restart-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'old-clone')
  const runtime = path.join(root, 'official')
  const world = path.join(source, 'world')
  await fs.mkdir(world, { recursive: true })
  await fs.mkdir(runtime)
  const data = nbt.comp({ Data: nbt.comp({ GameRules: nbt.comp({ spawnChunkRadius: nbt.string('0') }), SpawnX: nbt.int(0), SpawnZ: nbt.int(0), DataPacks: nbt.comp({ Enabled: nbt.list(nbt.string(['vanilla'])) }), ScheduledEvents: nbt.list(nbt.comp([])) }) })
  await fs.writeFile(path.join(world, 'level.dat'), zlib.gzipSync(nbt.writeUncompressed(data)))
  await fs.writeFile(path.join(source, 'server.properties'), 'server-ip=127.0.0.1\nserver-port=25567\nlevel-name=world\n')
  const jar = Buffer.from('test-official-runtime')
  const sha1 = crypto.createHash('sha1').update(jar).digest('hex')
  await fs.writeFile(path.join(runtime, 'minecraft_server.1.21.4.jar'), jar)
  await fs.writeFile(path.join(runtime, 'download.json'), JSON.stringify({ version: '1.21.4', sha1, size: jar.length }))
  await fs.writeFile(path.join(runtime, 'eula.txt'), 'eula=true\n')
  const backup = path.join(root, 'backup')
  await snapshotWorld(world, backup, { constructionFrozen: true, server: { kind: 'initialization-clone', host: '127.0.0.1', port: 25567, version: '1.21.4', directory: source } })
  const original = await fs.readFile(path.join(backup, 'manifest.json'))
  const target = path.join(root, 'new-clone')
  const settings = { sourceDirectory: source, runtimeDirectory: runtime, expectedJarSha1: sha1 }
  const inspected = await prepareClone(backup, target, { ...settings, validateOnly: true })
  assert.equal(inspected.jar, path.join(await fs.realpath(runtime), 'minecraft_server.1.21.4.jar'))
  await assert.rejects(fs.access(target), { code: 'ENOENT' })
  await assert.rejects(prepareClone(backup, target, { ...settings, expectedJarSha1: '0'.repeat(40) }), /JAR checksum/)
  const state = await prepareClone(backup, target, settings)
  assert.equal(state.jar, inspected.jar)
  assert.deepEqual(await fs.readFile(path.join(backup, 'manifest.json')), original)
  assert.deepEqual(await fs.readFile(path.join(target, 'world/level.dat')), await fs.readFile(path.join(world, 'level.dat')))
  data.value.Data.value.ScheduledEvents = nbt.list(nbt.comp([{ Name: nbt.string('fixture'), TriggerTime: nbt.long([0, 1]) }]))
  await fs.writeFile(path.join(world, 'level.dat'), zlib.gzipSync(nbt.writeUncompressed(data)))
  const scheduled = path.join(root, 'scheduled-backup')
  await snapshotWorld(world, scheduled, { constructionFrozen: true, server: { kind: 'initialization-clone', host: '127.0.0.1', port: 25567, version: '1.21.4', directory: source } })
  await assert.rejects(prepareClone(scheduled, path.join(root, 'must-not-exist'), { ...settings, validateOnly: true }), /scheduled command/)
  await assert.rejects(fs.access(path.join(root, 'must-not-exist')), { code: 'ENOENT' })
})
