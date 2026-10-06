const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { Vec3 } = require('vec3')
const { resolveState } = require('../lib/strictSchematic')

const implementation = () => require('../scripts/audit-construction-order')
const hash = '8c2d8bf4dc8059cb083a28368da2efa1be2bd2dd4999d8b8062d115c4c758632'
const origin = { x: 101, y: -5, z: 102 }
const schematicOrigin = { x: 128, y: 0, z: 128 }

function fixture () {
  const layers = Array.from({ length: 51 }, (_, index) => index - 5)
  const stone = resolveState('stone', {}, '1.21.4').stateId
  const active = layers.flatMap(y => Array.from({ length: y === 45 ? 245 : 236 }, (_, index) => ({ id: `${101 + index % 50},${y},${102 + Math.floor(index / 50)}`, pos: { x: 101 + index % 50, y, z: 102 + Math.floor(index / 50) }, state: stone, name: 'stone' })))
  const identity = { server: { host: '127.0.0.1', port: 25567 }, version: '1.21.4', origin, target: '/source.litematic', blueprintHash: 'b'.repeat(64) }
  const serverIdentity = { host: '127.0.0.1', port: 25567, version: '1.21.4', pid: 99527, startedAt: '2026-10-04T01:17:11.777Z', directory: '/owned/new', gameTime: 38835 }
  let time = Date.parse(serverIdentity.startedAt) + 100
  const event = (type, extra) => ({ time: time++, type, ...extra })
  const tasks = Array.from({ length: 55 }, (_, index) => ({ id: `foundation:161,${index - 60},125`, pos: { x: 161, y: index - 60, z: 125 }, name: 'dirt', type: 'place' }))
  const foundationEvents = tasks.flatMap(task => [event('layer-start', { layer: task.pos.y }), event('placement-attempt', { workerId: 'foundation128', taskPos: task.pos, activeLayer: task.pos.y }), event('layer-complete', { layer: task.pos.y })])
  const foundation = { report: { status: 'complete', serverIdentity, schematicOrigin, placementAttempts: 55, foundation: { tasks }, layers: tasks.map(task => task.pos.y) }, events: foundationEvents }
  const events = []
  for (let index = 0; index < 30; index++) {
    const workerId = `aligned${String(index).padStart(2, '0')}`
    events.push(event('operator-grant-complete', { workerId, verified: true, evidence: { pid: serverIdentity.pid, startedAt: serverIdentity.startedAt } }), event('stage-start', { workerId }))
  }
  const rows = []
  for (const layer of layers) {
    const targets = active.filter(task => task.pos.y === layer)
    events.push(event('layer-start', { phase: 'layer', layer, layerTotal: targets.length }))
    for (let index = 0; index < 30; index++) events.push(event('task-start', { workerId: `aligned${String(index).padStart(2, '0')}`, taskId: targets[index].id, phase: 'targets', layer }))
    events.push(event('placement-attempt', { workerId: 'aligned00', activeLayer: layer, taskPos: targets[0].pos, useItem: false }))
    for (let index = 0; index < 30; index++) events.push(event('task-complete', { workerId: `aligned${String(index).padStart(2, '0')}`, taskId: targets[index].id, phase: 'targets', layer }))
    events.push(event('layer-complete', { phase: 'layer', layer, layerTotal: targets.length, activeWorkers: 0 }))
    rows.push({ y: layer, blocks: targets.length })
  }
  const report = { identity, origin, schematicOrigin, connectedBots: 30, peakActiveWorkers: 30, layers: rows, completed: 12045, status: 'failed', error: 'Frozen cart Enabled differs', runDir: '/new-run' }
  const source = { sha256: hash, identity, active, layers }
  return { foundation, runs: [{ directory: '/new-run', report, events, finalReport: true }], source }
}

test('complete recorded construction order is independent of a later assembly failure', () => {
  const { auditRecords } = implementation()
  const result = auditRecords(fixture())
  assert.equal(result.orderComplete, true)
  assert.equal(result.assemblyVerified, null)
  assert.equal(result.main.activeTargetsVerified, 12045)
  assert.equal(result.main.completedLayers.length, 51)
  assert.equal(result.workers.observedPeak, 30)
  assert.equal(result.runs[0].status, 'failed')
})

