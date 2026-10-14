const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let createMusicSpectators
try { ({ createMusicSpectators } = require('../lib/musicSpectators')) } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }

const aliceUuid = '00000000-0000-0000-0000-000000000001'
const bobUuid = '00000000-0000-0000-0000-000000000002'
const startPositions = {
  Alice: { x: 12.25, y: 64, z: 30.75, yaw: -90, pitch: 15, dimension: 'minecraft:overworld' },
  Bob: { x: -20.25, y: 70, z: 9.5, yaw: 120, pitch: -30, dimension: 'minecraft:the_nether' }
}
const watchCommands = name => [`gamemode spectator ${name}`, `spectate MusicCamera ${name}`]
const returnCommand = name => {
  const { x, y, z, yaw, pitch, dimension } = startPositions[name]
  return `execute in ${dimension} run tp ${name} ${x} ${y} ${z} ${yaw} ${pitch}`
}
const unwatchCommands = (name, uuid, mode) => [`execute as ${name} run spectate`, returnCommand(name), `gamemode ${mode} ${name}`]

function fixture (options = {}) {
  assert.equal(typeof createMusicSpectators, 'function', 'Music spectator controls must be implemented')
  const bot = new EventEmitter()
  bot.username = 'MusicCamera'
  bot.players = {
    Alice: { username: 'Alice', uuid: aliceUuid, gamemode: 1 },
    Bob: { username: 'Bob', uuid: bobUuid, gamemode: 0 }
  }
  const commands = []
  const events = []
  const captures = []
  const { sendCommand, ...settings } = options
  const controls = createMusicSpectators(bot, {
    onEvent: event => events.push(event),
    capturePosition: async username => { captures.push(username); return { ...startPositions[username] } },
    ...settings,
    sendCommand: async command => {
      commands.push(command)
      await sendCommand?.(command)
      const change = /^gamemode (survival|creative|adventure|spectator) (\w+)$/.exec(command)
      if (change && bot.players[change[2]]) bot.players[change[2]].gamemode = ['survival', 'creative', 'adventure', 'spectator'].indexOf(change[1])
    }
  })
  return { bot, commands, events, controls, captures }
}

test('players explicitly join the camera and independently recover their original modes', async () => {
  const { controls, commands } = fixture()
  assert.equal(await controls.handleChat('Alice', '!watch'), true)
  assert.equal(await controls.handleChat('Bob', '!watch'), true)
  assert.equal(controls.viewerCount, 2)
  await controls.handleChat('Alice', '!unwatch')
  assert.equal(controls.viewerCount, 1)
  await controls.handleChat('Bob', '!unwatch')
  assert.equal(controls.viewerCount, 0)
  assert.deepEqual(commands, [
    ...watchCommands('Alice', aliceUuid), ...watchCommands('Bob', bobUuid),
    ...unwatchCommands('Alice', aliceUuid, 'creative'), ...unwatchCommands('Bob', bobUuid, 'survival')
  ])
})

test('only exact authenticated online players and exact opt-in commands are accepted', async () => {
  const { bot, controls, commands } = fixture()
  bot.players['Bad\nstop'] = { username: 'Bad\nstop', uuid: aliceUuid, gamemode: 1 }
  bot.players.Imposter = { username: 'Alice', uuid: aliceUuid, gamemode: 1 }
  bot.players.NoUuid = { username: 'NoUuid', gamemode: 1 }
  bot.players.MusicCamera = { username: 'MusicCamera', uuid: bobUuid, gamemode: 1 }
  for (const name of ['Bad\nstop', '@a', 'alice', 'Offline', 'Imposter', 'NoUuid', 'MusicCamera', '__proto__']) {
    assert.equal(await controls.handleChat(name, '!watch'), false)
  }
  for (const message of ['!watch Bob', '!watch\nstop', '!unwatch @a', 'hello', '/op Alice']) assert.equal(await controls.handleChat('Alice', message), false)
  assert.deepEqual(commands, [])
})

test('duplicate watch requests never replace the saved original mode', async () => {
  const { bot, controls, commands, captures } = fixture()
  await controls.handleChat('Alice', '!watch')
  bot.players.Alice.gamemode = 3
  await controls.handleChat('Alice', '!watch')
  assert.equal(commands.length, 2)
  await controls.handleChat('Alice', '!unwatch')
  await controls.handleChat('Alice', '!unwatch')
  assert.ok(commands.includes('gamemode creative Alice'))
  assert.equal(commands.length, 5)
  assert.deepEqual(captures, ['Alice'])
})

test('concurrent chat requests execute complete transactions in order', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const commands = []
  const { controls } = fixture({ sendCommand: async command => { commands.push(command); if (commands.length === 1) await gate } })
  const watching = controls.handleChat('Alice', '!watch')
  const leaving = controls.handleChat('Alice', '!unwatch')
  const bobWatching = controls.handleChat('Bob', '!watch')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(commands, ['gamemode spectator Alice'])
  release()
  await Promise.all([watching, leaving, bobWatching])
  assert.deepEqual(commands, [
    ...watchCommands('Alice', aliceUuid), ...unwatchCommands('Alice', aliceUuid, 'creative'),
    ...watchCommands('Bob', bobUuid)
  ])
})

