const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const Block = require('prismarine-block')('1.21.4')
const { preparePhysicalPlan } = require('../lib/strictSchematic')
const { normalizeMinecartEntities } = require('../lib/physicalMechanisms')
const { verifyFrozenAssembly } = require('../lib/frozenAssembly')
const { parseArguments, main } = require('../scripts/verify-assembly')

function fixture () {
  const plan = { version: '1.21.4', tasks: [], air: [new Vec3(20, 0, 0)], entities: [], sourceMin: new Vec3(0, 0, 0), origin: new Vec3(0, 0, 0) }
  const add = (name, x, properties = {}, Items) => {
    const pos = new Vec3(x, 0, 0)
    const task = { id: `${x},0,0`, name, pos, state: Block.fromProperties(name, properties, 0).stateId }
    if (Items !== undefined) task.blockEntity = { Items }
    plan.tasks.push(task)
    return task
  }
  add('stone', 0)
  const full = add('hopper', 1, {}, [{ Slot: 2, id: 'minecraft:shears', count: 1 }])
  const empty = add('chest', 2, {}, [])
  add('campfire', 3, {}, [])
  const calls = []
  const worldAudit = () => ({
    backend: 'saved-region-files',
    version: plan.version,
    completeBlueprint: true,
    maxLayer: null,
    checkedBlocks: plan.tasks.length,
    checkedAir: plan.air.length,
    mismatches: [],
    activeMismatches: [],
    derivedPending: [],
    occupiedAir: [],
    runtimeStateDifferences: [],
    regions: []
  })
  const snapshot = {
    version: plan.version,
    readTickState: async ({ signal }) => {
      calls.push({ method: 'tick', signal })
      return { frozen: true, quiescent: true, gameTime: 400, evidence: [{ command: 'tick query' }, { command: 'time query gametime', response: 'The time is 400' }] }
    },
    verifyContainer: async (task, { signal }) => {
      calls.push({ method: 'container', id: task.id, signal })
      return { verified: true, slots: task.blockEntity.Items.length, items: task.blockEntity.Items.length, evidence: [{ command: `data get block ${task.pos.x} 0 0` }] }
    },
    readMinecart: async (expected, { signal }) => {
      calls.push({ method: 'cart', id: expected.id, signal })
      return {
        name: expected.name,
        typeSource: 'server-selector',
        pos: expected.pos,
        uuid: `00000000-0000-0000-0000-${String(plan.entities.indexOf(expected.source) + 1).padStart(12, '0')}`,
        entries: [],
        data: { Items: [] },
        enabled: expected.expectedEnabled,
        evidence: { command: `data get entity ${expected.id}` }
      }
    }
  }
  const mismatch = (audit, task, actual, actualProperties = {}) => {
    const wanted = Block.fromStateId(task.state, 0)
    const item = { id: task.id, wanted: wanted.name, wantedProperties: wanted.getProperties(), actual, actualProperties }
    audit.mismatches.push(item)
    const derived = preparePhysicalPlan(plan).derived.some(item => item.id === task.id)
    audit[derived ? 'derivedPending' : 'activeMismatches'].push(item)
  }
  const cart = (x = 5, name = 'hopper_minecart', Enabled = 0, railName = 'activator_rail') => {
    add(railName, x, { shape: 'north_south' })
    plan.entities.push({ regionPosition: new Vec3(0, 0, 0), data: { id: `minecraft:${name}`, Pos: [x + 0.5, 0.0625, 0.5], Items: [], ...(Enabled === undefined ? {} : { Enabled }) } })
    return plan.entities.at(-1)
  }
  return { plan, add, full, empty, snapshot, calls, worldAudit, mismatch, cart }
}

test('strictly verifies every source container and brackets reads with frozen gametime checks', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  const report = await verifyFrozenAssembly({ plan: f.plan, worldAudit: f.worldAudit(), snapshot: f.snapshot, signal })
  assert.equal(report.activeAssemblyVerified, true)
  assert.equal(report.completeBlueprintVerified, true)
  assert.equal(report.strictContainersVerified, 2)
  assert.deepEqual(report.naturalPending, [])
  assert.deepEqual(f.calls.map(call => call.method), ['tick', 'container', 'container', 'tick'])
  assert.deepEqual(f.calls.filter(call => call.method === 'container').map(call => call.id), [f.full.id, f.empty.id])
  assert.ok(f.calls.every(call => call.signal === signal))
  assert.equal(report.evidence.length, 6)
  assert.equal(report.verified, undefined)
})

