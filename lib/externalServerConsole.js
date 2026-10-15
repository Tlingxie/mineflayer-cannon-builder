const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { setTimeout: delay } = require('node:timers/promises')
const { performance } = require('node:perf_hooks')

const exec = promisify(execFile)
const queues = new Map()
const PROFILE_FIELDS = ['schemaVersion', 'kind', 'host', 'port', 'version', 'pid', 'processStart', 'directory', 'pipe', 'log']
const INTEGER = '-?(?:0|[1-9][0-9]{0,7})'
const NUMBER = '-?(?:0|[1-9][0-9]{0,7})(?:\\.[0-9]+)?'
const BLOCK = `(${INTEGER}) (${INTEGER}) (${INTEGER})`
const PREDICATE = `if block ${BLOCK} minecraft:[a-z0-9_]+(?:\\[[a-z0-9_]+=[a-z0-9_]+(?:,[a-z0-9_]+=[a-z0-9_]+)*\\])?`
const ENTITY = new RegExp(`^data get entity @e\\[type=minecraft:(minecart|chest_minecart|hopper_minecart|armor_stand|item_frame|glow_item_frame|painting),x=${NUMBER},y=${NUMBER},z=${NUMBER},distance=\\.\\.0\\.(?:8|04),sort=nearest,limit=1\\]$`)

function check (signal) {
  if (signal?.aborted) throw Object.assign(new Error('External console snapshot cancelled'), { name: 'AbortError' })
}

function unavailable (message) {
  return Object.assign(new Error(message), { code: 'SNAPSHOT_UNAVAILABLE' })
}

async function readValidatedProfile (profilePath, options, { signal } = {}) {
  check(signal)
  if (typeof profilePath !== 'string' || !path.isAbsolute(profilePath)) throw unavailable('External console profile requires an absolute path')
  const stat = await fs.lstat(profilePath)
  if (!stat.isFile() || stat.size > 65536) throw unavailable('Invalid external console profile file')
  const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'))
  if (!profile || profile.schemaVersion !== 1 || profile.kind !== 'external-console' || Object.keys(profile).some(key => !PROFILE_FIELDS.includes(key))) throw unavailable('Unsupported external console profile schema')
  if (options?.host !== '127.0.0.1' || profile.host !== options.host || profile.port !== options.port || profile.version !== options.version) throw unavailable('External console profile does not match the numeric loopback endpoint')
  if (!Number.isSafeInteger(profile.pid) || profile.pid <= 0 || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535 ||
      typeof profile.version !== 'string' || !/^1\.[0-9]+(?:\.[0-9]+)?$/.test(profile.version) || typeof profile.processStart !== 'string' || !profile.processStart.trim()) throw unavailable('Invalid external console process identity')
  for (const field of ['directory', 'pipe', 'log']) {
    const filename = profile[field]
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename !== path.resolve(filename) || await fs.realpath(filename) !== filename) throw unavailable(`External console ${field} must be a canonical absolute path`)
  }
  const [directory, pipe, log] = await Promise.all([fs.lstat(profile.directory), fs.lstat(profile.pipe), fs.lstat(profile.log)])
  if (!directory.isDirectory() || !pipe.isFIFO() || !log.isFile()) throw unavailable('External console requires a directory, FIFO stdin and regular log file')
  const settings = { timeout: 3000, maxBuffer: 131072, encoding: 'utf8', signal }
  let results
  try {
    results = await Promise.all([
      exec('ps', ['-p', String(profile.pid), '-o', 'lstart='], settings),
      exec('lsof', ['-nP', '-a', '-p', String(profile.pid), '-d', 'cwd,0,1,2', '-Ffn'], settings),
      exec('lsof', ['-nP', '-a', '-p', String(profile.pid), `-iTCP:${profile.port}`, '-sTCP:LISTEN', '-Fn'], settings)
    ])
  } catch (error) {
    check(signal)
    throw unavailable(`External console process identity inspection failed: ${error.code || 'not running'}`)
  }
  check(signal)
  if (results[0].stdout.trim() !== profile.processStart) throw unavailable('External console process start identity changed')
  const descriptors = new Map()
  let descriptor
  for (const line of results[1].stdout.split('\n')) {
    if (line.startsWith('f')) descriptor = line.slice(1)
    if (line.startsWith('n')) descriptors.set(descriptor, line.slice(1))
  }
  if (descriptors.get('cwd') !== profile.directory || descriptors.get('0') !== profile.pipe) throw unavailable('External console process directory or FIFO stdin identity differs')
  if (![descriptors.get('1'), descriptors.get('2')].includes(profile.log)) throw unavailable('External console log identity is not the process stdout or stderr')
  const listeners = results[2].stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1))
  if (!listeners.some(name => [`127.0.0.1:${profile.port}`, `*:${profile.port}`, `[::1]:${profile.port}`, `[::]:${profile.port}`].includes(name))) throw unavailable('External console process does not own the requested listening port')
  return Object.freeze(profile)
}

