const test = require('node:test')
const assert = require('node:assert/strict')
const { PhysicalMutationCoordinator } = require('../lib/physicalMutations')

test('fluid window drains shared mutations and blocks subsequent mutations until release', async () => {
  const c = new PhysicalMutationCoordinator()
  const releaseA = await c.acquire(false)
  const releaseB = await c.acquire(false)
  let fluid = false
  const writer = c.acquire(true).then(release => { fluid = true; return release })
  let later = false
  const reader = c.acquire(false).then(release => { later = true; return release })
  releaseA()
  await Promise.resolve()
  assert.equal(fluid, false)
  releaseB()
  const releaseFluid = await writer
  assert.equal(later, false)
  releaseFluid()
  const releaseLater = await reader
  releaseLater()
})

test('queued cancellation never acquires a mutation and a poisoned coordinator rejects all work', async () => {
  const c = new PhysicalMutationCoordinator()
  const release = await c.acquire(false)
  const controller = new AbortController()
  const cancelled = c.acquire(true, controller.signal)
  controller.abort()
  await assert.rejects(cancelled, { name: 'AbortError' })
  const waiting = c.acquire(true)
  c.halt(Object.assign(new Error('Unknown bucket outcome'), { code: 'FLUID_OUTCOME_UNKNOWN' }))
  await assert.rejects(waiting, { code: 'FLUID_OUTCOME_UNKNOWN' })
  release()
  await assert.rejects(c.acquire(false), { code: 'FLUID_OUTCOME_UNKNOWN' })
})

test('independent build contexts for the same plan share the mutation coordinator', () => {
  const { createBuildContext } = require('../lib/strictSchematic')
  const plan = { version: '1.21.4', tasks: [] }
  const a = createBuildContext(plan, {})
  const b = createBuildContext(plan, {})
  const other = createBuildContext({ ...plan }, {})
  assert.ok(a.mutations)
  assert.equal(a.mutations, b.mutations)
  assert.notEqual(a.mutations, other.mutations)
})