test('rejects partial, wrong-version, active-error, and occupied-air world audits before live reads', async () => {
  for (const mutation of [
    a => { a.completeBlueprint = false }, a => { a.version = '1.21.3' },
    a => { a.checkedBlocks-- }, a => { a.checkedAir-- },
    a => { a.activeMismatches.push({ id: '0,0,0' }) }, a => { a.occupiedAir.push({ actual: 'dirt' }) },
    a => { delete a.mismatches }, a => { delete a.derivedPending }
  ]) {
    const f = fixture()
    const audit = f.worldAudit()
    mutation(audit)
    await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: audit, snapshot: f.snapshot }), /audit|blueprint|air|active/i)
    assert.deepEqual(f.calls, [])
  }
})

test('rejects a physical-only plan even when its audit counts match', async () => {
  const f = fixture()
  f.add('piston_head', 6)
  f.plan = preparePhysicalPlan(f.plan)
  const audit = { ...f.worldAudit(), checkedBlocks: f.plan.tasks.length }
  await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: audit, snapshot: f.snapshot }), /original|physical/i)
  assert.deepEqual(f.calls, [])
})

test('only missing flowing water, changed flow level, and missing piston heads are natural block pending', async () => {
  const f = fixture()
  const water = f.add('water', 6, { level: 8 })
  const flow = f.add('water', 7, { level: 9 })
  const head = f.add('piston_head', 8)
  const audit = f.worldAudit()
  f.mismatch(audit, water, 'air')
  f.mismatch(audit, flow, 'water', { level: 8 })
  f.mismatch(audit, head, 'cave_air')
  const result = await verifyFrozenAssembly({ plan: f.plan, worldAudit: audit, snapshot: f.snapshot })
  assert.equal(result.activeAssemblyVerified, true)
  assert.equal(result.completeBlueprintVerified, false)
  assert.deepEqual(result.naturalPending.map(entry => entry.id), [water.id, flow.id, head.id])
  assert.deepEqual(result.naturalPending.map(entry => entry.actual), ['air', 'water', 'cave_air'])
})

test('missing portal, upper door, source water, and obstructed derived targets fail', async () => {
  for (const [name, properties, actual, actualProperties] of [
    ['nether_portal', {}, 'air', {}], ['oak_door', { half: 'upper' }, 'air', {}],
    ['water', { level: 0 }, 'air', {}], ['water', { level: 8 }, 'stone', {}],
    ['piston_head', {}, 'moving_piston', {}], ['piston_head', {}, 'water', { level: 0 }],
    ['water', { level: 8 }, 'water', { level: 'invalid' }]
  ]) {
    const f = fixture()
    const target = f.add(name, 6, properties)
    const audit = f.worldAudit()
    f.mismatch(audit, target, actual, actualProperties)
    await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: audit, snapshot: f.snapshot }), /mismatch|active|natural/i)
    assert.deepEqual(f.calls, [])
  }
})

test('does not trust mislabeled, missing, duplicated, or foreign derived mismatch records', async () => {
  for (const mutation of [
    (f, a) => { a.activeMismatches = [] },
    (f, a) => { a.mismatches[0].id = '99,99,99'; a.activeMismatches = [] },
    (f, a) => { a.mismatches[0].wanted = 'water'; a.activeMismatches = [] },
    (f, a) => { a.derivedPending.push({ id: '99,99,99' }) },
    (f, a) => { a.mismatches.push(a.mismatches[0]); a.activeMismatches = [] }
  ]) {
    const f = fixture()
    const audit = f.worldAudit()
    f.mismatch(audit, f.plan.tasks[0], 'air')
    mutation(f, audit)
    await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: audit, snapshot: f.snapshot }), /audit|mismatch|active/i)
  }
})

test('requires frozen, quiescent, stable integer gametime at both ends', async () => {
  for (const invalid of [{ frozen: false }, { quiescent: false }, { gameTime: 401 }, { gameTime: undefined }]) {
    const f = fixture()
    const read = f.snapshot.readTickState
    let count = 0
    f.snapshot.readTickState = async settings => ({ ...await read(settings), ...(count++ === 1 ? invalid : {}) })
    await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: f.worldAudit(), snapshot: f.snapshot }), /frozen|quiescent|gametime/i)
  }
  const f = fixture()
  f.snapshot.readTickState = async () => ({ frozen: true, quiescent: false, gameTime: 400 })
  await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: f.worldAudit(), snapshot: f.snapshot }), /quiescent/i)
  assert.deepEqual(f.calls, [])
})

