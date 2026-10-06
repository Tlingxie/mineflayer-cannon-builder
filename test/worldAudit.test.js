const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { auditWorld } = require('../lib/worldAudit')
const { resolveState } = require('../lib/strictSchematic')

test('saved audit accepts vanilla exterior light sections but rejects missing in-range block data', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-light-audit-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const nbt = require('prismarine-nbt')
  const zlib = require('node:zlib')
  const Anvil = require('prismarine-provider-anvil').Anvil('1.21.4')
  const Chunk = require('prismarine-chunk')('1.21.4')
  const chunk = new Chunk()
  const stone = resolveState('stone')
  chunk.setBlockStateId(new Vec3(0, -60, 0), stone.stateId)
  const anvil = new Anvil(directory)
  await anvil.save(0, 0, chunk)
  await anvil.close()
  const filename = path.join(directory, 'r.0.0.mca')
  const original = await fs.readFile(filename)
  const offset = original.readUIntBE(0, 3) * 4096
  const raw = nbt.parseUncompressed(zlib.inflateSync(original.subarray(offset + 5, offset + 4 + original.readUInt32BE(offset))))
  const sections = raw.value.sections.value.value
  const write = async () => {
    const bytes = zlib.deflateSync(nbt.writeUncompressed(raw))
    const sectors = Math.ceil((bytes.length + 5) / 4096)
    const region = Buffer.alloc(Math.max(original.length, offset + sectors * 4096))
    original.copy(region)
    region[3] = sectors
    region.writeUInt32BE(bytes.length + 1, offset)
    region[offset + 4] = 2
    bytes.copy(region, offset + 5)
    await fs.writeFile(filename, region)
    return region
  }
  sections.push({ Y: nbt.byte(-5), SkyLight: nbt.byteArray(Array(2048).fill(-1)) })
  sections.push({ Y: nbt.byte(20), BlockLight: nbt.byteArray(Array(2048).fill(0)) })
  const before = await write()
  const plan = { version: '1.21.4', tasks: [{ id: '0,-60,0', name: 'stone', pos: new Vec3(0, -60, 0), state: stone.stateId }], air: [] }
  assert.equal((await auditWorld({ plan, regionDirectory: directory })).verified, true)
  assert.deepEqual(await fs.readFile(filename), before)
  delete sections.find(section => section.Y.value === -4).block_states
  await write()
  await assert.rejects(auditWorld({ plan, regionDirectory: directory }), /Missing saved block or biome data/)
})

