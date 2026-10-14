const fs = require('node:fs/promises')
const { isDeepStrictEqual } = require('node:util')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const Build = require('./Build')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const key = p => `${p.x},${p.y},${p.z}`

function resolveState (qualified, supplied = {}, version = '1.21.4') {
  const name = qualified.replace(/^minecraft:/, '')
  const data = require('minecraft-data')(version)
  const Block = require('prismarine-block')(version)
  const entry = data.blocksByName[name]
  if (!entry) throw new Error(`Unsupported block in ${version}: ${qualified}`)
  const defaults = Block.fromStateId(entry.defaultState, 0).getProperties()
  for (const property of Object.keys(supplied)) {
    if (!(property in defaults)) throw new Error(`Unknown property ${name}.${property}`)
  }
  const properties = { ...defaults, ...supplied }
  const block = Block.fromProperties(name, properties, 0)
  const observed = block.getProperties()
  if (block.name !== name || Object.entries(properties).some(([k, v]) => String(observed[k]) !== String(v))) {
    throw new Error(`Invalid block state: ${name} ${JSON.stringify(properties)}`)
  }
  return block
}

function itemNameForBlock (name) {
  if (name === 'bubble_column') return 'water_bucket'
  if (name === 'fire' || name === 'soul_fire') return 'flint_and_steel'
  if (name === 'redstone_wire') return 'redstone'
  if (name === 'tripwire') return 'string'
  if (['water', 'lava', 'powder_snow'].includes(name)) return name + '_bucket'
  if (name === 'lava_cauldron') return 'cauldron'
  if (name === 'dirt_path') return 'grass_block'
  return name.replace('_wall_banner', '_banner').replace('_wall_hanging_sign', '_hanging_sign')
    .replace('_wall_sign', '_sign').replace('wall_torch', 'torch').replace('_wall_fan', '_fan')
}

function dynamicProperties (name) {
  const ignored = new Set()
  if (name === 'fire') ignored.add('age')
  if (['repeater', 'comparator', 'observer', 'note_block', 'target', 'hopper', 'dispenser', 'dropper', 'tripwire', 'tripwire_hook'].includes(name) || name.endsWith('_rail')) {
    for (const property of ['powered', 'power', 'locked', 'enabled', 'triggered', 'attached']) ignored.add(property)
  }
  if (name === 'redstone_wire') for (const property of ['power', 'north', 'south', 'east', 'west']) ignored.add(property)
  if (name === 'piston' || name === 'sticky_piston') ignored.add('extended')
  if (name.includes('redstone_torch') || name === 'redstone_wall_torch' || name === 'redstone_lamp') ignored.add('lit')
  if (name === 'note_block') ignored.add('instrument')
  if (name === 'daylight_detector') ignored.add('power')
  if (name.endsWith('copper_bulb') || name.endsWith('_door') || name.endsWith('_trapdoor') || name.endsWith('_fence_gate')) ignored.add('powered')
  if (name.endsWith('_fence_gate')) ignored.add('in_wall')
  if (name === 'iron_door' || name === 'iron_trapdoor') ignored.add('open')
  if (name === 'scaffolding') { ignored.add('distance'); ignored.add('bottom') }
  if (name.endsWith('_leaves')) { ignored.add('distance'); ignored.add('persistent') }
  if (name.endsWith('_stairs')) ignored.add('shape')
  if (name.endsWith('_wall') || name.endsWith('_fence') || name.endsWith('_pane') || name === 'iron_bars') {
    for (const property of ['north', 'south', 'east', 'west', 'up']) ignored.add(property)
  }
  return ignored
}

function matchesTarget (wanted, actual, { exact = false } = {}) {
  if (!wanted || !actual || wanted.name !== actual.name) return false
  const ignored = exact ? new Set() : dynamicProperties(wanted.name)
  const properties = actual.getProperties()
  const wantedProperties = wanted.getProperties()
  if (wanted.name === 'redstone_wire') {
    const isDot = values => ['north', 'south', 'east', 'west'].every(direction => values[direction] === 'none')
    if (isDot(wantedProperties) !== isDot(properties)) return false
  }
  return Object.entries(wantedProperties).every(([k, v]) => ignored.has(k) || String(properties[k]) === String(v))
}

function matchesPhysicalTarget (wanted, actual, task) {
  if (matchesTarget(wanted, actual)) return true
  return Boolean(wanted?.name === 'water' && String(wanted.getProperties().level) === '0' && task?.name === 'water' &&
    task.generatedTarget?.name === 'bubble_column' && actual?.name === 'bubble_column' && actual.stateId === task.generatedTarget.state)
}