test('propagates strict slot mismatches without converting them to aggregate or natural allowances', async () => {
  const f = fixture()
  const error = Object.assign(new Error('Container verification failed at slot 2'), { evidence: [{ command: 'data get block 1 0 0', response: 'changed slot' }] })
  f.snapshot.verifyContainer = async () => { throw error }
  await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: f.worldAudit(), snapshot: f.snapshot }), actual => {
    assert.equal(actual, error)
    assert.equal(actual.evidence.length, 3)
    return true
  })
})

test('requires affirmative container verification and rejects malformed source inventories', async () => {
  const f = fixture()
  f.snapshot.verifyContainer = async () => ({ verified: false, evidence: [] })
  await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: f.worldAudit(), snapshot: f.snapshot }), /container/i)
  for (const Items of [undefined, null, {}]) {
    const f = fixture()
    f.full.blockEntity.Items = Items
    await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: f.worldAudit(), snapshot: f.snapshot }), /Items|container/i)
    assert.deepEqual(f.calls, [])
  }
})

test('verifies four separate minecarts and allows only disabled activator hopper natural activation', async () => {
  const f = fixture()
  f.cart(5, 'hopper_minecart', 1)
  delete f.cart(7, 'chest_minecart').data.Enabled
  f.cart(9, 'hopper_minecart', 0)
  f.cart(11, 'hopper_minecart', 1)
  const read = f.snapshot.readMinecart
  f.snapshot.readMinecart = async (...args) => ({ ...await read(...args), enabled: args[0].name === 'hopper_minecart' ? true : undefined })
  const result = await verifyFrozenAssembly({ plan: f.plan, worldAudit: f.worldAudit(), snapshot: f.snapshot })
  assert.equal(result.minecartsVerified, 4)
  assert.equal(result.activeAssemblyVerified, true)
  assert.equal(result.completeBlueprintVerified, false)
  assert.equal(result.naturalPending.length, 1)
  assert.equal(result.naturalPending[0].reason, 'pending-natural-activation')
  assert.equal(result.naturalPending[0].id, 'entity:2:hopper_minecart')
})

test('minecart exact Enabled state and source position within tolerance can complete the blueprint', async () => {
  const f = fixture()
  f.cart()
  const read = f.snapshot.readMinecart
  f.snapshot.readMinecart = async (...args) => ({ ...await read(...args), pos: args[0].pos.offset(0, -0.7, 0) })
  const result = await verifyFrozenAssembly({ plan: f.plan, worldAudit: f.worldAudit(), snapshot: f.snapshot })
  assert.equal(result.completeBlueprintVerified, true)
  assert.equal(result.minecarts[0].distance, 0.7)
})

test('rejects wrong cart type, out-of-range position, invalid UUID, unexpected Items, and other Enabled changes', async () => {
  for (const patch of [
    { name: 'chest_minecart' }, { pos: { x: 99, y: 0, z: 0 } }, { uuid: undefined },
    { data: { Items: [{ Slot: 0, id: 'minecraft:stone', count: 1 }] } },
    { entries: [{ slot: 0, item: { name: 'stone' } }] }, { data: {} }, { enabled: false }
  ]) {
    const f = fixture()
    f.cart(5, 'hopper_minecart', 1)
    const read = f.snapshot.readMinecart
    f.snapshot.readMinecart = async (...args) => ({ ...await read(...args), ...patch })
    await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: f.worldAudit(), snapshot: f.snapshot }), /minecart|uuid|items|enabled/i)
  }
})

test('a nearby minecart cannot satisfy two targets even when both types and poses match', async () => {
  const f = fixture()
  f.cart(5, 'hopper_minecart', 1)
  f.plan.entities.push(structuredClone(f.plan.entities[0]))
  const read = f.snapshot.readMinecart
  f.snapshot.readMinecart = async (...args) => ({ ...await read(...args), uuid: '00000000-0000-0000-0000-000000000001' })
  await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: f.worldAudit(), snapshot: f.snapshot }), /UUID/)
})

test('nonempty or malformed source cart inventories and malformed Enabled are unsupported before reads', async () => {
  for (const patch of [{ Items: [{ Slot: 0, id: 'minecraft:stone', count: 1 }] }, { Items: {} }, { Items: null }, { Enabled: '0' }]) {
    const f = fixture()
    Object.assign(f.cart().data, patch)
    await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: f.worldAudit(), snapshot: f.snapshot }), /minecart|Items|Enabled/i)
    assert.deepEqual(f.calls, [])
  }
})