test('saved audit reads negative chunks independently, reports state and air mismatches without changing files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-world-audit-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const Anvil = require('prismarine-provider-anvil').Anvil('1.21.4')
  const Chunk = require('prismarine-chunk')('1.21.4')
  const chunk = new Chunk()
  const stone = resolveState('stone')
  const desiredRail = resolveState('powered_rail', { shape: 'ascending_north' })
  const actualRail = resolveState('powered_rail', { shape: 'north_south' })
  chunk.setBlockStateId(new Vec3(15, -60, 15), stone.stateId)
  chunk.setBlockStateId(new Vec3(14, -59, 15), actualRail.stateId)
  chunk.setBlockStateId(new Vec3(13, -60, 15), stone.stateId)
  const anvil = new Anvil(directory)
  await anvil.save(-1, -1, chunk)
  await anvil.close()
  const filename = path.join(directory, 'r.-1.-1.mca')
  const before = await fs.readFile(filename)
  const plan = {
    version: '1.21.4',
    tasks: [
      { id: '-1,-60,-1', name: 'stone', pos: new Vec3(-1, -60, -1), state: stone.stateId },
      { id: '-2,-59,-1', name: 'powered_rail', pos: new Vec3(-2, -59, -1), state: desiredRail.stateId }
    ],
    air: [new Vec3(-3, -60, -1), new Vec3(-4, -60, -1)]
  }
  const result = await auditWorld({ plan, regionDirectory: directory })
  assert.equal(result.verified, false)
  assert.equal(result.checkedBlocks, 2)
  assert.equal(result.checkedAir, 2)
  assert.deepEqual(result.mismatches.map(item => item.id), ['-2,-59,-1'])
  assert.deepEqual(result.occupiedAir.map(item => item.pos), [new Vec3(-3, -60, -1)])
  assert.equal(result.chunksRead, 1)
  assert.equal(result.regions[0].sha256.length, 64)
  assert.deepEqual(await fs.readFile(filename), before)
  const partial = await auditWorld({ plan: { ...plan, air: [] }, regionDirectory: directory, maxLayer: -60 })
  assert.equal(partial.verified, true)
  assert.equal(partial.completeBlueprint, false)
  const airAbove = await auditWorld({ plan: { ...plan, tasks: [plan.tasks[0]], air: [new Vec3(-4, -59, -1)] }, regionDirectory: directory, maxLayer: -60 })
  assert.equal(airAbove.completeBlueprint, false)
  await assert.rejects(auditWorld({ plan, regionDirectory: directory, maxLayer: -61 }), /no blueprint blocks/)
  const missing = { ...plan, tasks: [{ ...plan.tasks[0], pos: new Vec3(-17, -60, -1) }] }
  await assert.rejects(auditWorld({ plan: missing, regionDirectory: directory }), /Missing saved chunk/)
  const sector = before.readUIntBE((31 + 31 * 32) * 4, 3)
  const payloadEnd = sector * 4096 + 4 + before.readUInt32BE(sector * 4096)
  await fs.truncate(filename, payloadEnd)
  const unpadded = await auditWorld({ plan: { ...plan, air: [] }, regionDirectory: directory, maxLayer: -60 })
  assert.equal(unpadded.verified, true)
  assert.equal((await fs.stat(filename)).size, payloadEnd)
  await fs.truncate(filename, payloadEnd - 1)
  await assert.rejects(auditWorld({ plan, regionDirectory: directory }), /Invalid chunk length/)
})

async function comparatorFixture (t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-comparator-audit-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const nbt = require('prismarine-nbt')
  const zlib = require('node:zlib')
  const Anvil = require('prismarine-provider-anvil').Anvil('1.21.4')
  const Chunk = require('prismarine-chunk')('1.21.4')
  const state = resolveState('comparator').stateId
  const chunk = new Chunk()
  chunk.setBlockStateId(new Vec3(15, -60, 15), state)
  chunk.setBlockStateId(new Vec3(14, -59, 15), state)
  const anvil = new Anvil(directory)
  await anvil.save(-1, -1, chunk)
  await anvil.close()
  const filename = path.join(directory, 'r.-1.-1.mca')
  const original = await fs.readFile(filename)
  const index = (31 + 31 * 32) * 4
  const offset = original.readUIntBE(index, 3) * 4096
  const raw = nbt.parseUncompressed(zlib.inflateSync(original.subarray(offset + 5, offset + 4 + original.readUInt32BE(offset))))
  const plan = {
    version: '1.21.4',
    tasks: [
      { id: '-1,-60,-1', name: 'comparator', pos: new Vec3(-1, -60, -1), state, blockEntity: { id: 'minecraft:comparator', x: 1, y: 2, z: 3, OutputSignal: 0 } },
      { id: '-2,-59,-1', name: 'comparator', pos: new Vec3(-2, -59, -1), state, blockEntity: { id: 'minecraft:comparator', x: 4, y: 5, z: 6, OutputSignal: 15 } }
    ],
    air: []
  }
  const entities = [
    { id: nbt.string('minecraft:comparator'), x: nbt.int(-1), y: nbt.int(-60), z: nbt.int(-1), OutputSignal: nbt.int(0) },
    { id: nbt.string('minecraft:comparator'), x: nbt.int(-2), y: nbt.int(-59), z: nbt.int(-1), OutputSignal: nbt.int(15) }
  ]
  async function write (values = entities) {
    raw.value.block_entities = nbt.list(nbt.comp(values))
    const bytes = zlib.deflateSync(nbt.writeUncompressed(raw))
    const sectors = Math.ceil((bytes.length + 5) / 4096)
    const region = Buffer.alloc(Math.max(original.length, offset + sectors * 4096))
    original.copy(region)
    region[index + 3] = sectors
    region.writeUInt32BE(bytes.length + 1, offset)
    region[offset + 4] = 2
    bytes.copy(region, offset + 5)
    await fs.writeFile(filename, region)
    return region
  }
  await write()
  return { directory, filename, plan, entities, write, nbt }
}

