const fs = require('node:fs/promises')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { setTimeout: delay } = require('node:timers/promises')
const mojangson = require('mojangson')
const server = require('../scripts/server-local')
const { normalizeItems } = require('./physicalInventory')

const DIRECTORY = path.resolve(__dirname, '../.runtime/server')
const STATE_FILE = path.join(DIRECTORY, 'run.json')
const CLONE_DIRECTORY = path.resolve(__dirname, '../.runtime/clones')
const CLONE_STATE_FILE = path.join(CLONE_DIRECTORY, 'run.json')
const CAPACITY = { chest: 27, trapped_chest: 27, barrel: 27, hopper: 5, dispenser: 9, dropper: 9, shulker_box: 27 }
const CART_CAPACITY = { minecart: 0, chest_minecart: 27, hopper_minecart: 5 }

function check (signal) {
  if (!signal?.aborted) return
  const error = new Error('Server snapshot cancelled')
  error.name = 'AbortError'
  throw error
}

function coordinates (position, integer = false) {
  const xyz = ['x', 'y', 'z'].map(axis => position?.[axis])
  if (!xyz.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 30000000 && (!integer || Number.isSafeInteger(value)))) {
    throw new Error('Invalid snapshot coordinates')
  }
  return xyz
}

function decodeNbt (type, value, depth = 0) {
  if (depth > 64) throw new Error('SNBT nesting exceeds snapshot limit')
  if (type === 'compound') {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid SNBT compound')
    return Object.fromEntries(Object.entries(value).map(([key, node]) => [key, decodeNbt(node?.type, node?.value, depth + 1)]))
  }
  if (type === 'list') {
    if (value && !Object.keys(value).length) return []
    if (!Array.isArray(value?.value)) throw new Error('Invalid SNBT list')
    return value.value.map(item => decodeNbt(value.type, item, depth + 1))
  }
  if (['byteArray', 'intArray', 'longArray'].includes(type)) {
    if (!Array.isArray(value?.value)) throw new Error('Invalid SNBT typed array')
    const itemType = { byteArray: 'byte', intArray: 'int', longArray: 'long' }[type]
    return value.value.map(item => decodeNbt(itemType, item, depth + 1))
  }
  if (type === 'string' && typeof value === 'string') return value
  if (type === 'boolean' && typeof value === 'boolean') return value
  if (['byte', 'short', 'int', 'long'].includes(type)) {
    if (!Number.isSafeInteger(value)) throw new Error('SNBT integer precision would be lost')
    const range = { byte: 128, short: 32768, int: 2147483648 }[type]
    if (range && (value < -range || value >= range)) throw new Error('Invalid SNBT integer range')
    return value
  }
  if (['float', 'double'].includes(type) && typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error(`Unsupported or malformed SNBT type: ${type}`)
}

function parseDataResponse (response, kind, position) {
  if (typeof response !== 'string' || response.length > 1048576) throw new Error('Invalid data response size')
  let content
  if (kind === 'block') {
    const prefix = /^(-?\d+), (-?\d+), (-?\d+) has the following block data: /.exec(response)
    if (!prefix) throw new Error('Invalid block data response')
    const expected = coordinates(position, true)
    if (!expected.every((value, i) => value === Number(prefix[i + 1]))) throw new Error('Block data response coordinates differ from request')
    content = response.slice(prefix[0].length).trim()
  } else if (kind === 'entity') {
    const prefix = /^[\s\S]*? has the following entity data: /.exec(response)
    if (!prefix) throw new Error('Invalid entity data response')
    content = response.slice(prefix[0].length).trim()
  } else throw new Error('Unknown snapshot data response kind')
  if (!content.startsWith('{') || !content.endsWith('}')) throw new Error('Incomplete SNBT compound in data response')
  let node
  try { node = mojangson.parse(content) } catch { throw new Error('Invalid SNBT compound in data response') }
  if (node?.type !== 'compound') throw new Error('Data response did not contain a complete SNBT compound')
  return decodeNbt(node.type, node.value)
}

function validateManaged (state, options) {
  // The launcher and its RCON client bind this numeric loopback address only.
  const unavailable = message => Object.assign(new Error(message), { code: 'SNAPSHOT_UNAVAILABLE' })
  if (options.host !== '127.0.0.1' || state.host !== '127.0.0.1') throw unavailable('Snapshot requires the managed numeric loopback endpoint')
  if (state.host !== options.host || state.port !== options.port || state.version !== options.version || state.directory !== DIRECTORY) {
    throw unavailable('Snapshot options do not match this managed server')
  }
  if (![state.port, state.rconPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535) ||
      !Number.isSafeInteger(state.pid) || state.pid <= 0 || typeof state.password !== 'string' || !state.password.length) {
    throw new Error('Invalid managed server state')
  }
}

function validateClone (state, options) {
  const unavailable = message => Object.assign(new Error(message), { code: 'SNAPSHOT_UNAVAILABLE' })
  if (options.host !== '127.0.0.1' || options.port !== 25567 || options.version !== '1.21.4' ||
      !state || state.host !== options.host || state.port !== options.port || state.version !== options.version || state.rconPort !== 25577) throw unavailable('Snapshot options do not match the fixed isolated clone endpoint')
  if (state.kind !== 'initialization-clone' || typeof state.directory !== 'string' || path.resolve(state.directory) !== state.directory ||
      path.dirname(state.directory) !== CLONE_DIRECTORY || !/^run-[a-zA-Z0-9-]+$/.test(path.basename(state.directory)) ||
      !Number.isSafeInteger(state.pid) || state.pid <= 0 || typeof state.startedAt !== 'string' || !Number.isFinite(Date.parse(state.startedAt)) ||
      typeof state.password !== 'string' || !state.password.length) throw new Error('Invalid isolated clone snapshot identity')
}

function withEvidence (error, evidence) {
  error.evidence = evidence
  return error
}

function canonicalItems (entries) {
  return entries.map(({ slot, item }) => ({ slot, name: item.name, count: item.count, metadata: item.metadata, components: item.components }))
}

function compareItems (expected, actual, evidence, label) {
  const wanted = new Map(canonicalItems(expected).map(item => [item.slot, item]))
  const observed = new Map(canonicalItems(actual).map(item => [item.slot, item]))
  for (const slot of new Set([...wanted.keys(), ...observed.keys()])) {
    if (JSON.stringify(wanted.get(slot)) !== JSON.stringify(observed.get(slot))) {
      throw withEvidence(new Error(`${label} verification failed at slot ${slot}`), evidence)
    }
  }
}

function uuidString (words) {
  if (!Array.isArray(words) || words.length !== 4 || !words.every(value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)) throw new Error('Invalid entity UUID int array')
  const bytes = Buffer.alloc(16)
  words.forEach((value, index) => bytes.writeInt32BE(value, index * 4))
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function comparatorOutputIsInteger (response) {
  // mojangson coerces quoted numeric strings; check the root SNBT member too.
  const compound = response.slice(response.indexOf('{'))
  const members = []
  let depth = 0
  let start = 1
  let quote = null
  let escaped = false
  for (let index = 0; index < compound.length; index++) {
    const char = compound[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if ((char === ',' || char === '}') && depth === 1) {
      members.push(compound.slice(start, index))
      start = index + 1
    }
    if (char === '{' || char === '[') depth++
    if (char === '}' || char === ']') depth--
  }
  const output = members.filter(member => /^\s*(?:OutputSignal|"OutputSignal"|'OutputSignal')\s*:/.test(member))
  return output.length === 1 && /^\s*(?:OutputSignal|"OutputSignal"|'OutputSignal')\s*:\s*(?:[0-9]|1[0-5])\s*$/.test(output[0])
}

async function createSnapshot (options, { signal } = {}, target) {
  check(signal)
  const expectedOptions = { host: options.host, port: options.port, version: options.version }
  const initial = JSON.parse(await fs.readFile(target.stateFile, 'utf8'))
  target.validate(initial, expectedOptions)
  check(signal)

  async function query (command, kind, position, operationSignal, allowMissing = false) {
    check(signal)
    check(operationSignal)
    const state = JSON.parse(await fs.readFile(target.stateFile, 'utf8'))
    target.validate(state, expectedOptions)
    if (['pid', 'rconPort', 'password', 'startedAt', 'directory'].some(field => state[field] !== initial[field])) throw new Error(`${target.label} identity changed after snapshot initialization`)
    try { process.kill(state.pid, 0) } catch { throw new Error(`${target.label} process is not running`) }
    check(signal)
    check(operationSignal)
    const evidence = { backend: target.backend, command, readAt: new Date().toISOString() }
    try {
      const response = await server.rconCommand({ port: state.rconPort, password: state.password }, command)
      check(signal)
      check(operationSignal)
      evidence.response = response.split(state.password).join('[redacted]')
      if (kind === 'raw') return { data: evidence.response, evidence }
      if (allowMissing && evidence.response.trim() === 'No entity was found') return { data: null, evidence }
      return { data: parseDataResponse(evidence.response, kind, position), evidence }
    } catch (error) {
      error.message = error.message.split(state.password).join('[redacted]')
      throw withEvidence(error, [evidence])
    }
  }

  async function readTickState ({ signal: operationSignal } = {}) {
    const evidence = []
    const read = async command => {
      const result = await query(command, 'raw', null, operationSignal)
      evidence.push(result.evidence)
      return result.data
    }
    const verifyFrozen = response => {
      if (!response.includes('The game is frozen')) throw new Error('Construction requires frozen game ticks')
      const match = /Target tick rate: (\d+(?:\.\d+)?) per second\./.exec(response)
      if (!match || Number(match[1]) !== 20) throw new Error('Construction tick inspection requires target tick rate 20')
    }
    const gametime = response => {
      const match = /^The time is (\d+)\s*$/.exec(response)
      const result = Number(match?.[1])
      if (!match || !Number.isInteger(result) || result < 0 || result >= 2147483647) throw new Error('Invalid gametime response')
      return result
    }
    try {
      verifyFrozen(await read('tick query'))
      const before = gametime(await read('time query gametime'))
      const started = performance.now()
      const waitSignal = signal && operationSignal ? AbortSignal.any([signal, operationSignal]) : signal || operationSignal
      while (performance.now() - started < 150) await delay(Math.max(1, Math.ceil(150 - (performance.now() - started))), undefined, { signal: waitSignal })
      const after = gametime(await read('time query gametime'))
      const sampleMs = performance.now() - started
      verifyFrozen(await read('tick query'))
      if (before !== after) throw new Error('Construction is not quiescent: gametime advanced during the frozen-state sample')
      // This observes an idle interval; it cannot predict later external step commands or an empty-server pause.
      return { frozen: true, quiescent: true, tickRate: 20, gameTime: after, sampleMs, evidence }
    } catch (error) {
      if (error.evidence) evidence.push(...error.evidence)
      throw withEvidence(error, evidence)
    }
  }

  async function verifyBlockStates (blocks, settings = {}) {
    if (!Array.isArray(blocks) || !blocks.length || blocks.length > 64) throw new Error('Fluid fence requires 1 to 64 block states')
    const Block = require('prismarine-block')(options.version)
    const registry = require('minecraft-data')(options.version)
    const seen = new Set()
    const predicates = blocks.map(({ pos, stateId }) => {
      const xyz = coordinates(pos, true)
      if (seen.has(xyz.join(','))) throw new Error('Duplicate fluid fence coordinate')
      seen.add(xyz.join(','))
      if (!Number.isSafeInteger(stateId) || stateId < 0 || !registry.blocksByStateId[stateId]) throw new Error('Invalid fluid fence state')
      const block = Block.fromStateId(stateId, 0)
      const properties = Object.entries(block.getProperties()).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`)
      return `if block ${xyz.join(' ')} minecraft:${block.name}${properties.length ? `[${properties.join(',')}]` : ''}`
    })
    const before = await readTickState(settings)
    const result = await query(`execute ${predicates.join(' ')} run time query gametime`, 'raw', null, settings.signal)
    if (result.data.trim() !== `The time is ${before.gameTime}`) throw withEvidence(new Error('Fluid ray world state differs or gametime changed'), [result.evidence])
    const after = await readTickState(settings)
    if (before.gameTime !== after.gameTime) throw new Error('Fluid fence gametime changed')
    return { verified: true, checked: blocks.length, gameTime: before.gameTime, blocks, tickState: { before, after }, evidence: [result.evidence] }
  }

  async function readContainer (task, { signal: operationSignal } = {}) {
    const xyz = coordinates(task.pos, true)
    const name = task.name.endsWith('_shulker_box') ? 'shulker_box' : task.name
    const size = Object.hasOwn(CAPACITY, name) ? CAPACITY[name] : null
    if (!size) throw new Error(`Unsupported snapshot container: ${task.name}`)
    const { data, evidence } = await query(`data get block ${xyz.join(' ')}`, 'block', task.pos, operationSignal)
    try {
      if (data.id !== `minecraft:${name}` || !xyz.every((value, i) => value === data[['x', 'y', 'z'][i]])) throw new Error('Container block entity identity differs from request')
      const entries = normalizeItems(data.Items, expectedOptions.version)
      if (entries.some(entry => entry.slot >= size)) throw new Error('Observed item slot exceeds container capacity')
      return { name: task.name, pos: { ...task.pos }, blockEntity: data, entries, evidence }
    } catch (error) { throw withEvidence(error, [evidence]) }
  }

  async function verifyContainer (task, settings = {}) {
    check(signal)
    check(settings.signal)
    const expected = normalizeItems(task.blockEntity?.Items, expectedOptions.version)
    const observed = await readContainer(task, settings)
    compareItems(expected, observed.entries, [observed.evidence], 'Container')
    return { verified: true, backend: target.backend, verifiedProperties: ['Items'], slots: expected.length, items: expected.reduce((sum, entry) => sum + entry.item.count, 0), evidence: [observed.evidence] }
  }

  function comparatorPosition (task) {
    if (task?.name !== 'comparator') throw new Error('Snapshot comparator target must name a comparator')
    return coordinates(task.pos, true)
  }

  async function readComparatorData (task, settings) {
    const xyz = comparatorPosition(task)
    const { data, evidence } = await query(`data get block ${xyz.join(' ')}`, 'block', task.pos, settings.signal)
    try {
      if (data.id !== 'minecraft:comparator' || !xyz.every((value, index) => value === data[['x', 'y', 'z'][index]])) throw new Error('Comparator block entity identity differs from request')
      if (!Number.isInteger(data.OutputSignal) || data.OutputSignal < 0 || data.OutputSignal > 15) throw new Error('Observed comparator OutputSignal must be an integer from 0 through 15')
      if (!comparatorOutputIsInteger(evidence.response)) throw new Error('Observed comparator OutputSignal must be one unquoted SNBT integer from 0 through 15')
      return { id: task.id || xyz.join(','), name: task.name, pos: { ...task.pos }, blockEntity: data, outputSignal: data.OutputSignal, evidence }
    } catch (error) { throw withEvidence(error, [evidence]) }
  }

  async function frozenComparatorBatch (tasks, settings) {
    check(signal)
    check(settings.signal)
    tasks.forEach(comparatorPosition)
    const evidence = []
    const observed = []
    try {
      const before = await readTickState(settings)
      evidence.push(...before.evidence)
      for (const task of tasks) {
        const result = await readComparatorData(task, settings)
        observed.push(result)
        evidence.push(result.evidence)
      }
      const after = await readTickState(settings)
      evidence.push(...after.evidence)
      if (before.gameTime !== after.gameTime) throw new Error('Gametime changed during comparator verification')
      return { observed, tickState: { before, after }, evidence }
    } catch (error) {
      if (error.evidence && error.evidence !== evidence) evidence.push(...error.evidence)
      throw withEvidence(error, evidence)
    }
  }

  async function readComparator (task, settings = {}) {
    const result = await frozenComparatorBatch([task], settings)
    return { ...result.observed[0], backend: target.backend, tickState: result.tickState, evidence: result.evidence }
  }

  async function verifyComparators (plan, settings = {}) {
    check(signal)
    check(settings.signal)
    if (!plan || !Array.isArray(plan.tasks)) throw new Error('Comparator verification requires the complete source plan')
    const tasks = plan.tasks.filter(task => task?.name === 'comparator')
    const unique = new Set()
    for (const task of tasks) {
      const key = comparatorPosition(task).join(',')
      if (unique.has(key)) throw new Error(`Duplicate source comparator coordinate: ${key}`)
      unique.add(key)
      if (task.blockEntity?.id !== 'minecraft:comparator') throw new Error(`Source comparator identity is invalid: ${key}`)
      const output = task.blockEntity.OutputSignal
      if (!Number.isInteger(output) || output < 0 || output > 15) throw new Error(`Source comparator OutputSignal must be an integer from 0 through 15: ${key}`)
    }
    const { observed, evidence, tickState } = await frozenComparatorBatch(tasks, settings)
    const matches = observed.map((actual, index) => ({ id: actual.id, pos: actual.pos, blockEntityId: actual.blockEntity.id, expectedOutputSignal: tasks[index].blockEntity.OutputSignal, outputSignal: actual.outputSignal }))
    const mismatches = matches.filter(match => match.expectedOutputSignal !== match.outputSignal)
    if (mismatches.length) {
      throw withEvidence(Object.assign(new Error(`Comparator OutputSignal differs from the source at ${mismatches.length} target(s)`), { mismatches, checked: matches.length, matches, tickState }), evidence)
    }
    return { verified: true, backend: target.backend, comparators: matches.length, verifiedProperties: ['id', 'position', 'OutputSignal'], matches, tickState, evidence }
  }

  async function readMinecart (expected, { signal: operationSignal } = {}) {
    const xyz = coordinates(expected.pos)
    if (!Object.hasOwn(CART_CAPACITY, expected.name)) throw new Error(`Unsupported snapshot entity: ${expected.name}`)
    const selector = `@e[type=minecraft:${expected.name},x=${xyz[0]},y=${xyz[1]},z=${xyz[2]},distance=..0.8,sort=nearest,limit=1]`
    const { data, evidence } = await query(`data get entity ${selector}`, 'entity', null, operationSignal)
    try {
      if (data.id !== undefined && data.id !== `minecraft:${expected.name}`) throw new Error('Entity type differs from selector')
      if (!Array.isArray(data.Pos) || data.Pos.length !== 3 || !data.Pos.every(value => typeof value === 'number' && Number.isFinite(value))) throw new Error('Invalid minecart Pos')
      const distance = Math.hypot(...xyz.map((value, i) => value - data.Pos[i]))
      if (distance > 0.800000001) throw new Error('Minecart position is outside the requested tolerance')
      const entries = normalizeItems(expected.name === 'minecart' && data.Items === undefined ? [] : data.Items, expectedOptions.version)
      if (entries.some(entry => entry.slot >= CART_CAPACITY[expected.name])) throw new Error('Observed item slot exceeds minecart capacity')
      if (data.Enabled !== undefined && ![0, 1, false, true].includes(data.Enabled)) throw new Error('Invalid minecart Enabled value')
      return { name: expected.name, typeSource: 'server-selector', pos: { x: data.Pos[0], y: data.Pos[1], z: data.Pos[2] }, distance, uuid: uuidString(data.UUID), enabled: data.Enabled === undefined ? undefined : Boolean(data.Enabled), data, entries, evidence }
    } catch (error) { throw withEvidence(error, [evidence]) }
  }

  async function verifyMinecarts (entities, settings = {}) {
    check(signal)
    check(settings.signal)
    const claimed = new Set()
    const matches = []
    const evidence = []
    for (const entity of entities) {
      const observed = await readMinecart(entity, settings)
      evidence.push(observed.evidence)
      if (claimed.has(observed.uuid)) throw withEvidence(new Error('The same UUID matched more than one minecart target'), evidence)
      claimed.add(observed.uuid)
      if (entity.expectedEnabled !== undefined && observed.enabled !== entity.expectedEnabled) throw withEvidence(new Error(`Minecart Enabled differs from ${entity.id}`), evidence)
      const wantedItems = normalizeItems(entity.source?.data?.Items || [], expectedOptions.version)
      compareItems(wantedItems, observed.entries, evidence, `Minecart ${entity.id}`)
      matches.push({ id: entity.id, name: observed.name, uuid: observed.uuid, pos: observed.pos, distance: observed.distance, enabled: observed.enabled })
    }
    return { verified: true, backend: target.backend, verifiedProperties: ['type', 'position', 'uniqueUUID', 'Items', 'Enabled'], entities: matches.length, matches, evidence }
  }

  async function readPrimedTnt ({ signal: operationSignal } = {}) {
    const { data, evidence } = await query('data get entity @e[type=minecraft:tnt,limit=1]', 'entity', null, operationSignal, true)
    if (!data) return { present: false, evidence: [evidence] }
    try {
      if (!Array.isArray(data.Pos) || data.Pos.length !== 3 || !data.Pos.every(Number.isFinite) || !Number.isSafeInteger(data.fuse)) throw new Error('Invalid primed TNT position or fuse')
      return { present: true, uuid: uuidString(data.UUID), pos: { x: data.Pos[0], y: data.Pos[1], z: data.Pos[2] }, fuse: data.fuse, data, evidence: [evidence] }
    } catch (error) { throw withEvidence(error, [evidence]) }
  }

  return Object.freeze({ backend: target.backend, ...expectedOptions, readContainer, verifyContainer, readComparator, verifyComparators, readMinecart, verifyMinecarts, readPrimedTnt, readTickState, verifyBlockStates })
}

async function createServerSnapshot (options, settings) {
  return createSnapshot(options, settings, { stateFile: STATE_FILE, validate: validateManaged, backend: 'managed-rcon', label: 'Managed server' })
}

async function createCloneSnapshot (options = {}, settings) {
  if (Object.keys(options).some(key => !['host', 'port', 'version'].includes(key))) throw Object.assign(new Error('Clone snapshot only accepts its fixed host, port and version'), { code: 'SNAPSHOT_UNAVAILABLE' })
  const endpoint = { host: '127.0.0.1', port: 25567, version: '1.21.4', ...options }
  return createSnapshot(endpoint, settings, { stateFile: CLONE_STATE_FILE, validate: validateClone, backend: 'clone-rcon', label: 'Isolated clone' })
}

module.exports = { createServerSnapshot, createCloneSnapshot, parseDataResponse }