function finishPlan (cells, rawTiles, entities, version, origin, metadata = {}) {
  if (!cells.size) throw new Error('Schematic has no cells')
  if (![origin.x, origin.y, origin.z].every(Number.isSafeInteger)) throw new Error('Origin must contain integer coordinates')
  const sourceMin = { x: Infinity, y: Infinity, z: Infinity }
  const sourceMax = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const { pos } of cells.values()) {
    for (const axis of ['x', 'y', 'z']) {
      sourceMin[axis] = Math.min(sourceMin[axis], pos[axis])
      sourceMax[axis] = Math.max(sourceMax[axis], pos[axis])
    }
  }
  const shift = p => new Vec3(p.x - sourceMin.x + origin.x, p.y - sourceMin.y + origin.y, p.z - sourceMin.z + origin.z)
  const tasks = []
  const air = []
  for (const cell of cells.values()) {
    const pos = shift(cell.pos)
    if (AIR.has(cell.block.name)) air.push(pos)
    else tasks.push({ id: key(pos), type: 'place', pos, state: cell.block.stateId, name: cell.block.name })
  }
  tasks.sort((a, b) => a.pos.y - b.pos.y || a.pos.z - b.pos.z || a.pos.x - b.pos.x)
  const tileMap = new Map()
  for (const tile of rawTiles) {
    const pos = shift(tile.pos)
    const id = key(pos)
    const previous = tileMap.get(id)
    const content = data => Object.fromEntries(Object.entries(data).filter(([k]) => !['x', 'y', 'z', 'Pos'].includes(k)))
    if (previous && !isDeepStrictEqual(content(previous.data), content(tile.data))) throw new Error(`Conflicting block entities at ${id}`)
    tileMap.set(id, { pos, data: tile.data })
  }
  for (const task of tasks) if (tileMap.has(task.id)) task.blockEntity = tileMap.get(task.id).data
  return {
    ...metadata,
    version,
    origin,
    sourceMin,
    sourceMax,
    tasks,
    air,
    blockEntities: [...tileMap.values()],
    entities,
    min: new Vec3(origin.x, origin.y, origin.z),
    max: shift(sourceMax).offset(1, 1, 1),
    layers: [...new Set(tasks.map(t => t.pos.y))]
  }
}

function addCell (cells, pos, block) {
  const id = key(pos)
  const previous = cells.get(id)
  if (previous && !AIR.has(previous.block.name)) {
    if (!AIR.has(block.name) && previous.block.stateId !== block.stateId) throw new Error(`Conflicting regions at ${id}`)
    return
  }
  cells.set(id, { pos, block })
}

function decodeLitematic (source, version = '1.21.4', origin = { x: 0, y: 64, z: 0 }) {
  const cells = new Map()
  const tiles = []
  const entities = []
  for (const [regionName, region] of Object.entries(source.Regions || {})) {
    const size = Object.fromEntries(['x', 'y', 'z'].map(k => [k, Math.abs(region.Size[k])]))
    if (!Object.values(size).every(v => Number.isSafeInteger(v) && v > 0)) throw new Error(`Invalid region size: ${regionName}`)
    const min = Object.fromEntries(['x', 'y', 'z'].map(k => [k, region.Position[k] + Math.min(0, region.Size[k] + 1)]))
    const palette = region.BlockStatePalette.map(p => resolveState(p.Name, p.Properties, version))
    const bits = BigInt(Math.max(2, Math.ceil(Math.log2(palette.length))))
    const longs = region.BlockStates.map(v => Array.isArray(v) ? (BigInt(v[0] >>> 0) << 32n) | BigInt(v[1] >>> 0) : BigInt.asUintN(64, BigInt(v)))
    const volume = size.x * size.y * size.z
    if (longs.length !== Math.ceil(volume * Number(bits) / 64)) throw new Error(`Invalid packed block array: ${regionName}`)
    const mask = (1n << bits) - 1n
    for (let i = 0; i < volume; i++) {
      const bit = BigInt(i) * bits
      const word = Number(bit / 64n)
      const offset = bit % 64n
      let value = longs[word] >> offset
      if (offset + bits > 64n) value |= longs[word + 1] << (64n - offset)
      const block = palette[Number(value & mask)]
      if (!block) throw new Error(`Palette index out of bounds: ${regionName}, ${i}`)
      addCell(cells, { x: min.x + i % size.x, y: min.y + Math.floor(i / (size.x * size.z)), z: min.z + Math.floor(i / size.x) % size.z }, block)
    }
    for (const data of region.TileEntities || []) tiles.push({ pos: { x: min.x + data.x, y: min.y + data.y, z: min.z + data.z }, data })
    for (const data of region.Entities || []) entities.push({ region: regionName, regionMin: min, regionPosition: { ...region.Position }, data })
  }
  return finishPlan(cells, tiles, entities, version, origin, {
    format: 'litematic',
    name: source.Metadata?.Name,
    author: source.Metadata?.Author,
    sourceDataVersion: source.MinecraftDataVersion,
    regionCount: Object.keys(source.Regions || {}).length
  })
}