test('a failed attachment compensates by clearing the camera and restoring mode', async () => {
  const commands = []
  const { controls } = fixture({ sendCommand: async command => { commands.push(command); if (command === 'spectate MusicCamera Alice') throw new Error('attachment rejected') } })
  await assert.rejects(controls.handleChat('Alice', '!watch'), /attachment rejected/)
  assert.equal(controls.viewerCount, 0)
  assert.deepEqual(commands, [...watchCommands('Alice', aliceUuid), ...unwatchCommands('Alice', aliceUuid, 'creative')])
  assert.equal(await controls.handleChat('Bob', '!watch'), true, 'A rejected transaction cannot poison the queue')
})

test('failed cleanup still attempts mode recovery and can be retried', async () => {
  let rejectClear = true
  const commands = []
  const { controls } = fixture({ sendCommand: async command => { commands.push(command); if (rejectClear && command === 'execute as Alice run spectate') throw new Error('clear rejected') } })
  await controls.handleChat('Alice', '!watch')
  await assert.rejects(controls.handleChat('Alice', '!unwatch'), /clear rejected/)
  assert.ok(commands.includes('gamemode creative Alice'))
  rejectClear = false
  await controls.handleChat('Alice', '!unwatch')
  assert.equal(controls.viewerCount, 0)
})

test('mode strings are accepted and unknown modes fail before changing the player', async () => {
  const { bot, controls, commands } = fixture()
  bot.players.Alice.gamemode = undefined
  bot.players.Alice.gameMode = 'adventure'
  await controls.handleChat('Alice', '!watch')
  await controls.handleChat('Alice', '!unwatch')
  assert.ok(commands.includes('gamemode adventure Alice'))
  bot.players.Bob.gamemode = 7
  await assert.rejects(controls.handleChat('Bob', '!watch'), /game mode/i)
  assert.equal(commands.length, 5)
})

test('a returning consenting player is reattached without losing the original mode', async () => {
  const { bot, controls, commands, captures } = fixture()
  await controls.handleChat('Alice', '!watch')
  const player = bot.players.Alice
  delete bot.players.Alice
  bot.emit('playerLeft', player)
  assert.equal(controls.viewerCount, 0)
  bot.players.Alice = { ...player, gamemode: 3 }
  bot.emit('playerJoined', bot.players.Alice)
  await controls.idle()
  assert.equal(controls.viewerCount, 1)
  assert.deepEqual(commands.slice(-2), ['gamemode spectator Alice', 'spectate MusicCamera Alice'])
  await controls.handleChat('Alice', '!unwatch')
  assert.ok(commands.includes('gamemode creative Alice'))
  assert.deepEqual(captures, ['Alice'], 'Rejoining cannot replace the original return position')
})

test('a replacement account with the same name never inherits another UUID consent', async () => {
  const { bot, controls, commands } = fixture()
  await controls.handleChat('Alice', '!watch')
  bot.players.Alice = { username: 'Alice', uuid: bobUuid, gamemode: 0 }
  bot.emit('playerJoined', bot.players.Alice)
  await controls.idle()
  assert.equal(controls.viewerCount, 0)
  assert.equal(commands.length, 2)
  await controls.handleChat('Alice', '!unwatch')
  assert.equal(commands.length, 2)
})

test('stop restores online viewers, blocks new opt-ins, and removes the join listener', async () => {
  const { bot, controls, commands } = fixture()
  await controls.handleChat('Alice', '!watch')
  await controls.handleChat('Bob', '!watch')
  await controls.stop()
  assert.equal(controls.viewerCount, 0)
  assert.equal(bot.listenerCount('playerJoined'), 0)
  assert.equal(await controls.handleChat('Alice', '!watch'), false)
  assert.deepEqual(commands.slice(-6), [...unwatchCommands('Alice', aliceUuid, 'creative'), ...unwatchCommands('Bob', bobUuid, 'survival')])
})

test('persistent consent survives controller restart and stopped offline players recover on rejoin', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'music-spectators-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, 'viewers.json')
  const first = fixture({ stateFile })
  await first.controls.handleChat('Alice', '!watch')
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.equal(saved.viewers[0].mode, 'creative')
  assert.deepEqual(saved.viewers[0].returnPosition, { ...startPositions.Alice, dimension: 'overworld' })
  delete first.bot.players.Alice
  await first.controls.stop()
  const second = fixture({ stateFile })
  second.bot.players.Alice.gamemode = 3
  await second.controls.ready
  assert.equal(second.controls.viewerCount, 0)
  assert.deepEqual(second.commands, unwatchCommands('Alice', aliceUuid, 'creative'))
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).viewers, [])
  await second.controls.stop()
})

