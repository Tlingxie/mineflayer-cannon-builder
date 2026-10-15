const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')

let createMusicWorkspace
try { ({ createMusicWorkspace } = require('../lib/musicWorkspace')) } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }

function fixture (count = 30, width = 2750) {
  const plan = { music: { moduleCount: (width - 2) / 4 }, min: new Vec3(0, 64, 3456), max: new Vec3(width, 69, 3485), tasks: [], air: [] }
  const moves = []
  const air = { name: 'air', stateId: 0 }
  const workers = Array.from({ length: count }, (_, index) => {
    const worker = { id: `bot${index}`, position: new Vec3(0, 72, 3456), bot: { world: { getColumn: () => ({}) }, waitForChunksToLoad: async () => {}, blockAt: () => air } }
    worker.executor = { deadline: 0, move: async destination => { assert.ok(worker.position.distanceTo(destination) <= 8.001); assert.equal(worker.executor.deadline, 0); moves.push({ worker: worker.id, destination }); worker.position = destination.clone() } }
    return worker
  })
  assert.equal(typeof createMusicWorkspace, 'function', 'Long music workspace must be implemented')
  return { plan, workers, moves, air }
}

test('only long music uses a workspace and 30 homes cover the narrow 2750 block track', async () => {
  const { plan, workers } = fixture()
  assert.equal(createMusicWorkspace({ ...plan, music: undefined }, workers), null)
  assert.equal(createMusicWorkspace({ ...plan, max: plan.max.offset(-2700, 0, 0) }, workers), null)
  const workspace = createMusicWorkspace(plan, workers)
  await workspace.parkForRead({ reason: 'initial' })
  assert.equal(new Set(workers.map(worker => worker.position.x)).size, 30)
  assert.ok(workers.every(worker => Math.abs(worker.position.z - 3470.5) < 0.15))
  assert.ok(workers.every(worker => worker.position.y >= plan.max.y + 2.85))
  for (let x = 2; x < 2748; x += 4) {
    const owner = workspace.ownerForTask({ pos: new Vec3(x, 64, 3456) })
    for (let offset = 1; offset < 4; offset++) assert.equal(workspace.ownerForTask({ pos: new Vec3(x + offset, 68, 3484) }), owner)
  }
})

test('100 workers own every module and cover both edges of a 5002 block music track', async () => {
  const { plan, workers, air } = fixture(100, 5002)
  const workerIds = new Set(workers.map(worker => worker.id))
  const owners = new Set()
  const workspace = createMusicWorkspace(plan, workers)
  await workspace.parkForRead()
  assert.equal(workspace.homes.size, 100)
  assert.equal(new Set(workers.map(worker => worker.position.x)).size, 100)
  for (let x = plan.min.x; x < plan.max.x; x++) {
    const near = { pos: new Vec3(x, plan.min.y, plan.min.z) }
    const far = { pos: new Vec3(x, plan.max.y - 1, plan.max.z - 1) }
    const owner = workspace.ownerForTask(near)
    assert.ok(workerIds.has(owner))
    assert.equal(workspace.ownerForTask(far), owner)
    assert.equal(workspace.readBlock(near.pos), air)
    assert.equal(workspace.readBlock(far.pos), air)
    owners.add(owner)
    if (x >= 2 && (x - 2) % 4 !== 0) {
      assert.equal(owner, workspace.ownerForTask({ pos: near.pos.offset(-((x - 2) % 4), 0, 0) }))
    }
  }
  assert.deepEqual(owners, workerIds)
})

test('insufficient worker coverage is rejected instead of validating unloaded portions', () => {
  const { plan, workers } = fixture(1)
  assert.throws(() => createMusicWorkspace(plan, workers), /more bots|更多.*bot|覆盖/i)
})

test('workspace reads only currently loaded nearby columns and never treats a missing chunk as air', async () => {
  const { plan, workers, air } = fixture(2, 130)
  const workspace = createMusicWorkspace(plan, workers)
  await workspace.parkForRead()
  const target = new Vec3(0, 64, 3456)
  assert.equal(workspace.readBlock(target), air)
  workers[0].bot.world.getColumn = () => null
  workers[1].bot.world.getColumn = () => null
  assert.equal(workspace.readBlock(target), null)
  for (const worker of workers) {
    worker.bot.world.getColumn = () => ({})
    worker.position = worker.position.offset(300, 0, 0)
  }
  assert.equal(workspace.readBlock(target), null, 'Retained distant column data cannot satisfy verification')
})