test('disallows the activation allowance for a non-activator rail and preserves caller state', async () => {
  const f = fixture()
  const source = f.cart(5, 'hopper_minecart', false, 'rail')
  assert.equal(normalizeMinecartEntities(f.plan)[0].expectedEnabled, false)
  const before = structuredClone(source)
  const read = f.snapshot.readMinecart
  f.snapshot.readMinecart = async (...args) => ({ ...await read(...args), enabled: true })
  await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: f.worldAudit(), snapshot: f.snapshot }), /Enabled/)
  assert.deepEqual(source.data, before.data)
})

test('abort cancels before reads and during a snapshot operation without producing success', async () => {
  const f = fixture()
  await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: f.worldAudit(), snapshot: f.snapshot, signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.deepEqual(f.calls, [])
  const controller = new AbortController()
  const read = f.snapshot.verifyContainer
  f.snapshot.verifyContainer = async (...args) => { controller.abort(); return read(...args) }
  await assert.rejects(verifyFrozenAssembly({ plan: f.plan, worldAudit: f.worldAudit(), snapshot: f.snapshot, signal: controller.signal }), { name: 'AbortError' })
  assert.equal(f.calls.filter(call => call.method === 'container').length, 1)
})

test('assembly CLI only accepts a complete saved world, source, origin, and new report destination', () => {
  const args = ['--world', '/saved/world', '--schematic', '/source.litematic', '--origin', '64,-60,0', '--output', '/report.json']
  assert.equal(parseArguments(args).version, '1.21.4')
  assert.deepEqual(parseArguments(args).origin, new Vec3(64, -60, 0))
  for (const invalid of [args.slice(0, -2), [...args, '--port', '25567'], [...args, '--max-y', '-10'], [...args, '--origin', '1,2,3']]) assert.throws(() => parseArguments(invalid))
  assert.throws(() => parseArguments(args.map(value => value === '64,-60,0' ? '64.2,-60,0' : value)))
})

test('assembly CLI verifies backup provenance and writes separate evidence without mutating its world', async t => {
  const fs = require('node:fs/promises')
  const path = require('node:path')
  const os = require('node:os')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'assembly-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const world = path.join(directory, 'backup/world')
  await fs.mkdir(world, { recursive: true })
  const manifest = { schema: 1, constructionFrozen: true, server: { directory: path.resolve(__dirname, '../.runtime/server'), host: '127.0.0.1', port: 25566, version: '1.21.4', pid: 1234, startedAt: 'fixture-start' }, files: [], createdAt: 'fixture' }
  const identity = { ...manifest.server }
  await fs.writeFile(path.join(directory, 'backup/manifest.json'), JSON.stringify(manifest))
  const output = path.join(directory, 'report.json')
  const args = ['--world', world, '--schematic', '/source.litematic', '--origin', '0,0,0', '--output', output]
  const f = fixture()
  const dependencies = {
    readPlan: async () => f.plan,
    auditWorld: async () => f.worldAudit(),
    verifyWorldSnapshot: async () => manifest,
    readManagedIdentity: async () => identity,
    createServerSnapshot: async options => {
      assert.deepEqual(options, { host: '127.0.0.1', port: 25566, version: '1.21.4' })
      return f.snapshot
    },
    log: () => {}
  }
  const result = await main(args, dependencies)
  const saved = JSON.parse(await fs.readFile(output, 'utf8'))
  assert.equal(result.activeAssemblyVerified, true)
  assert.equal(saved.strictContainersVerified, 2)
  assert.equal(saved.provenance.backup.manifestSha256.length, 64)
  assert.match(saved.provenance.callerPrecondition, /external edits/)
  assert.deepEqual(await fs.readdir(world), [])
  await assert.rejects(main(args, dependencies), /EEXIST/)
  await assert.rejects(main(args.map(value => value === output ? path.join(world, 'report.json') : value), dependencies), /outside|world/i)
  identity.pid++
  await assert.rejects(main(args.map(value => value === output ? path.join(directory, 'other.json') : value), dependencies), /identity/i)
  identity.pid--
  manifest.constructionFrozen = false
  await assert.rejects(main(args.map(value => value === output ? path.join(directory, 'other.json') : value), dependencies), /frozen|backup/i)
})
