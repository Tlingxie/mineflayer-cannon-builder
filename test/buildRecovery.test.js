const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { buildIdentity, parseRecovery } = require('../lib/buildRecovery')
const { resolveState } = require('../lib/strictSchematic')

function bubbleRecovery () {
  const version = '1.21.11'
  const task = (x, y, name, properties = {}) => ({ id: `${x},${y},0`, type: 'place', pos: new Vec3(x, y, 0), name, state: resolveState(name, properties, version).stateId })
  const tasks = [task(0, 63, 'soul_sand'), task(0, 64, 'bubble_column', { drag: false }), task(0, 65, 'bubble_column', { drag: false }), task(1, 65, 'water', { level: 0 })]
  const plan = { name: 'bubble recovery', version, origin: { x: 0, y: 63, z: 0 }, tasks, layers: [63, 64, 65] }
  const options = { host: '127.0.0.1', port: 25566 }
  const stage = {
    id: 'aux:fluid-staging:0,65,0',
    type: 'place',
    name: 'dirt',
    pos: new Vec3(0, 65, 0),
    state: resolveState('dirt', {}, version).stateId,
    scaffold: true,
    persistent: true,
    purpose: 'fluid-staging',
    targetId: '0,65,0',
    dependentIds: ['1,65,0'],
    releaseLayer: 65
  }
  const report = { identity: buildIdentity(plan, options), currentLayer: 65, layers: [{ y: 63 }, { y: 64 }], constructionPlan: { version: 1, startLayer: 63, tasks: [], fluidStaging: [stage] }, persistentOwned: [stage] }
  return { plan, options, stage, report }
}

test('recovery validates bubble-column staging against active source-water replacements', () => {
  const fixture = bubbleRecovery()
  const recovered = parseRecovery(fixture.report, [], fixture)
  assert.equal(recovered.persistentOwned[0].targetId, fixture.stage.targetId)
  assert.deepEqual(recovered.completedLayers, [63, 64])
})

test('recovery accepts generated bubble targets among the staged dependents', () => {
  const fixture = bubbleRecovery()
  const source = fixture.plan.tasks.find(task => task.id === '1,65,0')
  source.name = 'bubble_column'
  source.state = resolveState('bubble_column', { drag: false }, fixture.plan.version).stateId
  fixture.plan.tasks.push(
    { ...source, id: '1,63,0', pos: new Vec3(1, 63, 0), name: 'soul_sand', state: resolveState('soul_sand', {}, fixture.plan.version).stateId },
    { ...source, id: '1,64,0', pos: new Vec3(1, 64, 0) }
  )
  fixture.report.identity = buildIdentity(fixture.plan, fixture.options)
  assert.equal(parseRecovery(fixture.report, [], fixture).persistentOwned[0].dependentIds[0], source.id)
})

test('recovery preserves the original bubble state in its blueprint identity', () => {
  const fixture = bubbleRecovery()
  const changed = { ...fixture.plan, tasks: fixture.plan.tasks.map(task => task.name === 'bubble_column' ? { ...task, state: resolveState('bubble_column', { drag: true }, fixture.plan.version).stateId } : task) }
  assert.notEqual(buildIdentity(changed, fixture.options).blueprintHash, fixture.report.identity.blueprintHash)
  assert.throws(() => parseRecovery(fixture.report, [], { ...fixture, plan: changed }), /Recovery identity differs/)
})

test('recovery still rejects staging with a non-water dependent target', () => {
  const fixture = bubbleRecovery()
  fixture.stage.dependentIds = ['0,63,0']
  assert.throws(() => parseRecovery(fixture.report, [], fixture), /Invalid fluid staging support audit/)
})

test('recovery rejects staged dependents that are naturally flowing water', () => {
  const fixture = bubbleRecovery()
  fixture.plan.tasks.find(task => task.id === '1,65,0').state = resolveState('water', { level: 1 }, fixture.plan.version).stateId
  fixture.report.identity = buildIdentity(fixture.plan, fixture.options)
  assert.throws(() => parseRecovery(fixture.report, [], fixture), /Invalid fluid staging support audit/)
})
