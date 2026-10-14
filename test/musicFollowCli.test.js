const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')

let parseArguments, authenticatedChat, acquireLock, stageBot, waitForTrackChunks, createFollowSession
try { ({ parseArguments, authenticatedChat, acquireLock, stageBot, waitForTrackChunks, createFollowSession } = require('../scripts/music-follow')) } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }

const flags = ['--schematic', '/tmp/bird.schem', '--origin', '0,64,3456', '--server-profile', '/tmp/server.json', '--state-dir', '/tmp/music-follow']

test('follow CLI requires an explicit blueprint, origin and matching local profile', () => {
  assert.equal(typeof parseArguments, 'function', 'Music follow CLI must be implemented')
  const options = parseArguments(flags)
  assert.deepEqual({ ...options.origin }, { x: 0, y: 64, z: 3456 })
  assert.equal(options.host, '127.0.0.1')
  assert.equal(options.port, 25566)
  assert.equal(options.version, '1.21.11')
  assert.equal(options.username, 'MusicFollow')
  for (const extra of [['--host', 'example.com'], ['--port', '0'], ['--username', '@a'], ['--version', 'latest'], ['--unknown', 'x'], ['--origin', '1,2,3']]) assert.throws(() => parseArguments([...flags, ...extra]))
  assert.throws(() => parseArguments(flags.slice(0, 4)), /required/i)
  assert.throws(() => parseArguments(['--schematic', 'relative.schem', ...flags.slice(2)]), /absolute/i)
})

test('chat controls resolve sender UUID and never trust formatted or unknown player names', () => {
  assert.equal(typeof authenticatedChat, 'function')
  const uuid = '00000000-0000-0000-0000-000000000001'
  const bot = { username: 'MusicFollow', players: { Alice: { username: 'Alice', uuid }, Bad: { username: 'Alice', uuid: '00000000-0000-0000-0000-000000000002' } } }
  assert.deepEqual(authenticatedChat(bot, { sender: uuid, plainMessage: '!watch' }), { username: 'Alice', message: '!watch' })
  for (const packet of [{ sender: '00000000-0000-0000-0000-000000000099', plainMessage: '!watch', senderName: '{"text":"Alice"}' }, { sender: uuid, formattedMessage: '<Alice> !watch' }, { sender: uuid, plainMessage: '!watch\nstop' }]) assert.equal(authenticatedChat(bot, packet), null)
  bot.players.Imposter = { username: 'Imposter', uuid }
  assert.equal(authenticatedChat(bot, { sender: uuid, plainMessage: '!watch' }), null, 'Ambiguous duplicate UUIDs fail closed')
})

test('only one follow process can own a state directory and release allows a new owner', async t => {
  assert.equal(typeof acquireLock, 'function')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'music-follow-lock-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const release = await acquireLock(directory)
  await assert.rejects(acquireLock(directory), /already running/i)
  await release()
  const releaseAgain = await acquireLock(directory)
  await releaseAgain()
})

test('initial staging confirms server movement and cleans up on a rejected command', async () => {
  const bot = new EventEmitter()
  bot.username = 'MusicFollow'
  bot.entity = { position: new Vec3(0, 64, 0) }
  const home = new Vec3(1.5, 72, 3474.5)
  const pending = stageBot(bot, { sendCommand: async command => { assert.equal(command, 'tp MusicFollow 1.5 72 3474.5 -90 20'); setImmediate(() => { bot.entity.position = home; bot.emit('forcedMove') }) } }, { home })
  await pending
  assert.equal(bot.listenerCount('forcedMove'), 0)
  assert.equal(bot.listenerCount('move'), 0)
  await assert.rejects(stageBot(bot, { sendCommand: async () => { throw new Error('rejected staging') } }, { home }, 25), /rejected staging/)
  assert.equal(bot.listenerCount('forcedMove'), 0)
})

test('follow session stages before attaching controls and restores viewers when stopped', async () => {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot._client.write = () => {}
  bot.username = 'MusicFollow'
  bot.players = {}
  bot.entity = { position: new Vec3(0, 64, 0) }
  const actions = []
  bot.waitForChunksToLoad = async () => { actions.push('chunks') }
  bot.blockAt = pos => ({ name: pos.y === 68 ? 'stone_button' : 'repeater' })
  bot.quit = () => { actions.push('quit'); bot.emit('end') }
  const home = new Vec3(1.5, 72, 3474.5)
  const track = { home, button: new Vec3(1, 68, 3470), modules: [{ pos: new Vec3(2, 67, 3470), delay: 1 }] }
  const session = await createFollowSession(parseArguments(flags), {
    track,
    emit: () => {},
    saveStatus: async () => {},
    createBot: () => { queueMicrotask(() => bot.emit('spawn')); return bot },
    prepare: async () => { actions.push('prepare') },
    console: { sendCommand: async () => { actions.push('stage'); queueMicrotask(() => { bot.entity.position = home; bot.emit('forcedMove') }) } },
    createFollower: () => { assert.ok(bot.entity.position.equals(home)); actions.push('follower'); return { status: { phase: 'idle' }, step: () => {}, stop: () => { actions.push('follower-stop') } } },
    createSpectators: () => { actions.push('spectators'); return { ready: Promise.resolve(), viewerCount: 0, stop: async () => { actions.push('restore') } } }
  })
  assert.equal(session.status().phase, 'idle')
  assert.equal(bot.physicsEnabled, false)
  await session.stop()
  await session.stop()
  assert.deepEqual(actions, ['prepare', 'stage', 'chunks', 'follower', 'spectators', 'follower-stop', 'restore', 'quit'])
  assert.equal(bot._client.listenerCount('playerChat'), 0)
})

test('an already cancelled follow session never connects another bot', async () => {
  await assert.rejects(createFollowSession(parseArguments(flags), { track: {}, emit: () => {}, saveStatus: async () => {}, signal: AbortSignal.abort(), console: {}, createBot: () => { throw new Error('Unexpected connection') } }), /abort|stopped/i)
})

test('cancellation during connection closes the pending bot without waiting for spawn', async t => {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.quit = () => bot.emit('end')
  const controller = new AbortController()
  let timeout
  const pending = createFollowSession(parseArguments(flags), { track: {}, emit: () => {}, saveStatus: async () => {}, signal: controller.signal, console: {}, createBot: () => bot })
  t.after(async () => { clearTimeout(timeout); bot.emit('end'); await pending.catch(() => {}) })
  setImmediate(() => controller.abort())
  await assert.rejects(Promise.race([pending, new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('Connection cancellation was ignored')), 50) })]), /stopped|abort/i)
  assert.equal(bot.listenerCount('spawn'), 0)
})

test('the camera becomes ready only after the actual start button and first repeater are loaded', async () => {
  assert.equal(typeof waitForTrackChunks, 'function')
  const button = new Vec3(1, 68, 3470)
  const first = new Vec3(2, 67, 3470)
  const track = { button, modules: [{ pos: first }] }
  const bot = { waitForChunksToLoad: async () => {}, blockAt: pos => pos.equals(button) ? { name: 'stone_button' } : { name: 'repeater' } }
  await waitForTrackChunks(bot, track)
  bot.blockAt = () => null
  await assert.rejects(waitForTrackChunks(bot, track), /button|repeater|loaded/i)
  await assert.rejects(waitForTrackChunks(bot, track, AbortSignal.abort()), /abort|stopped/i)
})
