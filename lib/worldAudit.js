const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const { matchesTarget, preparePhysicalPlan } = require('./strictSchematic')

const AIR = new Set(['air', 'cave_air', 'void_air'])

async function auditWorld ({ plan, regionDirectory, maxLayer = Infinity }) {
  if (!plan?.version || !Array.isArray(plan.tasks) || !Array.isArray(plan.air)) throw new TypeError('A decoded blueprint is required')
  if (maxLayer !== Infinity && !Number.isSafeInteger(maxLayer)) throw new TypeError('maxLayer must be an integer')
  if (!plan.tasks.some(task => task.pos.y <= maxLayer)) throw new Error('Audit height selects no blueprint blocks')
  const positionKey = pos => `${pos.x},${pos.y},${pos.z}`
  const comparatorTargets = new Set()
  for (const task of plan.tasks.filter(task => task.name === 'comparator' && task.pos.y <= maxLayer)) {
    if (!['x', 'y', 'z'].every(axis => Number.isSafeInteger(task.pos[axis])) || task.blockEntity?.id !== 'minecraft:comparator' || !Number.isInteger(task.blockEntity.OutputSignal) || task.blockEntity.OutputSignal < 0 || task.blockEntity.OutputSignal > 15) throw new Error(`Invalid source comparator at ${task.id}`)
    const key = positionKey(task.pos)
    if (comparatorTargets.has(key)) throw new Error(`Duplicate source comparator at ${key}`)
    comparatorTargets.add(key)
  }
  const directory = await fs.realpath(regionDirectory)
  const { nbtChunkToPrismarineChunk } = require('prismarine-provider-anvil').chunk(plan.version)
  const Block = require('prismarine-block')(plan.version)
  const derived = new Set(preparePhysicalPlan(plan).derived.map(task => task.id))
  const regions = new Map()
  const chunks = new Map()
  const blockEntities = new Map()
  const evidence = []
  const local = value => ((value % 16) + 16) % 16

  async function readBlock (pos) {
    const cx = Math.floor(pos.x / 16)
    const cz = Math.floor(pos.z / 16)
    const chunkKey = `${cx},${cz}`
    if (!chunks.has(chunkKey)) {
      const filename = `r.${Math.floor(cx / 32)}.${Math.floor(cz / 32)}.mca`
      if (!regions.has(filename)) {
        const data = await fs.readFile(path.join(directory, filename))
        if (data.length < 8192) throw new Error(`Invalid region size: ${filename}`)
        regions.set(filename, data)
        evidence.push({ filename, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') })
      }
      const region = regions.get(filename)
      const index = ((cx & 31) + (cz & 31) * 32) * 4
      const sector = region.readUIntBE(index, 3)
      const count = region[index + 3]
      if (!sector || !count) throw new Error(`Missing saved chunk ${chunkKey}`)
      if (sector < 2 || (sector + count) * 4096 > Math.ceil(region.length / 4096) * 4096 || sector * 4096 + 5 > region.length) throw new Error(`Invalid chunk sector ${chunkKey}`)
      const offset = sector * 4096
      const length = region.readUInt32BE(offset)
      if (length < 2 || length + 4 > count * 4096 || offset + 4 + length > region.length) throw new Error(`Invalid chunk length ${chunkKey}`)
      const compression = region[offset + 4]
      const payload = region.subarray(offset + 5, offset + 4 + length)
      const decompress = { 1: zlib.gunzipSync, 2: zlib.inflateSync, 3: value => value }[compression]
      if (!decompress) throw new Error(`Unsupported chunk compression ${compression} at ${chunkKey}`)
      const raw = nbt.parseUncompressed(decompress(payload))
      const content = nbt.simplify(raw)
      if (content.xPos !== cx || content.zPos !== cz) throw new Error(`Saved chunk coordinates differ at ${chunkKey}`)
      if (content.block_entities !== undefined && !Array.isArray(content.block_entities)) throw new Error(`Invalid saved block entities at ${chunkKey}`)
      const entities = new Map()
      for (const entity of content.block_entities || []) {
        const key = positionKey(entity)
        if (!entities.has(key)) entities.set(key, [])
        entities.get(key).push(entity)
      }
      blockEntities.set(chunkKey, entities)
      const sections = raw.value.sections?.value?.value
      if (!Array.isArray(sections)) throw new Error(`Missing saved chunk sections at ${chunkKey}`)
      raw.value.sections.value.value = sections.filter(section => {
        const y = section.Y?.value
        // Vanilla also saves light for the one section beyond either build limit.
        if ([-5, 20].includes(y) && Object.keys(section).every(name => ['Y', 'SkyLight', 'BlockLight'].includes(name))) return false
        if (!Number.isInteger(y) || y < -4 || y >= 20) throw new Error(`Unexpected saved section height ${y} at ${chunkKey}`)
        if (!section.block_states || !section.biomes) throw new Error(`Missing saved block or biome data at ${chunkKey}, section ${y}`)
        return true
      })
      chunks.set(chunkKey, nbtChunkToPrismarineChunk(raw))
    }
    const result = chunks.get(chunkKey).getBlock(new Vec3(local(pos.x), pos.y, local(pos.z)))
    if (!result) throw new Error(`No saved block at ${pos}`)
    return result
  }

  const result = {
    backend: 'saved-region-files',
    regionDirectory: directory,
    version: plan.version,
    maxLayer: Number.isFinite(maxLayer) ? maxLayer : null,
    completeBlueprint: plan.tasks.every(task => task.pos.y <= maxLayer) && plan.air.every(pos => pos.y <= maxLayer),
    checkedAt: new Date().toISOString(),
    checkedBlocks: 0,
    checkedAir: 0,
    mismatches: [],
    occupiedAir: [],
    comparators: { checked: 0, verified: true, mismatches: [] },
    runtimeStateDifferences: [],
    regions: evidence
  }
  for (const task of plan.tasks) {
    if (task.pos.y > maxLayer) continue
    const wanted = Block.fromStateId(task.state, 0)
    const actual = await readBlock(task.pos)
    result.checkedBlocks++
    if (!matchesTarget(wanted, actual)) result.mismatches.push({ id: task.id, wanted: wanted.name, wantedProperties: wanted.getProperties(), actual: actual.name, actualProperties: actual.getProperties() })
    else if (!matchesTarget(wanted, actual, { exact: true })) result.runtimeStateDifferences.push({ id: task.id, wanted: wanted.getProperties(), actual: actual.getProperties() })
    if (task.name === 'comparator') {
      result.comparators.checked++
      const entities = blockEntities.get(`${Math.floor(task.pos.x / 16)},${Math.floor(task.pos.z / 16)}`).get(positionKey(task.pos)) || []
      const entity = entities[0]
      let reason
      if (entities.length !== 1) reason = entities.length === 0 ? 'missing-block-entity' : 'duplicate-block-entities'
      else if (entity.id !== 'minecraft:comparator' || !['x', 'y', 'z'].every(axis => entity[axis] === task.pos[axis])) reason = 'invalid-block-entity-identity'
      else if (!Number.isInteger(entity.OutputSignal) || entity.OutputSignal < 0 || entity.OutputSignal > 15) reason = 'invalid-output-signal'
      else if (entity.OutputSignal !== task.blockEntity.OutputSignal) reason = 'output-signal-differs'
      if (reason) result.comparators.mismatches.push({ id: task.id, pos: task.pos, expectedOutputSignal: task.blockEntity.OutputSignal, reason, actual: entities.map(({ id, x, y, z, OutputSignal }) => ({ id, x, y, z, OutputSignal })) })
    }
  }
  for (const pos of plan.air) {
    if (pos.y > maxLayer) continue
    const actual = await readBlock(pos)
    result.checkedAir++
    if (!AIR.has(actual.name)) result.occupiedAir.push({ pos, actual: actual.name, properties: actual.getProperties() })
  }
  result.comparators.verified = result.comparators.mismatches.length === 0
  result.verified = result.mismatches.length === 0 && result.occupiedAir.length === 0 && result.comparators.verified
  result.activeMismatches = result.mismatches.filter(item => !derived.has(item.id))
  result.derivedPending = result.mismatches.filter(item => derived.has(item.id))
  result.chunksRead = chunks.size
  return result
}

module.exports = { auditWorld }