test('cross-layer packet, missing barrier and interleaved old branch cannot pass', () => {
  const { auditRecords } = implementation()
  for (const damage of ['wrong-y', 'missing-barrier', 'old-process', 'source']) {
    const data = fixture()
    if (damage === 'wrong-y') data.runs[0].events.find(event => event.type === 'placement-attempt').taskPos = { x: 101, y: -4, z: 102 }
    if (damage === 'missing-barrier') data.runs[0].events = data.runs[0].events.filter(event => !(event.type === 'layer-complete' && event.layer === -5))
    if (damage === 'old-process') data.runs[0].events[0].evidence.pid = 86758
    if (damage === 'source') data.source.sha256 = 'c'.repeat(64)
    const result = auditRecords(data)
    assert.equal(result.orderComplete, false, damage)
    assert.equal(result.validSoFar, false, damage)
  }
})

test('partial in-progress logs are incomplete instead of fabricated completion', () => {
  const { auditRecords } = implementation()
  const data = fixture()
  const end = data.runs[0].events.findIndex(event => event.type === 'layer-complete' && event.layer === -5)
  data.runs[0].events = data.runs[0].events.slice(0, end + 1)
  data.runs[0].report.layers = data.runs[0].report.layers.slice(0, 1)
  data.runs[0].report.completed = 236
  data.runs[0].report.status = 'building'
  data.runs[0].finalReport = false
  const result = auditRecords(data)
  assert.equal(result.validSoFar, true)
  assert.equal(result.orderComplete, false)
  assert.equal(result.status, 'incomplete')
})

test('drained verification retries have no worker ownership until their next dispatch', () => {
  const data = fixture()
  const events = data.runs[0].events
  const index = events.findIndex(event => event.type === 'layer-complete')
  events.splice(index, 0, { time: events[index].time, type: 'task-retry', reason: 'verification', layer: -5, taskId: data.source.active[0].id })
  assert.equal(implementation().auditRecords(data).orderComplete, true)
})

test('explicit same-world resume preserves earlier barriers without counting readonly checks as placements', () => {
  const data = fixture()
  const first = data.runs[0]
  const events = first.events
  const boundary = events.findIndex(event => event.type === 'layer-complete' && event.layer === -5)
  const second = structuredClone(first)
  second.directory = '/continued-run'
  second.report.runDir = second.directory
  second.report.recovery = { sourceDir: first.directory }
  second.report.resumedReadOnlyBlocks = 236
  const connectionEvents = structuredClone(events.slice(0, 60))
  const time = events[boundary].time + 1
  second.events = [...connectionEvents.map(event => ({ ...event, time })), { time, type: 'resume-layer-verified', phase: 'layer', layer: -5, layerTotal: 236 }, ...events.slice(boundary + 1)]
  first.events = events.slice(0, boundary + 1)
  first.report.layers = first.report.layers.slice(0, 1)
  first.report.completed = 236
  data.runs.push(second)
  const result = implementation().auditRecords(data)
  assert.equal(result.orderComplete, true, JSON.stringify(result.issues))
  assert.equal(result.main.placementAttempts, 51)
  assert.equal(result.runs[1].resumedReadOnlyBlocks, 236)
  second.report.recovery.sourceDir = '/discarded-branch'
  assert.equal(implementation().auditRecords(data).validSoFar, false)
})