test('identity is checked again before issuing a queued command', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const commands = []
  const { bot, controls } = fixture({ sendCommand: async command => { commands.push(command); await gate } })
  const alice = controls.handleChat('Alice', '!watch')
  const bob = controls.handleChat('Bob', '!watch')
  await new Promise(resolve => setImmediate(resolve))
  delete bot.players.Bob
  release()
  await alice
  assert.equal(await bob, false)
  assert.deepEqual(commands, watchCommands('Alice', aliceUuid))
})

test('survival viewers return to their exact original dimension and position before mode restoration', async () => {
  const { controls, commands } = fixture()
  await controls.handleChat('Bob', '!watch')
  await controls.handleChat('Bob', '!unwatch')
  assert.deepEqual(commands, [...watchCommands('Bob', bobUuid), ...unwatchCommands('Bob', bobUuid, 'survival')])
  assert.ok(commands.indexOf(returnCommand('Bob')) < commands.indexOf('gamemode survival Bob'))
})

test('already restored modes skip clearing a camera and finish pending recovery', async () => {
  let rejectClear = true
  const { bot, controls, commands } = fixture({ sendCommand: async command => { if (rejectClear && command === 'execute as Alice run spectate') throw new Error('clear rejected') } })
  await controls.handleChat('Alice', '!watch')
  await assert.rejects(controls.handleChat('Alice', '!unwatch'), /clear rejected/)
  assert.equal(bot.players.Alice.gamemode, 1)
  rejectClear = false
  const before = commands.length
  await controls.handleChat('Alice', '!unwatch')
  assert.ok(!commands.slice(before).includes('execute as Alice run spectate'))
  assert.equal(controls.viewerCount, 0)
})

test('legacy saved viewers restore mode without inventing a return position', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'music-spectators-legacy-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const stateFile = path.join(directory, 'viewers.json')
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, viewers: [{ username: 'Alice', uuid: aliceUuid, mode: 'creative', status: 'restore' }] }))
  const { bot, controls, commands } = fixture({ stateFile })
  bot.players.Alice.gamemode = 3
  await controls.ready
  assert.deepEqual(commands, ['execute as Alice run spectate', 'gamemode creative Alice'])
  await controls.stop()
})

test('failed return teleport preserves spectator mode and the return position for a safe retry', async () => {
  let rejectReturn = true
  const { bot, controls, commands } = fixture({ sendCommand: async command => { if (rejectReturn && command === returnCommand('Bob')) throw new Error('return rejected') } })
  await controls.handleChat('Bob', '!watch')
  await assert.rejects(controls.handleChat('Bob', '!unwatch'), /return rejected/)
  assert.equal(bot.players.Bob.gamemode, 3)
  assert.ok(!commands.includes('gamemode survival Bob'))
  rejectReturn = false
  await controls.handleChat('Bob', '!unwatch')
  assert.equal(bot.players.Bob.gamemode, 0)
})

test('new viewers require an actual captured position before any mode changes', async () => {
  for (const capturePosition of [undefined, async () => { throw new Error('capture rejected') }, async () => ({ ...startPositions.Alice, dimension: 'overworld run stop' }), async () => ({ ...startPositions.Alice, x: NaN })]) {
    const { controls, commands } = fixture({ capturePosition })
    await assert.rejects(controls.handleChat('Alice', '!watch'), /position|capture/i)
    assert.equal(controls.viewerCount, 0)
    assert.deepEqual(commands, [])
  }
})

test('return teleports expand tiny numbers without exponent notation or negative zero', async () => {
  const position = { x: 1e-7, y: 1e-11, z: -0, yaw: -1e-11, pitch: -0, dimension: 'overworld' }
  const { controls, commands } = fixture({ capturePosition: async () => position })
  await controls.handleChat('Alice', '!watch')
  await controls.handleChat('Alice', '!unwatch')
  assert.ok(commands.includes('execute in minecraft:overworld run tp Alice 0.0000001 0.00000000001 0 -0.00000000001 0'))
})

test('return teleports retain subnanometer precision at large valid coordinates and round negligible values to zero', async () => {
  const position = { x: 29999983.12345678, y: 2048, z: -29999983.98765432, yaw: -2.2391105e-11, pitch: -1e-15, dimension: 'the_end' }
  const { controls, commands } = fixture({ capturePosition: async () => position })
  await controls.handleChat('Alice', '!watch')
  await controls.handleChat('Alice', '!unwatch')
  const teleport = commands.find(command => command.startsWith('execute in minecraft:the_end run tp Alice '))
  const values = teleport.split(' ').slice(-5)
  assert.ok(values.every(value => /^-?\d+(?:\.\d+)?$/.test(value)))
  assert.ok(values.every(value => value !== '-0'))
  for (const [index, field] of ['x', 'y', 'z', 'yaw', 'pitch'].entries()) assert.ok(Math.abs(Number(values[index]) - position[field]) <= 1e-9, field)
  assert.equal(values.at(-1), '0')
})
