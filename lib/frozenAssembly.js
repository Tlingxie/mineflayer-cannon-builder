const { isDeepStrictEqual } = require('node:util')
const { isContainerTask, normalizeItems } = require('./physicalInventory')
const { normalizeMinecartEntities } = require('./physicalMechanisms')
const { preparePhysicalPlan } = require('./strictSchematic')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CART_TOLERANCE = 0.8

function check (signal) {
  if (signal?.aborted) throw Object.assign(new Error('Frozen assembly verification cancelled'), { name: 'AbortError' })
}

function inspectAudit (plan, audit) {
  if (!plan?.version || !Array.isArray(plan.tasks) || !plan.tasks.length || !Array.isArray(plan.air)) throw new Error('The original decoded blueprint is required')
  if (plan.derived?.length) throw new Error('The original blueprint is required, not the physical-only plan')
  if (!audit || audit.backend !== 'saved-region-files' || audit.version !== plan.version || audit.completeBlueprint !== true ||
      audit.checkedBlocks !== plan.tasks.length || audit.checkedAir !== plan.air.length) throw new Error('World audit must cover the complete original blueprint and every air target at the same version')
  for (const field of ['mismatches', 'activeMismatches', 'derivedPending', 'occupiedAir', 'runtimeStateDifferences', 'regions']) {
    if (!Array.isArray(audit[field])) throw new Error(`Incomplete world audit: ${field}`)
  }
  if (audit.activeMismatches.length) throw new Error('World audit contains active block mismatches')
  if (audit.occupiedAir.length) throw new Error('World audit contains occupied air targets')
  const tasks = new Map(plan.tasks.map(task => [task.id, task]))
  if (tasks.size !== plan.tasks.length) throw new Error('Original blueprint contains duplicate block target IDs')
  const derived = new Set(preparePhysicalPlan(plan).derived.map(task => task.id))
  const Block = require('prismarine-block')(plan.version)
  const seen = new Set()
  const pending = []
  for (const item of audit.mismatches) {
    const task = tasks.get(item.id)
    if (!task || seen.has(item.id)) throw new Error(`Invalid or repeated world audit mismatch: ${item.id}`)
    seen.add(item.id)
    const wanted = Block.fromStateId(task.state, 0)
    const properties = wanted.getProperties()
    if (wanted.name !== item.wanted || !isDeepStrictEqual(properties, item.wantedProperties)) throw new Error(`World audit mismatch describes a different target: ${item.id}`)
    if (!derived.has(item.id)) throw new Error(`World audit contains an unreported active mismatch: ${item.id}`)
    let reason
    if (wanted.name === 'water' && Number(properties.level) !== 0) {
      const level = item.actualProperties?.level
      const validLevel = (typeof level === 'number' || (typeof level === 'string' && /^\d+$/.test(level))) && Number.isInteger(Number(level)) && Number(level) >= 0 && Number(level) <= 15
      if (AIR.has(item.actual) || (item.actual === 'water' && validLevel && Number(level) !== Number(properties.level))) reason = 'pending-natural-water-flow'
    } else if (wanted.name === 'piston_head' && AIR.has(item.actual)) reason = 'pending-natural-piston-extension'
    if (!reason) throw new Error(`World audit mismatch is not an allowed natural pending target: ${item.id} (${wanted.name} -> ${item.actual})`)
    pending.push({ kind: 'block', id: task.id, pos: { ...task.pos }, name: wanted.name, expectedProperties: properties, actual: item.actual, actualProperties: item.actualProperties, reason })
  }
  const reported = audit.derivedPending.map(item => item.id)
  if (new Set(reported).size !== reported.length || reported.length !== seen.size || reported.some(id => !seen.has(id))) throw new Error('World audit derived mismatch records are inconsistent')
  return pending
}

function inspectSourceInventories (plan) {
  const containers = []
  for (const task of plan.tasks) {
    const knownContainer = isContainerTask({ ...task, blockEntity: { Items: [] } })
    if (knownContainer || Object.hasOwn(task.blockEntity || {}, 'Items')) {
      if (!Array.isArray(task.blockEntity?.Items)) throw new Error(`Invalid source container Items: ${task.id}`)
      if (isContainerTask(task)) {
        normalizeItems(task.blockEntity.Items, plan.version)
        containers.push(task)
      }
    }
  }
  for (const source of plan.entities || []) {
    const data = source.data
    if (!data || (data.Items !== undefined && (!Array.isArray(data.Items) || data.Items.length))) throw new Error('Nonempty or malformed source minecart Items are unsupported')
    if (data.Enabled !== undefined && ![0, 1, false, true].includes(data.Enabled)) throw new Error('Invalid source minecart Enabled value')
  }
  return { containers, minecarts: normalizeMinecartEntities(plan) }
}