function decodeSponge (source, version, origin) {
  source = source.Schematic || source
  const paletteData = source.Palette || source.Blocks?.Palette
  const data = source.BlockData || source.Blocks?.Data
  if (!paletteData || !data) throw new Error('Expected Litematica or Sponge v2/v3 schematic')
  const palette = []
  for (const [text, index] of Object.entries(paletteData)) {
    const [name, properties] = text.split('[')
    palette[index] = resolveState(name, properties ? Object.fromEntries(properties.slice(0, -1).split(',').map(p => p.split('='))) : {}, version)
  }
  const cells = new Map()
  const volume = source.Width * source.Height * source.Length
  let cursor = 0
  for (let i = 0; i < volume; i++) {
    let value = 0
    let shift = 0
    let byte
    do {
      if (cursor >= data.length || shift >= 35) throw new Error('Invalid schematic varint')
      byte = data[cursor++] & 255
      value |= (byte & 127) << shift
      shift += 7
    } while (byte & 128)
    if (!palette[value]) throw new Error('Schematic palette index out of bounds')
    addCell(cells, { x: i % source.Width, y: Math.floor(i / (source.Width * source.Length)), z: Math.floor(i / source.Width) % source.Length }, palette[value])
  }
  if (cursor !== data.length) throw new Error('Unexpected extra schematic block data')
  const tiles = (source.BlockEntities || source.Blocks?.BlockEntities || []).map(data => ({ pos: { x: data.Pos[0], y: data.Pos[1], z: data.Pos[2] }, data }))
  return finishPlan(cells, tiles, source.Entities || [], version, origin, { format: 'sponge', sourceDataVersion: source.DataVersion, music: source.Metadata?.MineflayerMusic === 1 })
}

async function readPlan (filename, version, origin) {
  const { parsed } = await nbt.parse(await fs.readFile(filename))
  const source = nbt.simplify(parsed)
  const plan = source.Regions ? decodeLitematic(source, version, origin) : decodeSponge(source, version, origin)
  plan.filename = filename
  return plan
}

const mutationCoordinators = new WeakMap()

function createBuildContext (plan, world) {
  const context = Object.create(Build.prototype)
  context.world = world
  if (!mutationCoordinators.has(plan)) mutationCoordinators.set(plan, new (require('./physicalMutations').PhysicalMutationCoordinator)())
  context.mutations = mutationCoordinators.get(plan)
  context.min = plan.min
  context.max = plan.max
  context.blocks = {}
  context.properties = {}
  context.items = {}
  const Block = require('prismarine-block')(plan.version)
  const data = require('minecraft-data')(plan.version)
  for (const task of [...plan.tasks, ...preparePhysicalPlan(plan).tasks]) {
    const block = Block.fromStateId(task.state, 0)
    context.blocks[task.state] = block
    context.properties[task.state] = block.getProperties()
    context.items[task.state] = data.itemsByName[itemNameForBlock(block.name)]
  }
  const facingData = require('./facingData.json')
  context.getFacing = function (state, facing) {
    if (!facing) return { facing: null, faceDirection: false, is3D: false }
    if (facingData[this.blocks[state].name]) return Build.prototype.getFacing.call(this, state, facing)
    return { facing, faceDirection: false, is3D: false }
  }
  return context
}

function inspectPlan (plan) {
  const data = require('minecraft-data')(plan.version)
  const counts = {}
  const issues = []
  for (const task of plan.tasks) {
    counts[task.name] = (counts[task.name] || 0) + 1
    if (!data.itemsByName[itemNameForBlock(task.name)] && !['piston_head', 'nether_portal'].includes(task.name)) issues.push({ id: task.id, block: task.name, reason: 'no-direct-placement-item' })
    if (task.blockEntity?.Items?.length || Object.keys(task.blockEntity?.components || {}).length) {
      issues.push({ id: task.id, block: task.name, reason: 'requires-block-entity-contents', keys: Object.keys(task.blockEntity) })
    }
  }
  return { name: plan.name, version: plan.version, blocks: plan.tasks.length, air: plan.air.length, layers: plan.layers.length, bounds: { min: plan.min, max: plan.max }, counts, blockEntities: plan.blockEntities.length, entities: plan.entities.length, issues }
}

function preparePhysicalPlan (plan) {
  const Block = require('prismarine-block')(plan.version)
  const tasks = []
  const derived = []
  for (const task of plan.tasks) {
    const properties = Block.fromStateId(task.state, 0).getProperties()
    if (task.name === 'bubble_column') {
      const water = resolveState('water', { level: 0 }, plan.version)
      tasks.push({ ...task, name: 'water', state: water.stateId, generatedTarget: { name: task.name, state: task.state } })
      derived.push({ ...task, reason: 'generated-after-source-water' })
      continue
    }
    let reason
    if (task.name === 'piston_head') reason = 'generated-by-piston'
    if (task.name === 'nether_portal') reason = 'generated-after-frame-ignition'
    if (task.name.endsWith('_door') && properties.half === 'upper') reason = 'generated-by-lower-door'
    if (task.name === 'water' && String(properties.level) !== '0') reason = 'generated-by-source-water'
    if (reason) derived.push({ ...task, reason })
    else tasks.push(task)
  }
  return { ...plan, tasks, derived, layers: [...new Set(tasks.map(t => t.pos.y))] }
}

module.exports = { readPlan, decodeLitematic, decodeSponge, resolveState, matchesTarget, matchesPhysicalTarget, dynamicProperties, itemNameForBlock, createBuildContext, inspectPlan, preparePhysicalPlan }