test('saved comparator outputs use world coordinates, retain block counts and honor maxLayer without writing MCA', async t => {
  const f = await comparatorFixture(t)
  const before = await fs.readFile(f.filename)
  const result = await auditWorld({ plan: f.plan, regionDirectory: f.directory })
  assert.deepEqual(result.comparators, { checked: 2, verified: true, mismatches: [] })
  assert.equal(result.verified, true)
  assert.equal(result.checkedBlocks, 2)
  assert.deepEqual(await fs.readFile(f.filename), before)
  f.entities[1].OutputSignal = f.nbt.int(14)
  await f.write()
  const stale = await auditWorld({ plan: f.plan, regionDirectory: f.directory })
  assert.equal(stale.verified, false)
  assert.equal(stale.comparators.verified, false)
  assert.equal(stale.comparators.checked, 2)
  assert.deepEqual(stale.comparators.mismatches.map(item => item.id), ['-2,-59,-1'])
  assert.deepEqual(stale.mismatches, [])
  assert.deepEqual(stale.activeMismatches, [])
  assert.deepEqual(stale.derivedPending, [])
  const partial = await auditWorld({ plan: f.plan, regionDirectory: f.directory, maxLayer: -60 })
  assert.equal(partial.verified, true)
  assert.deepEqual(partial.comparators, { checked: 1, verified: true, mismatches: [] })
})

test('saved comparator audit rejects missing, duplicate, wrong identity, position and invalid outputs', async t => {
  const f = await comparatorFixture(t)
  const original = f.entities[0]
  const cases = [
    [],
    [original, original],
    [{ ...original, id: f.nbt.string('minecraft:chest') }],
    [{ ...original, x: f.nbt.int(-3) }],
    [{ ...original, y: f.nbt.int(-59) }],
    [{ ...original, z: f.nbt.int(-2) }],
    [{ ...original, OutputSignal: f.nbt.int(-1) }],
    [{ ...original, OutputSignal: f.nbt.int(16) }],
    [{ ...original, OutputSignal: f.nbt.float(0.5) }],
    [{ ...original, OutputSignal: f.nbt.string('0') }],
    [{ id: original.id, x: original.x, y: original.y, z: original.z }]
  ]
  for (const [index, values] of cases.entries()) {
    await f.write([...values, f.entities[1]])
    const result = await auditWorld({ plan: f.plan, regionDirectory: f.directory })
    assert.equal(result.verified, false, `invalid saved comparator case ${index}`)
    assert.equal(result.comparators.checked, 2)
    assert.deepEqual(result.comparators.mismatches.map(item => item.id), ['-1,-60,-1'])
    assert.deepEqual(result.mismatches, [])
  }
})

test('saved comparator audit rejects invalid or duplicate source expectations within the selected layers', async t => {
  const f = await comparatorFixture(t)
  for (const blockEntity of [undefined, { id: 'minecraft:chest', OutputSignal: 0 }, { id: 'minecraft:comparator' }, ...[-1, 16, 0.5, '0'].map(OutputSignal => ({ id: 'minecraft:comparator', OutputSignal }))]) {
    const plan = { ...f.plan, tasks: [{ ...f.plan.tasks[0], blockEntity }, f.plan.tasks[1]] }
    await assert.rejects(auditWorld({ plan, regionDirectory: f.directory }), /source comparator/i)
  }
  await assert.rejects(auditWorld({ plan: { ...f.plan, tasks: [...f.plan.tasks, f.plan.tasks[0]] }, regionDirectory: f.directory }), /duplicate source comparator/i)
  f.plan.tasks[1].blockEntity.OutputSignal = 16
  assert.equal((await auditWorld({ plan: f.plan, regionDirectory: f.directory, maxLayer: -60 })).verified, true)
})
