const test = require('node:test')
const assert = require('node:assert/strict')

let createMusicFollowConsole, parsePositionResponses
try { ({ createMusicFollowConsole, parsePositionResponses } = require('../lib/musicFollowConsole')) } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }

const endpoint = { host: '127.0.0.1', port: 25566, version: '1.21.11' }
const profile = { schemaVersion: 1, kind: 'external-console', ...endpoint, pid: 123, processStart: 'test', directory: '/server', pipe: '/server/stdin', log: '/server/log' }
const fifo = { dev: 1, ino: 5, isFIFO: () => true, isSymbolicLink: () => false }

async function fixture (changes = {}) {
  assert.equal(typeof createMusicFollowConsole, 'function', 'Restricted music console must be implemented')
  const writes = []
  let log = ''
  let inspections = 0
  const logStat = () => ({ dev: 1, ino: 7, size: Buffer.byteLength(log), isFile: () => true, isSymbolicLink: () => false })
  const handle = {
    stat: async () => fifo,
    write: async bytes => {
      writes.push(bytes.toString())
      for (const command of bytes.toString().trim().split('\n')) {
        let response
        if (command.startsWith('data get storage music_follow:marker_')) response = 'Storage ' + command.slice('data get storage '.length) + ' has the following contents: {}'
        else if (command === 'data get entity Alice Pos') response = 'Alice has the following entity data: [12.5d, 64.0d, -5.25d]'
        else if (command === 'data get entity Alice Dimension') response = 'Alice has the following entity data: "minecraft:the_nether"'
        else if (command === 'data get entity Alice Rotation') response = 'Alice has the following entity data: [-90.0f, 30.0f]'
        if (response) log += `[00:00:00] [Server thread/INFO]: ${response}\n`
      }
      return { bytesWritten: bytes.length }
    },
    close: async () => {}
  }
  const logHandle = { stat: async () => logStat(), close: async () => {}, read: async (buffer, start, length, offset) => { const copied = Buffer.from(log).copy(buffer, start, offset, offset + length); return { bytesRead: copied } } }
  const fs = { lstat: async filename => filename === profile.log ? logStat() : fifo, open: async filename => filename === profile.log ? logHandle : handle }
  const result = await createMusicFollowConsole(endpoint, { profilePath: '/server/profile.json', username: 'MusicFollow', readValidatedProfile: async () => { inspections++; return profile }, fs, ...changes })
  return { result, writes, inspections: () => inspections, handle, fs }
}

test('music console permits only targeted camera and viewer commands', async () => {
  const { result, writes, inspections } = await fixture()
  for (const command of ['gamemode spectator Alice', 'gamemode creative Alice', 'gamemode survival Bob', 'gamemode adventure Bob', 'spectate MusicFollow Alice', 'execute as Alice run spectate', 'tp MusicFollow 0.5 73 3470.5 -90 20']) await result.sendCommand(command)
  assert.equal(writes.length, 7)
  assert.ok(writes.every(value => value.endsWith('\n') && value.split('\n').length === 2))
  assert.ok(inspections() >= 15, 'Every write checks the live process before and after opening its FIFO')
})

test('music console rejects arbitrary commands, selectors, injections and other teleport targets', async () => {
  const { result, writes } = await fixture()
  for (const command of ['op Alice', 'stop', 'tick freeze', 'gamemode spectator @a', 'gamemode spectator Alice\nstop', 'spectate EvilBot Alice', 'execute as Alice run op Alice', 'tp Alice 0 70 0 0 0', 'tp MusicFollow NaN 70 0 0 0', 'tp MusicFollow 0 400 0 0 0', 'tp MusicFollow 30000001 70 0 0 0', 'tp MusicFollow 0 70 0 0 91']) await assert.rejects(result.sendCommand(command), /allowlist/i)
  assert.deepEqual(writes, [])
})

test('music console refuses replaced FIFO handles and changed live process identity', async () => {
  const first = await fixture()
  first.handle.stat = async () => ({ ...fifo, ino: 6 })
  await assert.rejects(first.result.sendCommand('gamemode spectator Alice'), /FIFO|identity/i)
  assert.deepEqual(first.writes, [])
  let inspections = 0
  const second = await fixture({ readValidatedProfile: async () => (++inspections > 1 ? { ...profile, pid: 999 } : profile) })
  await assert.rejects(second.result.sendCommand('gamemode spectator Alice'), /identity/i)
  assert.deepEqual(second.writes, [])
})

test('music console serializes complete writes and rejects partial writes', async () => {
  const { result, handle, writes } = await fixture()
  handle.write = async bytes => { writes.push(bytes.toString()); return { bytesWritten: 1 } }
  await assert.rejects(result.sendCommand('gamemode spectator Alice'), /complete|partial/i)
  assert.equal(writes.length, 1)
})

