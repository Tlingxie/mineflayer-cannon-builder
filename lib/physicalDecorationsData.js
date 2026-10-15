const { isDeepStrictEqual } = require('node:util')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')

const DECORATIONS = new Set(['armor_stand', 'item_frame', 'glow_item_frame', 'painting'])
const MINECARTS = new Set(['minecart', 'chest_minecart', 'hopper_minecart'])
const AXES = ['x', 'y', 'z']
const EQUIPMENT = ['feet', 'legs', 'chest', 'head', 'mainhand', 'offhand']
const DEFAULT_POSE = {
  Head: [0, 0, 0],
  Body: [0, 0, 0],
  LeftArm: [-10, 0, -10],
  RightArm: [-15, 0, 10],
  LeftLeg: [-1, 0, -1],
  RightLeg: [1, 0, 1]
}
const COMMON_FLAGS = ['NoGravity', 'Invisible', 'Invulnerable', 'Silent', 'Glowing', 'HasVisualFire']
const STAND_FLAGS = ['Small', 'ShowArms', 'NoBasePlate', 'Marker']
const TRANSIENT_FIELDS = new Set([
  'UUID', 'UUIDMost', 'UUIDLeast', 'Motion', 'Air', 'OnGround', 'FallDistance', 'Fire', 'PortalCooldown',
  'HurtByTimestamp', 'HurtTime', 'DeathTime', 'Health', 'AbsorptionAmount', 'FallFlying', 'Attributes',
  'attributes', 'Brain', 'PersistenceRequired', 'TicksFrozen', 'fall_distance', 'DataVersion', 'fabric:attachments', 'data'
])