function inspectTickState (state) {
  if (state?.frozen !== true) throw new Error('Frozen assembly requires frozen ticks')
  if (state.quiescent !== true) throw new Error('Frozen assembly requires quiescent ticks')
  if (!Number.isSafeInteger(state.gameTime) || state.gameTime < 0) throw new Error('Invalid frozen assembly gametime')
}

function inspectMinecart (expected, observed, claimed) {
  if (observed?.name !== expected.name || observed.typeSource !== 'server-selector' ||
      (observed.data?.id !== undefined && observed.data.id !== `minecraft:${expected.name}`)) throw new Error(`Minecart type differs from ${expected.id}`)
  const axes = ['x', 'y', 'z']
  if (!axes.every(axis => Number.isFinite(observed.pos?.[axis]))) throw new Error(`Invalid minecart position: ${expected.id}`)
  const distance = Math.hypot(...axes.map(axis => observed.pos[axis] - expected.pos[axis]))
  if (distance > CART_TOLERANCE + 1e-9) throw new Error(`Minecart position exceeds ${CART_TOLERANCE} tolerance: ${expected.id}`)
  if (typeof observed.uuid !== 'string' || !UUID.test(observed.uuid)) throw new Error(`Invalid minecart UUID: ${expected.id}`)
  const uuid = observed.uuid.toLowerCase()
  if (claimed.has(uuid)) throw new Error(`The same UUID matched more than one minecart target: ${expected.id}`)
  claimed.add(uuid)
  const items = observed.data?.Items
  if (!Array.isArray(observed.entries) || observed.entries.length ||
      (expected.name === 'minecart' && items === undefined ? false : !Array.isArray(items) || items.length > 0)) throw new Error(`Minecart Items are not empty: ${expected.id}`)
  const pendingActivation = expected.name === 'hopper_minecart' && expected.rail.name === 'activator_rail' && expected.expectedEnabled === false && observed.enabled === true
  if (expected.expectedEnabled !== undefined && observed.enabled !== expected.expectedEnabled && !pendingActivation) throw new Error(`Minecart Enabled differs from ${expected.id}`)
  return {
    id: expected.id,
    name: observed.name,
    uuid,
    expectedPos: { ...expected.pos },
    pos: { ...observed.pos },
    distance,
    positionTolerance: CART_TOLERANCE,
    emptyItemsVerified: true,
    expectedEnabled: expected.expectedEnabled,
    actualEnabled: observed.enabled,
    ...(pendingActivation ? { reason: 'pending-natural-activation' } : {})
  }
}

async function verifyFrozenAssembly ({ plan, worldAudit, snapshot, signal }) {
  check(signal)
  const naturalPending = inspectAudit(plan, worldAudit)
  const expected = inspectSourceInventories(plan)
  if (snapshot?.version !== plan.version || !['readTickState', 'verifyContainer', 'readMinecart'].every(name => typeof snapshot[name] === 'function')) throw new Error('A matching read-only server snapshot is required')
  const evidence = []
  const append = result => {
    if (result?.evidence) evidence.push(...(Array.isArray(result.evidence) ? result.evidence : [result.evidence]))
  }
  try {
    const before = await snapshot.readTickState({ signal })
    append(before)
    check(signal)
    inspectTickState(before)
    const containers = []
    for (const task of expected.containers) {
      check(signal)
      const observed = await snapshot.verifyContainer(task, { signal })
      append(observed)
      check(signal)
      if (observed?.verified !== true) throw new Error(`Strict container verification did not succeed: ${task.id}`)
      containers.push({ id: task.id, name: task.name, pos: { ...task.pos }, mode: 'exact-slots', verified: true, slots: observed.slots, items: observed.items })
    }
    const claimed = new Set()
    const minecarts = []
    for (const entity of expected.minecarts) {
      check(signal)
      const observed = await snapshot.readMinecart(entity, { signal })
      append(observed)
      check(signal)
      const match = inspectMinecart(entity, observed, claimed)
      minecarts.push(match)
      if (match.reason) naturalPending.push({ kind: 'entity', ...match })
    }
    const after = await snapshot.readTickState({ signal })
    append(after)
    check(signal)
    inspectTickState(after)
    if (before.gameTime !== after.gameTime) throw new Error('Frozen assembly gametime changed during verification')
    return {
      version: plan.version,
      checkedAt: new Date().toISOString(),
      activeAssemblyVerified: true,
      completeBlueprintVerified: naturalPending.length === 0,
      strictContainersVerified: containers.length,
      minecartsVerified: minecarts.length,
      naturalPending,
      containers,
      minecarts,
      tickState: { before, after, gameTime: after.gameTime, unchanged: true },
      worldAudit,
      evidence
    }
  } catch (error) {
    if (error.evidence) for (const item of error.evidence) if (!evidence.includes(item)) evidence.push(item)
    error.evidence = evidence
    throw error
  }
}

module.exports = { verifyFrozenAssembly }