function responseMatcher (command) {
  if (typeof command !== 'string' || command.length > 16384 || /[\r\n\0]/.test(command)) throw new Error('External console only permits bounded read-only snapshot commands')
  if (command === 'tick query') return { tick: true, matches: line => /^(?:The game is (?:frozen|running)|Target tick rate:|.*Percentiles:)/.test(line) }
  if (command === 'time query gametime' || new RegExp(`^execute ${PREDICATE}(?: ${PREDICATE}){0,63} run time query gametime$`).test(command)) return { matches: line => /^The time is [0-9]+$/.test(line) || /^(?:Test failed|Conditional check failed)/.test(line) }
  const block = new RegExp(`^data get block ${BLOCK}$`).exec(command)
  if (block) {
    const prefix = `${block[1]}, ${block[2]}, ${block[3]} has the following block data: `
    return { matches: line => line.startsWith(prefix) || /^(?:The target block is not a block entity|That position is not loaded)$/.test(line) }
  }
  const entity = ENTITY.exec(command)
  const tnt = command === 'data get entity @e[type=minecraft:tnt,limit=1]'
  if (entity || tnt) {
    const title = tnt ? 'TNT' : { minecart: 'Minecart', chest_minecart: 'Minecart with Chest', hopper_minecart: 'Minecart with Hopper', armor_stand: 'Armor Stand', item_frame: 'Item Frame', glow_item_frame: 'Glow Item Frame', painting: 'Painting' }[entity[1]]
    return { matches: line => line.startsWith(`${title} has the following entity data: `) || line === 'No entity was found' }
  }
  throw new Error('External console command is outside the read-only snapshot allowlist')
}

function sameFile (a, b) { return a.dev === b.dev && a.ino === b.ino }

async function createExternalConsole (options, { profilePath, signal, timeoutMs = 5000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('Invalid external console query timeout')
  const initial = await readValidatedProfile(profilePath, options, { signal })
  const [initialPipe, initialLog] = await Promise.all([fs.lstat(initial.pipe), fs.lstat(initial.log)])
  let failure

  async function readState (operationSignal = signal) {
    check(signal)
    check(operationSignal)
    if (failure) throw failure
    const state = await readValidatedProfile(profilePath, options, { signal: operationSignal })
    if (PROFILE_FIELDS.some(field => state[field] !== initial[field])) throw new Error('External console profile identity changed after snapshot initialization')
    const [pipe, log] = await Promise.all([fs.lstat(state.pipe), fs.lstat(state.log)])
    if (!sameFile(pipe, initialPipe) || !sameFile(log, initialLog)) throw new Error('External console FIFO or log identity changed after snapshot initialization')
    return state
  }

  async function runQuery (command, operationSignal) {
    const matcher = responseMatcher(command)
    const state = await readState(operationSignal)
    const start = randomBytes(16).toString('hex')
    const end = randomBytes(16).toString('hex')
    const markerCommand = id => `data get storage cannon_snapshot:marker_${id}`
    const markerResponse = id => `Storage cannon_snapshot:marker_${id} has the following contents: {}`
    const started = performance.now()
    const log = await fs.open(state.log, constants.O_RDONLY | constants.O_NOFOLLOW)
    let pipe
    try {
      const stat = await log.stat()
      if (!sameFile(stat, initialLog)) throw new Error('External console log identity changed before query')
      let offset = stat.size
      check(operationSignal)
      pipe = await fs.open(state.pipe, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      if (!sameFile(await pipe.stat(), initialPipe)) throw new Error('External console FIFO identity changed before query')
      const payload = Buffer.from(`${markerCommand(start)}\n${command}\n${markerCommand(end)}\n`)
      const written = await pipe.write(payload)
      if (written.bytesWritten !== payload.length) throw new Error('External console query was only partially written')
      await pipe.close()
      pipe = null
      let pending = ''
      let framed = false
      let total = 0
      const responses = []
      while (performance.now() - started < timeoutMs) {
        check(signal)
        check(operationSignal)
        const current = await fs.lstat(state.log)
        if (!sameFile(current, initialLog) || current.size < offset) throw new Error('External console log rotated or truncated during query')
        const count = current.size - offset
        if (count) {
          total += count
          if (total > 2097152) throw new Error('External console response exceeds snapshot size limit')
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
            if (line === markerResponse(start)) {
              if (framed) throw new Error('External console start marker repeated')
              framed = true
              continue
            }
            if (!framed) continue
            if (line === markerResponse(end)) {
              await readState(operationSignal)
              if (!responses.length || (!matcher.tick && responses.length !== 1)) throw new Error('External console response was missing or ambiguous; a unique response is required')
              if (matcher.tick && (responses.filter(line => line.startsWith('The game is ')).length !== 1 || responses.filter(line => line.startsWith('Target tick rate:')).length !== 1)) throw new Error('External console tick response was missing or ambiguous')
              return responses.join('\n')
            }
            if (matcher.matches(line)) responses.push(line)
          }
        }
        await delay(10, undefined, { signal: operationSignal })
      }
      throw new Error('External console snapshot query timed out waiting for its markers')
    } finally {
      if (pipe) await pipe.close()
      await log.close()
    }
  }

  async function query (state, command, { signal: operationSignal } = {}) {
    responseMatcher(command)
    check(signal)
    check(operationSignal)
    const combined = signal && operationSignal ? AbortSignal.any([signal, operationSignal]) : signal || operationSignal
    const previous = queues.get(initial.pipe) || Promise.resolve()
    const result = previous.catch(() => {}).then(() => runQuery(command, combined)).catch(error => {
      failure = error
      throw error
    })
    queues.set(initial.pipe, result)
    try { return await result } finally { if (queues.get(initial.pipe) === result) queues.delete(initial.pipe) }
  }

  return { readState, query, queryAttestsIdentity: true, validate: () => {}, identityFields: PROFILE_FIELDS, backend: 'external-console', label: 'External console server' }
}

module.exports = { readValidatedProfile, createExternalConsole }