function object (value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function vector (value, length, label, integers = false) {
  if (!Array.isArray(value) || value.length !== length || !value.every(n => Number.isFinite(n) && (!integers || Number.isSafeInteger(n)))) throw new Error(`Invalid ${label}`)
  return [...value]
}

function flag (value, label) {
  if (value === undefined) return false
  if (![false, true, 0, 1].includes(value)) throw new Error(`Invalid decoration flag ${label}`)
  return Boolean(value)
}

function item (raw, version) {
  if (raw === undefined || raw === null) return null
  object(raw, 'Decoration item')
  if (!Object.keys(raw).length) return null
  for (const field of Object.keys(raw)) {
    if (!['id', 'count', 'Count', 'components', 'tag', 'Damage'].includes(field)) throw new Error(`Unsupported decoration item field: ${field}`)
  }
  if (typeof raw.id !== 'string' || !/^minecraft:[a-z0-9_]+$/.test(raw.id)) throw new Error(`Unsupported decoration item id: ${raw.id}`)
  if (raw.count !== undefined && raw.Count !== undefined && raw.count !== raw.Count) throw new Error('Conflicting decoration item count fields')
  const count = raw.count ?? raw.Count ?? 1
  if (raw.id === 'minecraft:air' && count === 0 && Object.keys(raw).every(k => ['id', 'count', 'Count'].includes(k))) return null
  const definition = require('minecraft-data')(version).itemsByName[raw.id.slice(10)]
  if (!definition) throw new Error(`Unsupported decoration item in ${version}: ${raw.id}`)
  if (!Number.isInteger(count) || count < 1 || count > definition.stackSize) throw new Error(`Invalid decoration stack size for ${raw.id}: ${count}`)
  const components = { ...(raw.components === undefined ? {} : object(raw.components, 'Decoration item components')) }
  const legacy = { ...(raw.tag === undefined ? {} : object(raw.tag, 'Decoration item tag')) }
  if (raw.Damage !== undefined) {
    if (legacy.Damage !== undefined && legacy.Damage !== raw.Damage) throw new Error('Conflicting decoration item Damage fields')
    legacy.Damage = raw.Damage
  }
  for (const [key, value] of Object.entries(legacy)) {
    const mapped = { Damage: 'minecraft:damage', RepairCost: 'minecraft:repair_cost' }[key]
    if (!mapped) throw new Error(`Unsupported legacy decoration item tag: ${key}`)
    if (components[mapped] !== undefined && components[mapped] !== value) throw new Error(`Conflicting decoration item component: ${mapped}`)
    components[mapped] = value
  }
  for (const [key, value] of Object.entries(components)) {
    if (!['minecraft:damage', 'minecraft:repair_cost'].includes(key)) throw new Error(`Unsupported decoration item component: ${key}`)
    if (!Number.isInteger(value) || value < 0 || value > 2147483647) throw new Error(`Invalid decoration item component: ${key}`)
    if (key === 'minecraft:damage' && (!definition.maxDurability || value >= definition.maxDurability)) throw new Error(`Invalid decoration item durability: ${raw.id}`)
  }
  return { id: raw.id, count, ...(Object.keys(components).length ? { components } : {}) }
}

function comparableItem (value) {
  if (!value) return null
  const components = Object.fromEntries(Object.entries(value.components || {}).filter(([, n]) => n !== 0))
  return { id: value.id, count: value.count, ...(Object.keys(components).length ? { components } : {}) }
}

function equipment (data, version) {
  const result = Object.fromEntries(EQUIPMENT.map(slot => [slot, null]))
  const supplied = new Set()
  const add = (slot, value) => {
    const stack = item(value, version)
    if (supplied.has(slot) && !isDeepStrictEqual(comparableItem(result[slot]), comparableItem(stack))) throw new Error(`Conflicting decoration equipment: ${slot}`)
    result[slot] = stack
    supplied.add(slot)
  }
  if (data.equipment !== undefined) {
    for (const [slot, value] of Object.entries(object(data.equipment, 'Decoration equipment'))) {
      if (!EQUIPMENT.includes(slot)) throw new Error(`Unsupported decoration equipment slot: ${slot}`)
      add(slot, value)
    }
  }
  for (const [field, slots] of [['ArmorItems', EQUIPMENT.slice(0, 4)], ['HandItems', EQUIPMENT.slice(4)]]) {
    if (data[field] === undefined) continue
    if (!Array.isArray(data[field]) || data[field].length !== slots.length) throw new Error(`Invalid decoration ${field}`)
    data[field].forEach((value, i) => add(slots[i], value))
  }
  return result
}

function pose (value = {}) {
  object(value, 'Decoration Pose')
  for (const part of Object.keys(value)) if (!(part in DEFAULT_POSE)) throw new Error(`Unsupported decoration Pose part: ${part}`)
  return Object.fromEntries(Object.entries(DEFAULT_POSE).map(([part, defaults]) => [part, vector(value[part] ?? defaults, 3, `decoration Pose.${part}`)]))
}

function rejectCustomization (data, name) {
  const common = ['id', 'Pos', 'Rotation', ...COMMON_FLAGS, 'CustomName', 'CustomNameVisible', 'Passengers', 'Tags']
  const specific = name === 'armor_stand'
    ? [...STAND_FLAGS, 'DisabledSlots', 'Pose', 'ArmorItems', 'HandItems', 'equipment', 'ArmorDropChances', 'HandDropChances', 'drop_chances']
    : ['TileX', 'TileY', 'TileZ', 'block_pos', ...(name === 'painting' ? ['facing', 'Facing', 'variant', 'Motive'] : ['Facing', 'Item', 'ItemRotation', 'ItemDropChance', 'Fixed'])]
  const allowed = new Set([...common, ...specific, ...TRANSIENT_FIELDS])
  for (const field of Object.keys(data)) if (!allowed.has(field)) throw new Error(`Unsupported decoration entity field: ${field}`)
  if (data.CustomName || data.CustomNameVisible || data.Passengers?.length || data.Tags?.length) throw new Error('Unsupported decoration customization: CustomName, Passengers or Tags')
  if (Object.keys(data['fabric:attachments'] || {}).length) throw new Error('Unsupported decoration fabric attachments')
  if (Object.keys(data.Brain?.memories || {}).length) throw new Error('Unsupported decoration Brain memories')
  if (data.data !== undefined && Object.keys(object(data.data, 'Decoration custom data')).length) throw new Error('Unsupported decoration custom data')
}

function normalized (data, name, version) {
  rejectCustomization(data, name)
  const flags = Object.fromEntries([...COMMON_FLAGS, ...(name === 'armor_stand' ? STAND_FLAGS : name === 'painting' ? [] : ['Fixed'])].map(key => [key, flag(data[key], key)]))
  if (name === 'armor_stand') {
    const disabled = data.DisabledSlots ?? 0
    if (!Number.isInteger(disabled) || disabled < 0 || disabled > 2147483647) throw new Error('Invalid decoration DisabledSlots')
    flags.DisabledSlots = disabled
    return { flags, equipment: equipment(data, version), pose: pose(data.Pose), facing: null, item: null, variant: null, itemRotation: 0 }
  }
  if (name === 'painting') {
    const facing = data.facing ?? data.Facing ?? 0
    if (!Number.isInteger(facing) || facing < 0 || facing > 3) throw new Error(`Invalid painting facing: ${facing}`)
    const variant = data.variant ?? data.Motive
    if (typeof variant !== 'string' || !/^minecraft:[a-z0-9_]+$/.test(variant)) throw new Error(`Invalid painting variant: ${variant}`)
    return { flags, facing, variant, equipment: null, pose: null, item: null, itemRotation: 0 }
  }
  const facing = data.Facing
  if (!Number.isInteger(facing) || facing < 0 || facing > 5) throw new Error(`Invalid item frame facing: ${facing}`)
  const itemRotation = data.ItemRotation ?? 0
  if (!Number.isInteger(itemRotation) || itemRotation < 0 || itemRotation > 7) throw new Error('Invalid decoration ItemRotation')
  const itemDropChance = data.ItemDropChance ?? 1
  if (!Number.isFinite(itemDropChance) || itemDropChance < 0 || itemDropChance > 1) throw new Error('Invalid decoration ItemDropChance')
  return { flags, facing, itemRotation, itemDropChance, item: item(data.Item, version), equipment: null, pose: null, variant: null }
}

function defaultRotation (name, facing) {
  if (name === 'armor_stand') return [0, 0]
  if (name === 'painting') return [[0, 0], [90, 0], [180, 0], [270, 0]][facing]
  return [[0, 90], [0, -90], [180, 0], [0, 0], [90, 0], [270, 0]][facing]
}

function hangingAnchor (data) {
  const modern = data.block_pos === undefined ? null : vector(data.block_pos, 3, 'decoration block_pos', true)
  const oldFields = ['TileX', 'TileY', 'TileZ']
  const legacy = oldFields.some(k => data[k] !== undefined) ? vector(oldFields.map(k => data[k]), 3, 'decoration Tile coordinates', true) : null
  if (modern && legacy && !isDeepStrictEqual(modern, legacy)) throw new Error('Conflicting decoration block_pos and Tile coordinates')
  return modern || legacy || data.Pos.map(Math.floor)
}

function normalizeDecorationEntities (plan) {
  const version = plan.version || '1.21.11'
  const origin = plan.origin || { x: 0, y: 0, z: 0 }
  const sourceMin = plan.sourceMin || { x: 0, y: 0, z: 0 }
  const result = []
  for (const [index, source] of (plan.entities || []).entries()) {
    const wrapped = !source?.id && Boolean(source?.data)
    const data = wrapped ? source.data : source
    const name = typeof data?.id === 'string' ? data.id.replace(/^minecraft:/, '') : null
    if (MINECARTS.has(name)) continue
    if (!DECORATIONS.has(name)) throw new Error(`Unsupported decoration entity: ${data?.id}`)
    const rawPos = vector(data.Pos, 3, 'decoration Pos')
    if (wrapped && !source.regionPosition) throw new Error('Litematic decoration entity requires regionPosition, not the negative-size region minimum')
    const offset = source.regionPosition || { x: 0, y: 0, z: 0 }
    const shift = values => {
      const transformed = AXES.map((axis, i) => values[i] + offset[axis] - sourceMin[axis] + origin[axis])
      return new Vec3(...vector(transformed, 3, 'decoration coordinate transform'))
    }
    const properties = normalized(data, name, version)
    const rotation = vector(data.Rotation ?? defaultRotation(name, properties.facing), 2, 'decoration Rotation')
    const anchor = name === 'armor_stand' ? null : shift(hangingAnchor(data))
    if (anchor && !AXES.every(axis => Number.isSafeInteger(anchor[axis]))) throw new Error('Decoration block_pos must transform to integers')
    result.push({ id: `entity:${index}:${name}`, name, type: name, version, pos: shift(rawPos), anchor, rotation, ...properties, source: data })
  }
  return result
}

function itemTag (stack) {
  const values = { id: nbt.string(stack.id), count: nbt.int(stack.count) }
  if (stack.components) values.components = nbt.comp(Object.fromEntries(Object.entries(stack.components).map(([key, value]) => [key, nbt.int(value)])))
  return nbt.comp(values)
}

function decorationEntityData (entity) {
  const values = {
    id: nbt.string(`minecraft:${entity.name}`),
    Pos: nbt.list(nbt.double(AXES.map(axis => entity.pos[axis]))),
    Rotation: nbt.list(nbt.float(entity.rotation)),
    ...Object.fromEntries(Object.entries(entity.flags).map(([key, value]) => [key, key === 'DisabledSlots' ? nbt.int(value) : nbt.byte(Number(value))]))
  }
  if (entity.name === 'armor_stand') {
    values.equipment = nbt.comp(Object.fromEntries(Object.entries(entity.equipment).filter(([, value]) => value).map(([key, value]) => [key, itemTag(value)])))
    values.Pose = nbt.comp(Object.fromEntries(Object.entries(entity.pose).map(([key, value]) => [key, nbt.list(nbt.float(value))])))
  } else {
    values.block_pos = nbt.intArray(AXES.map(axis => entity.anchor[axis]))
    if (entity.name === 'painting') {
      values.facing = nbt.byte(entity.facing)
      values.variant = nbt.string(entity.variant)
    } else {
      values.Facing = nbt.byte(entity.facing)
      values.ItemRotation = nbt.byte(entity.itemRotation)
      values.ItemDropChance = nbt.float(entity.itemDropChance)
      if (entity.item) values.Item = itemTag(entity.item)
    }
  }
  return nbt.comp(values)
}

function angleDifference (a, b) {
  return Math.abs(((a - b) % 360 + 540) % 360 - 180)
}

function decorationDifferences (entity, actualPlainNbt) {
  const differences = []
  const actual = actualPlainNbt
  if (!actual || typeof actual !== 'object') return ['Missing decoration entity NBT']
  if (actual.id?.replace(/^minecraft:/, '') !== entity.name) differences.push('Decoration entity type differs')
  if (!Array.isArray(actual.Pos) || actual.Pos.length !== 3 || !actual.Pos.every(Number.isFinite) || entity.pos.distanceTo(new Vec3(...actual.Pos)) > 0.04) differences.push('Decoration Pos differs')
  if (!Array.isArray(actual.Rotation) || actual.Rotation.length !== 2 || !actual.Rotation.every(Number.isFinite) || entity.rotation.some((angle, i) => angleDifference(angle, actual.Rotation[i]) > 0.04)) differences.push('Decoration Rotation differs')
  let properties
  try { properties = normalized(actual, entity.name, entity.version) } catch (error) { return [...differences, error.message] }
  for (const [key, value] of Object.entries(entity.flags)) if (properties.flags[key] !== value) differences.push(`Decoration ${key} differs`)
  if (entity.name === 'armor_stand') {
    for (const slot of EQUIPMENT) if (!isDeepStrictEqual(comparableItem(entity.equipment[slot]), comparableItem(properties.equipment[slot]))) differences.push(`Decoration equipment.${slot} differs`)
    for (const part of Object.keys(DEFAULT_POSE)) if (entity.pose[part].some((angle, i) => angleDifference(angle, properties.pose[part][i]) > 0.04)) differences.push(`Decoration Pose.${part} differs`)
  } else {
    try {
      if (!Array.isArray(actual.Pos) || !isDeepStrictEqual(hangingAnchor(actual), AXES.map(axis => entity.anchor[axis]))) differences.push('Decoration block_pos differs')
    } catch (error) { differences.push(error.message) }
    if (entity.facing !== properties.facing) differences.push('Decoration facing differs')
    if (entity.name === 'painting') {
      if (entity.variant !== properties.variant) differences.push('Decoration painting variant differs')
    } else {
      if (!isDeepStrictEqual(comparableItem(entity.item), comparableItem(properties.item))) differences.push('Decoration Item differs')
      if (entity.itemRotation !== properties.itemRotation) differences.push('Decoration ItemRotation differs')
      if (Math.abs(entity.itemDropChance - properties.itemDropChance) > 0.00001) differences.push('Decoration ItemDropChance differs')
    }
  }
  return differences
}

module.exports = { normalizeDecorationEntities, decorationEntityData, decorationDifferences }
