const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const { randomBytes } = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')
const { readValidatedProfile } = require('./externalServerConsole')

const fields = ['schemaVersion', 'kind', 'host', 'port', 'version', 'pid', 'processStart', 'directory', 'pipe', 'log']
const usernamePattern = /^[A-Za-z0-9_]{1,16}$/
const playerName = '[A-Za-z0-9_]{1,16}'
const dimension = 'minecraft:(?:overworld|the_nether|the_end)'
const decimal = '-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?'
const returnTeleport = new RegExp(`^execute in ${dimension} run tp ${playerName} (${decimal}) (${decimal}) (${decimal}) (${decimal}) (${decimal})$`)
const sameFifo = (expected, actual) => actual.isFIFO() && !actual.isSymbolicLink() && expected.dev === actual.dev && expected.ino === actual.ino
const sameFile = (expected, actual) => expected.dev === actual.dev && expected.ino === actual.ino

function validPosition (values) {
  const [x, y, z, yaw, pitch] = values
  return values.length === 5 && values.every(Number.isFinite) && Math.abs(x) <= 30000000 && y >= -64 && y <= 320 && Math.abs(z) <= 30000000 && Math.abs(yaw) <= 360 && Math.abs(pitch) <= 90
}

function parsePositionResponses (responses) {
  if (responses.length !== 3) throw new Error('Music position response was missing or ambiguous')
  const number = '[-+]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][-+]?[0-9]+)?[dDfF]?'
  const vector = new RegExp(`^\\[(${number}), ?(${number}), ?(${number})\\]$`).exec(responses[0])
  const dimension = /^"minecraft:(overworld|the_nether|the_end)"$/.exec(responses[1])
  const rotation = new RegExp(`^\\[(${number}), ?(${number})\\]$`).exec(responses[2])
  if (!vector || !dimension || !rotation) throw new Error('Music position response contains invalid coordinates, dimension or rotation')
  const [x, y, z] = vector.slice(1).map(value => Number(value.replace(/[dDfF]$/, '')))
  const [rawYaw, pitch] = rotation.slice(1).map(value => Number(value.replace(/[dDfF]$/, '')))
  const yaw = ((rawYaw + 180) % 360 + 360) % 360 - 180
  if (!Number.isFinite(rawYaw) || !validPosition([x, y, z, yaw, pitch])) throw new Error('Music position response is outside safe coordinate bounds')
  return { x, y, z, yaw, pitch, dimension: dimension[1] }
}

function validateCommand (command, username) {
  if (typeof command !== 'string' || command.length > 512 || /[\r\n\0]/.test(command)) throw new Error('Music console command is outside the targeted allowlist')
  const words = command.split(' ')
  const player = value => usernamePattern.test(value || '')
  if (words.length === 3 && words[0] === 'gamemode' && ['survival', 'creative', 'adventure', 'spectator'].includes(words[1]) && player(words[2])) return
  if (words.length === 3 && words[0] === 'spectate' && words[1] === username && player(words[2]) && words[2] !== username) return
  if (words.length === 5 && words[0] === 'execute' && words[1] === 'as' && player(words[2]) && words[3] === 'run' && words[4] === 'spectate') return
  const returning = returnTeleport.exec(command)
  if (returning && validPosition(returning.slice(1).map(Number))) return
  if (words.length === 7 && words[0] === 'tp' && words[1] === username && words.slice(2).every(value => /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value))) {
    const [x, y, z, yaw, pitch] = words.slice(2).map(Number)
    if (validPosition([x, y, z, yaw, pitch])) return
  }
  throw new Error('Music console command is outside the targeted allowlist')
}

async function createMusicFollowConsole (options, { profilePath, username, readValidatedProfile: validate = readValidatedProfile, fs: filesystem = fs, timeoutMs = 5000 } = {}) {
  if (!usernamePattern.test(username || '')) throw new Error('Invalid music follower username')
  const initial = await validate(profilePath, options)
  const expected = await filesystem.lstat(initial.pipe)
  const expectedLog = await filesystem.lstat(initial.log)
  if (!sameFifo(expected, expected)) throw new Error('Music console requires a FIFO, not a symbolic link')
  if (!expectedLog.isFile() || expectedLog.isSymbolicLink()) throw new Error('Music console requires a regular log file')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw new Error('Invalid music console timeout')
  let queue = Promise.resolve()
  async function inspect () {
    const current = await validate(profilePath, options)
    if (!fields.every(field => current[field] === initial[field])) throw new Error('Music console server identity changed')
    if (!sameFifo(expected, await filesystem.lstat(current.pipe))) throw new Error('Music console FIFO identity changed')
    if (!sameFile(expectedLog, await filesystem.lstat(current.log))) throw new Error('Music console log identity changed')
    return current
  }
  async function write (command) {
    await inspect()
    const handle = await filesystem.open(initial.pipe, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      if (!sameFifo(expected, await handle.stat())) throw new Error('Music console FIFO identity changed')
      await inspect()
      const payload = Buffer.from(command + '\n')
      if ((await handle.write(payload)).bytesWritten !== payload.length) throw new Error('Music console did not accept the complete command')
    } finally { await handle.close() }
  }
  function sendCommand (command) {
    try { validateCommand(command, username) } catch (error) { return Promise.reject(error) }
    const result = queue.then(() => write(command))
    queue = result.catch(() => {})
    return result
  }
  async function queryPosition (player) {
    await inspect()
    const log = await filesystem.open(initial.log, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await log.stat()
      if (!sameFile(expectedLog, stat)) throw new Error('Music console log identity changed before capture')
      let offset = stat.size
      const start = randomBytes(16).toString('hex')
      const end = randomBytes(16).toString('hex')
      await write(`data get storage music_follow:marker_${start}\ndata get entity ${player} Pos\ndata get entity ${player} Dimension\ndata get entity ${player} Rotation\ndata get storage music_follow:marker_${end}`)
      const marker = id => `Storage music_follow:marker_${id} has the following contents: {}`
      const prefix = `${player} has the following entity data: `
      const responses = []
      let pending = ''
      let framed = false
      let bytes = 0
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const current = await filesystem.lstat(initial.log)
        if (!sameFile(expectedLog, current) || current.size < offset) throw new Error('Music console log changed or truncated during capture')
        const count = current.size - offset
        if (count) {
          bytes += count
          if (bytes > 2097152) throw new Error('Music console capture exceeds response limit')
          const buffer = Buffer.alloc(count)
          const result = await log.read(buffer, 0, count, offset)
          offset += result.bytesRead
          pending += buffer.subarray(0, result.bytesRead).toString('utf8')
          const lines = pending.split('\n')
          pending = lines.pop()
          for (const raw of lines) {
            const match = /^\[[0-9:]+\] \[Server thread\/INFO\]: (.*)\r?$/.exec(raw)
            if (!match) continue
            const line = match[1]
            if (line === marker(start)) { if (framed) throw new Error('Music console capture start marker repeated'); framed = true; continue }
            if (!framed) continue
            if (line === marker(end)) { await inspect(); return parsePositionResponses(responses) }
            if (line.startsWith(prefix)) responses.push(line.slice(prefix.length))
          }
        }
        await delay(10)
      }
      throw new Error('Music console position capture timed out')
    } finally { await log.close() }
  }
  function capturePosition (player) {
    if (!usernamePattern.test(player || '')) return Promise.reject(new Error('Invalid music viewer username'))
    const result = queue.then(() => queryPosition(player))
    queue = result.catch(() => {})
    return result
  }
  return { sendCommand, capturePosition }
}

module.exports = { createMusicFollowConsole, validateCommand, parsePositionResponses }
