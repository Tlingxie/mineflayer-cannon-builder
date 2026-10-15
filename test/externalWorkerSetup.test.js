const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const syncFs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { EventEmitter } = require('node:events')
const { prepareExternalWorker } = require('../lib/externalWorkerSetup')

const uuid = 'a10b4567-89ab-4cde-8123-456789abcdef'

async function fixture (t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'external-worker-test-'))
  const pipe = path.join(directory, 'console.pipe')
  await promisify(execFile)('mkfifo', [pipe])
  const reader = await fs.open(pipe, syncFs.constants.O_RDONLY | syncFs.constants.O_NONBLOCK)
  t.after(async () => { await reader.close(); await fs.rm(directory, { recursive: true, force: true }) })
  const bot = Object.assign(new EventEmitter(), {
    username: 'Worker_01',
    _client: { state: 'play', ended: false },
    entity: { id: 23, username: 'Worker_01' },
    player: { username: 'Worker_01', uuid },
    game: { gameMode: 'survival' }
  })
  bot.players = { Worker_01: bot.player }
  const options = { host: '127.0.0.1', port: 25566, version: '1.21.11', serverProfile: path.join(directory, 'profile.json') }
  const profile = { schemaVersion: 1, kind: 'external-console', host: options.host, port: options.port, version: options.version, pid: 12345, processStart: 'a validated process', directory, pipe, log: path.join(directory, 'console.log') }
  const settings = { readValidatedProfile: async () => ({ ...profile }), timeoutMs: 150, pollIntervalMs: 5 }
  const operators = async (entries = [{ name: bot.username, uuid, level: 4 }]) => fs.writeFile(path.join(directory, 'ops.json'), JSON.stringify(entries))
  const commands = async () => {
    const buffer = Buffer.alloc(4096)
    try { return buffer.subarray(0, (await reader.read(buffer, 0, buffer.length, null)).bytesRead).toString() } catch (error) { if (error.code === 'EAGAIN') return ''; throw error }
  }
  return { bot, options, profile, settings, operators, commands, reader }
}

test('external preparation only sets the exact online worker creative without granting operator', async t => {
  const f = await fixture(t)
  let observed = ''
  const timer = setInterval(async () => {
    observed += await f.commands()
    if (observed.includes('gamemode creative')) {
      clearInterval(timer)
      f.bot.game.gameMode = 'creative'
    }
  }, 5)
  t.after(() => clearInterval(timer))
  const result = await prepareExternalWorker(f.bot, f.options, f.settings)
  assert.equal(observed, 'gamemode creative @a[name=Worker_01,limit=1]\n')
  assert.deepEqual(result, { username: 'Worker_01', uuid, gameMode: 'creative' })
  assert.equal(JSON.stringify(result).includes(f.profile.directory), false)
})

test('external preparation rejects unsafe names, missing spawn and mismatched online identity before commands', async t => {
  const cases = [
    bot => { bot.username = 'Worker\nop Somebody' },
    bot => { bot._client.state = 'login' },
    bot => { bot._client.ended = true },
    bot => { bot.entity = null },
    bot => { bot.player.username = 'SomebodyElse' },
    bot => { bot.player.uuid = 'invalid' },
    bot => { delete bot.players.Worker_01 }
  ]
  for (const mutate of cases) {
    const f = await fixture(t)
    mutate(f.bot)
    await assert.rejects(prepareExternalWorker(f.bot, f.options, f.settings), /online|player|username|spawn/i)
    assert.equal(await f.commands(), '')
  }
})

test('external preparation rejects changed process identity and FIFO replacement without writing', async t => {
  for (const change of ['process', 'fifo', 'symlink']) {
    const f = await fixture(t)
    let reads = 0
    f.settings.readValidatedProfile = async () => {
      if (++reads === 2) {
        if (change === 'process') return { ...f.profile, processStart: 'replacement process' }
        await fs.rename(f.profile.pipe, f.profile.pipe + '.original')
        if (change === 'fifo') await promisify(execFile)('mkfifo', [f.profile.pipe])
        else await fs.symlink(f.profile.pipe + '.original', f.profile.pipe)
      }
      return { ...f.profile }
    }
    await assert.rejects(prepareExternalWorker(f.bot, f.options, f.settings), /identity|FIFO|pipe|symbolic/i)
    assert.equal(await f.commands(), '')
  }
})

test('creative preparation does not read or change existing operator permissions', async t => {
  for (const entries of [[], [{ name: 'Worker_01', uuid, level: 4 }], [{ name: 'Other', uuid, level: 1 }]]) {
    const f = await fixture(t)
    f.bot.game.gameMode = 'creative'
    await f.operators(entries)
    const contents = await fs.readFile(path.join(f.profile.directory, 'ops.json'), 'utf8')
    const filesystem = Object.create(fs)
    filesystem.readFile = async () => { throw new Error('Operator files must not be read') }
    assert.deepEqual(await prepareExternalWorker(f.bot, f.options, { ...f.settings, fs: filesystem }), { username: 'Worker_01', uuid, gameMode: 'creative' })
    assert.equal(await f.commands(), 'gamemode creative @a[name=Worker_01,limit=1]\n')
    assert.equal(await fs.readFile(path.join(f.profile.directory, 'ops.json'), 'utf8'), contents)
  }
})

test('external preparation requires observed creative mode and rechecks the online UUID', async t => {
  const waiting = await fixture(t)
  await assert.rejects(prepareExternalWorker(waiting.bot, waiting.options, { ...waiting.settings, timeoutMs: 25 }), /confirm|timed out/i)
  const changed = await fixture(t)
  const running = prepareExternalWorker(changed.bot, changed.options, changed.settings)
  const timer = setTimeout(() => {
    changed.bot.player.uuid = 'b10b4567-89ab-4cde-8123-456789abcdef'
    changed.bot.game.gameMode = 'creative'
  }, 10)
  t.after(() => clearTimeout(timer))
  await assert.rejects(running, /identity|UUID/i)
})

test('external preparation cancels before grants and rejects disconnect while awaiting confirmation', async t => {
  const f = await fixture(t)
  await assert.rejects(prepareExternalWorker(f.bot, f.options, { ...f.settings, signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.equal(await f.commands(), '')
  const running = prepareExternalWorker(f.bot, f.options, f.settings)
  const timer = setTimeout(() => { f.bot._client.ended = true; f.bot.emit('end', 'disconnected') }, 10)
  t.after(() => clearTimeout(timer))
  await assert.rejects(running, /online|disconnect/i)
})

test('external preparation fails promptly with no FIFO reader instead of blocking', async t => {
  const f = await fixture(t)
  await f.reader.close()
  await assert.rejects(prepareExternalWorker(f.bot, f.options, f.settings), /reader|ENXIO|console/i)
})