test('read barrier returns every owner home and rejects real missing columns', async () => {
  const { plan, workers } = fixture(2, 130)
  const workspace = createMusicWorkspace(plan, workers, { loadTimeoutMs: 0 })
  await workspace.parkForRead()
  const homes = workers.map(worker => worker.position.clone())
  workers[0].position = workers[0].position.offset(15, -3, 0)
  workers[1].position = workers[1].position.offset(-15, -3, 0)
  await workspace.parkForRead()
  assert.ok(workers.every((worker, index) => worker.position.distanceTo(homes[index]) < 0.15))
  for (const worker of workers) worker.bot.world.getColumn = () => null
  await assert.rejects(workspace.parkForRead(), /chunk.*load|区块/i)
})

for (const workerCount of [2, 100]) {
  test(`${workerCount} workers require blueprint columns while unloaded columns outside its bounds do not block`, async () => {
    const { plan, workers, air } = fixture(workerCount, 130)
    for (const worker of workers) worker.bot.world.getColumn = (x, z) => x >= 0 && x <= 8 && z >= 216 && z <= 217 ? {} : null
    const workspace = createMusicWorkspace(plan, workers, { loadTimeoutMs: 0 })
    await workspace.parkForRead()
    assert.equal(workspace.readBlock(new Vec3(129, 64, 3484)), air)
    assert.equal(workspace.readBlock(new Vec3(144, 64, 3440)), null)
    for (const worker of workers) worker.bot.world.getColumn = (x, z) => x >= 0 && x <= 7 && z >= 216 && z <= 217 ? {} : null
    await assert.rejects(workspace.parkForRead(), /chunk not loaded at 8,216/)
  })
}

test('every home is a block center so arrival tolerance cannot cross a chunk boundary', () => {
  const { plan, workers } = fixture()
  const workspace = createMusicWorkspace(plan, workers)
  for (const home of workspace.homes.values()) {
    assert.equal(home.x - Math.floor(home.x), 0.5)
    assert.equal(home.z - Math.floor(home.z), 0.5)
    assert.equal(Math.floor((home.x - 0.15) / 16), Math.floor((home.x + 0.15) / 16))
    assert.equal(Math.floor((home.z - 0.15) / 16), Math.floor((home.z + 0.15) / 16))
  }
})

test('task approach stays within its fixed section and completes flight before placement deadline begins', async () => {
  const { plan, workers, moves } = fixture(2, 130)
  const workspace = createMusicWorkspace(plan, workers)
  await workspace.parkForRead()
  const task = { pos: new Vec3(126, 64, 3483) }
  const owner = workers.find(worker => worker.id === workspace.ownerForTask(task))
  await workspace.approachTask(owner, task)
  assert.ok(owner.position.distanceTo(task.pos) < 4)
  assert.ok(moves.length > 1)
  await assert.rejects(workspace.approachTask(workers.find(worker => worker !== owner), task), /owner|归属/i)
})

test('long staging clears tall existing builds while local task flights retain their current altitude', async () => {
  const { plan, workers, moves } = fixture(2, 130)
  for (const worker of workers) worker.position = new Vec3(-500, 64, 3456)
  const workspace = createMusicWorkspace(plan, workers)
  await workspace.parkForRead({ reason: 'staging' })
  assert.ok(moves.some(move => move.destination.y === 200))
  const task = { pos: new Vec3(126, 64, 3483) }
  const owner = workers.find(worker => worker.id === workspace.ownerForTask(task))
  await workspace.approachTask(owner, task)
  moves.length = 0
  await workspace.approachTask(owner, { pos: task.pos.offset(-16, 0, 0) })
  assert.ok(moves.length > 0)
  assert.ok(moves.every(move => move.destination.y < 70))
})

test('a read barrier rejects active placement and drains already issued flights on cancellation', async () => {
  const { plan, workers } = fixture(2, 130)
  const workspace = createMusicWorkspace(plan, workers)
  workers[0].executor.busy = true
  await assert.rejects(workspace.parkForRead(), /busy placement/)
  workers[0].executor.busy = false
  let release
  const gate = new Promise(resolve => { release = resolve })
  const controller = new AbortController()
  let issued = 0
  let finished = false
  for (const worker of workers) worker.executor.move = async () => { issued++; await gate }
  const running = workspace.parkForRead({ signal: controller.signal })
  const rejected = assert.rejects(running, /cancel|abort/i).then(() => { finished = true })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  release()
  await rejected
  assert.equal(issued, 2)
})