test('music console limits return teleports to exact players, finite coordinates and three vanilla dimensions', async () => {
  const { result, writes } = await fixture()
  for (const dimension of ['overworld', 'the_nether', 'the_end']) {
    await result.sendCommand(`execute in minecraft:${dimension} run tp Alice 12.5 64 -5.25 -90 30`)
  }
  assert.equal(writes.length, 3)
  for (const command of [
    'execute in minecraft:overworld run tp @a 1 2 3 4 5',
    'execute in minecraft:custom run tp Alice 1 2 3 4 5',
    'execute in minecraft:overworld run tp Alice NaN 2 3 4 5',
    'execute in minecraft:overworld run tp Alice 1 400 3 4 5',
    'execute as Alice at @s run summon minecraft:marker ~ ~ ~ {Tags:["unrelated"]}',
    'execute in minecraft:overworld run kill @e[type=minecraft:marker]'
  ]) await assert.rejects(result.sendCommand(command), /allowlist/i)
  assert.equal(writes.length, 3)
})

test('music console captures one players position, dimension and rotation in a framed query', async () => {
  const { result, writes } = await fixture()
  assert.equal(typeof result.capturePosition, 'function', 'Return-position snapshots must be implemented')
  assert.deepEqual(await result.capturePosition('Alice'), { x: 12.5, y: 64, z: -5.25, yaw: -90, pitch: 30, dimension: 'the_nether' })
  assert.equal(writes.length, 1)
  const commands = writes[0].trim().split('\n')
  assert.equal(commands.length, 5)
  assert.deepEqual(commands.slice(1, 4), ['data get entity Alice Pos', 'data get entity Alice Dimension', 'data get entity Alice Rotation'])
  assert.match(commands[0], /^data get storage music_follow:marker_[0-9a-f]{32}$/)
  assert.match(commands[4], /^data get storage music_follow:marker_[0-9a-f]{32}$/)
  for (const username of ['@a', 'Alice\nstop', '__proto__\n']) await assert.rejects(result.capturePosition(username), /username/i)
  assert.equal(writes.length, 1)
})

test('position snapshots reject malformed, duplicate, non-finite and out-of-bounds values', () => {
  const valid = ['[12.5d, 64.0d, -5.25d]', '"minecraft:overworld"', '[-90.0f, 30.0f]']
  assert.deepEqual(parsePositionResponses(['[1e-7d, 6.4E1d, -5.25d]', valid[1], '[450f, -90f]']), { x: 1e-7, y: 64, z: -5.25, yaw: 90, pitch: -90, dimension: 'overworld' })
  for (const values of [
    valid.slice(0, 2), [...valid, valid[0]],
    ['[0d, 64d, 0d, 1d]', ...valid.slice(1)],
    ['[NaNd, 64d, 0d]', ...valid.slice(1)],
    ['[1e999d, 64d, 0d]', ...valid.slice(1)],
    ['[30000001d, 64d, 0d]', ...valid.slice(1)],
    ['[0d, 321d, 0d]', ...valid.slice(1)],
    [valid[0], '"minecraft:custom"', valid[2]],
    [valid[0], valid[1], '[0f, 91f]'],
    [valid[0], valid[1], '[1e999f, 0f]']
  ]) assert.throws(() => parsePositionResponses(values), /response|bounds/i)
})

test('position capture rejects duplicate framed player responses', async () => {
  const { result, handle } = await fixture()
  const write = handle.write
  handle.write = async bytes => { await write(Buffer.from(bytes.toString().replace('data get entity Alice Pos\n', 'data get entity Alice Pos\ndata get entity Alice Pos\n'))); return { bytesWritten: bytes.length } }
  await assert.rejects(result.capturePosition('Alice'), /ambiguous/i)
})

test('position capture times out on a missing frame end and keeps its command queue usable', async () => {
  const { result, handle, writes } = await fixture({ timeoutMs: 30 })
  const write = handle.write
  handle.write = async bytes => { await write(Buffer.from(bytes.toString().replace(/data get storage music_follow:marker_[0-9a-f]{32}\n$/, ''))); return { bytesWritten: bytes.length } }
  await assert.rejects(result.capturePosition('Alice'), /timed out/i)
  handle.write = write
  await result.sendCommand('gamemode creative Alice')
  assert.equal(writes.length, 2)
})

test('position capture refuses a replaced console log before writing queries', async () => {
  const { result, fs, writes } = await fixture()
  const lstat = fs.lstat
  fs.lstat = async filename => filename === profile.log ? { ...await lstat(filename), ino: 9 } : lstat(filename)
  await assert.rejects(result.capturePosition('Alice'), /log identity/i)
  assert.equal(writes.length, 0)
})