function withFluid () {
  const data = fixture()
  const target = data.source.active[0]
  target.state = resolveState('water', { level: '0' }, '1.21.4').stateId
  target.name = 'water'
  const pos = new Vec3(target.pos.x, target.pos.y, target.pos.z)
  const reference = pos.offset(0, -1, 0)
  const blocks = [{ pos: pos.offset(0, 1, 0), stateId: 0 }, { pos, stateId: 0 }, { pos: reference, stateId: resolveState('stone', {}, '1.21.4').stateId }]
  const tick = { frozen: true, quiescent: true, gameTime: 38835 }
  const fence = { verified: true, checked: blocks.length, gameTime: 38835, blocks, tickState: { before: tick, after: tick }, evidence: [{ command: implementation().blockStateCommand(blocks), response: 'The time is 38835', backend: 'clone-rcon' }] }
  const payload = { workerId: 'aligned00', target: pos, reference, face: 1, eye: pos.offset(0.5, 1.62, 0.5), yaw: 0, pitch: -Math.PI / 2, blocks, fence }
  const index = data.runs[0].events.findIndex(event => event.type === 'placement-attempt')
  const placement = data.runs[0].events[index]
  placement.useItem = true
  placement.referencePos = reference
  placement.face = 1
  const time = placement.time
  data.runs[0].events.splice(index, 1,
    { time, type: 'physical-mutation', phase: 'fluid-fenced', ...payload }, placement,
    { time, type: 'physical-mutation', phase: 'fluid-dispatched', ...payload },
    { time, type: 'physical-mutation', phase: 'fluid-ack', workerId: payload.workerId, target: pos, rawACK: { pos, stateId: target.state, sequence: 5 } })
  return data
}

test('bucket audit requires matching atomic ray proof and one fresh raw state/sequence ACK', () => {
  const { auditRecords } = implementation()
  const valid = auditRecords(withFluid())
  assert.equal(valid.orderComplete, true, JSON.stringify(valid.issues))
  assert.deepEqual([valid.fluids.dispatched, valid.fluids.confirmed], [1, 1])
  for (const damage of ['no-ack', 'wrong-state', 'bad-proof', 'interleaved-placement', 'wrong-face', 'missing-ray-cell']) {
    const data = withFluid()
    const events = data.runs[0].events
    if (damage === 'no-ack') data.runs[0].events = events.filter(event => event.phase !== 'fluid-ack')
    if (damage === 'wrong-state') events.find(event => event.phase === 'fluid-ack').rawACK.stateId = 0
    if (damage === 'bad-proof') events.find(event => event.phase === 'fluid-fenced').fence.evidence[0].response = 'Test failed'
    if (damage === 'wrong-face') {
      for (const event of events.filter(event => ['fluid-fenced', 'fluid-dispatched'].includes(event.phase) || event.type === 'placement-attempt')) event.face = 2
    }
    if (damage === 'missing-ray-cell') {
      const proof = events.find(event => event.phase === 'fluid-fenced')
      proof.blocks.shift()
      proof.fence.checked--
      proof.fence.evidence[0].command = implementation().blockStateCommand(proof.blocks)
    }
    if (damage === 'interleaved-placement') {
      const index = events.findIndex(event => event.phase === 'fluid-ack')
      events.splice(index, 0, { time: events[index].time, type: 'placement-attempt', workerId: 'aligned01', activeLayer: -5, taskPos: { x: 102, y: -5, z: 102 } })
    }
    const result = auditRecords(data)
    assert.equal(result.orderComplete, false, damage)
    assert.equal(result.validSoFar, false, damage)
  }
})

test('a recorded bucket intent cannot pass when its entire mutation evidence chain is missing', () => {
  const data = withFluid()
  data.runs[0].events = data.runs[0].events.filter(event => event.type !== 'physical-mutation')
  const result = implementation().auditRecords(data)
  assert.equal(result.orderComplete, false)
  assert.equal(result.validSoFar, false)
  assert.ok(result.issues.some(row => row.code === 'unproven-fluid-intent-at-layer-completion'))
})

test('foundation must contain its actual fifty-five ascending placements and completions', () => {
  const { auditRecords } = implementation()
  const data = fixture()
  data.foundation.events = data.foundation.events.filter(event => !(event.type === 'placement-attempt' && event.activeLayer === -59))
  assert.equal(auditRecords(data).orderComplete, false)
})

test('audit output creation never overwrites a report or prior result', async t => {
  const { writeAudit } = implementation()
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'order-audit-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'result.json')
  await writeAudit(filename, { orderComplete: false })
  await assert.rejects(writeAudit(filename, { orderComplete: true }), { code: 'EEXIST' })
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).orderComplete, false)
})
