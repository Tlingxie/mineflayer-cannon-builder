const locks = new Map()
const activeBots = new WeakSet()
const CONTAINER_SIZE = { hopper: 5, dispenser: 9, dropper: 9, chest: 27, trapped_chest: 27, barrel: 27, shulker_box: 27 }
const TILE_FIELDS = new Set(['id', 'x', 'y', 'z', 'Pos', 'DataVersion', 'keepPacked', 'OutputSignal', 'TransferCooldown', 'Items', 'components'])

function abortError () {
  const error = new Error('Container operation cancelled')
  error.name = 'AbortError'
  return error
}

function check (bot, signal) {
  if (signal?.aborted) throw abortError()
  if (bot._client?.ended) throw new Error('Bot disconnected during container operation')
}

function bounded (promise, signal, label, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve(value)
    }
    const cancel = () => finish(abortError())
    const timer = setTimeout(() => finish(new Error(`${label} timed out`)), timeout)
    signal?.addEventListener('abort', cancel, { once: true })
    Promise.resolve(promise).then(value => finish(null, value), finish)
    if (signal?.aborted) cancel()
  })
}

function acquire (key, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const queue = locks.get(key) || []
    locks.set(key, queue)
    let released = false
    const grant = () => {
      signal?.removeEventListener('abort', cancel)
      resolve(() => {
        if (released) return
        released = true
        queue.shift()
        if (queue.length) queue[0].grant()
        else locks.delete(key)
      })
    }
    const entry = { grant }
    const cancel = () => {
      const i = queue.indexOf(entry)
      if (i > 0) queue.splice(i, 1)
      reject(abortError())
    }
    queue.push(entry)
    signal?.addEventListener('abort', cancel, { once: true })
    if (queue.length === 1) grant()
  })
}

function normalizeItems (items, version = '1.21.4') {
  if (!Array.isArray(items)) throw new Error('Container Items must be an array')
  const data = require('minecraft-data')(version)
  const Item = require('prismarine-item')(version)
  const slots = new Set()
  return items.map(raw => {
    for (const field of ['components', 'tag']) {
      if (raw[field] !== undefined && (!raw[field] || typeof raw[field] !== 'object' || Array.isArray(raw[field]))) throw new Error(`Item ${field} must be an object`)
    }
    for (const name of Object.keys(raw)) {
      if (!['Slot', 'id', 'count', 'Count', 'components', 'tag', 'Damage'].includes(name)) throw new Error(`Unsupported item field: ${name}`)
    }
    if (!Number.isInteger(raw.Slot) || raw.Slot < 0 || raw.Slot >= 27) throw new Error(`Invalid container slot: ${raw.Slot}`)
    if (slots.has(raw.Slot)) throw new Error(`Duplicate container slot: ${raw.Slot}`)
    slots.add(raw.Slot)
    if (typeof raw.id !== 'string' || !/^minecraft:[a-z0-9_]+$/.test(raw.id)) throw new Error(`Unsupported item id: ${raw.id}`)
    const definition = data.itemsByName[raw.id.slice(10)]
    if (!definition) throw new Error(`Unsupported item in ${version}: ${raw.id}`)
    if (raw.count !== undefined && raw.Count !== undefined && raw.count !== raw.Count) throw new Error('Conflicting item count fields')
    const count = raw.count ?? raw.Count
    if (!Number.isInteger(count) || count < 1 || count > definition.stackSize) throw new Error(`Invalid stack size for ${raw.id}: ${count}`)
    const components = { ...(raw.components || {}) }
    const legacy = { ...(raw.tag || {}) }
    if (raw.Damage !== undefined) legacy.Damage = raw.Damage
    for (const [name, value] of Object.entries(legacy)) {
      const mapped = { Damage: 'minecraft:damage', RepairCost: 'minecraft:repair_cost' }[name]
      if (!mapped) throw new Error(`Unsupported legacy item tag: ${name}`)
      if (components[mapped] !== undefined && components[mapped] !== value) throw new Error(`Conflicting item component: ${mapped}`)
      components[mapped] = value
    }
    const item = new Item(definition.id, count)
    // Modern protocol serializes components; legacy item.nbt would be silently lost.
    item.nbt = null
    item.components = []
    item.removedComponents = []
    item.componentMap = new Map()
    for (const [name, value] of Object.entries(components)) {
      if (!['minecraft:damage', 'minecraft:repair_cost'].includes(name)) throw new Error(`Unsupported item component: ${name}`)
      if (!Number.isInteger(value) || value < 0 || value > 2147483647) throw new Error(`Invalid item component value: ${name}`)
      if (name === 'minecraft:damage' && (!definition.maxDurability || value >= definition.maxDurability)) throw new Error(`Invalid durability for ${raw.id}: ${value}`)
      if (value === 0) continue
      const component = { type: name.slice(10), data: value }
      item.components.push(component)
      item.componentMap.set(component.type, component)
    }
    item.components.sort((a, b) => a.type.localeCompare(b.type))
    return { slot: raw.Slot, item }
  }).sort((a, b) => a.slot - b.slot)
}

function equalItem (a, b) {
  if (!a || !b) return !a && !b
  const components = item => (item.components || [])
    .filter(c => !(['damage', 'repair_cost'].includes(c.type) && c.data === 0))
    .map(c => [c.type, c.data]).sort((a, b) => a[0].localeCompare(b[0]))
  return a.type === b.type && a.count === b.count && a.metadata === b.metadata &&
    JSON.stringify(components(a)) === JSON.stringify(components(b)) &&
    JSON.stringify(a.removedComponents || []) === JSON.stringify(b.removedComponents || [])
}

function propertiesFor (bot, task) {
  if (Number.isInteger(task.state)) return require('prismarine-block')(bot.version).fromStateId(task.state, 0).getProperties()
  return bot.blockAt(task.pos)?.getProperties() || {}
}

function containerKey (bot, task) {
  const props = propertiesFor(bot, task)
  const positions = [task.pos]
  if (['chest', 'trapped_chest'].includes(task.name) && ['left', 'right'].includes(props.type)) {
    const clockwise = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] }[props.facing]
    const direction = props.type === 'left' ? 1 : -1
    positions.push({ x: task.pos.x + clockwise[0] * direction, y: task.pos.y, z: task.pos.z + clockwise[1] * direction })
  }
  return `${bot.game?.dimension || ''}:${positions.map(p => `${p.x},${p.y},${p.z}`).sort()[0]}`
}

function containerOffset (name, properties, size) {
  if (size === 54 && ['chest', 'trapped_chest'].includes(name)) {
    if (!['left', 'right'].includes(properties.type)) throw new Error('Double chest has no known half')
    // Mojang ChestBlock.getBlockType maps RIGHT to FIRST, LEFT to SECOND.
    return properties.type === 'left' ? 27 : 0
  }
  return 0
}

function isContainerTask (task) {
  const items = task.blockEntity?.Items
  return Array.isArray(items) && (items.length > 0 || Boolean(CONTAINER_SIZE[task.name]) || task.name.endsWith('_shulker_box'))
}

function desiredContents (bot, task) {
  const tile = task.blockEntity || {}
  if (tile.components !== undefined && (!tile.components || typeof tile.components !== 'object' || Array.isArray(tile.components))) throw new Error('Block entity components must be an object')
  for (const key of Object.keys(tile)) {
    if (['CookingTimes', 'CookingTotalTimes'].includes(key) &&
        (Array.isArray(tile[key]) || ArrayBuffer.isView(tile[key])) && Array.from(tile[key]).every(n => n === 0)) continue
    if (!TILE_FIELDS.has(key)) throw new Error(`Unsupported block entity field: ${key}`)
  }
  if (tile.components && Object.keys(tile.components).length) throw new Error('Unsupported block entity components')
  if (tile.Items === undefined) return null
  const entries = normalizeItems(tile.Items, bot.version)
  const size = CONTAINER_SIZE[task.name] || (task.name.endsWith('_shulker_box') ? 27 : null)
  if (!entries.length && !size) return null
  if (!size) throw new Error(`Unsupported container: ${task.name}`)
  if (entries.some(e => e.slot >= size)) throw new Error(`Item slot exceeds ${task.name} capacity`)
  const desired = Array(size).fill(null)
  for (const entry of entries) desired[entry.slot] = entry.item
  return { entries, size, desired }
}

function reachableContainer (bot, task) {
  const block = bot.blockAt(task.pos)
  if (!block || block.name !== task.name) throw new Error(`Container block mismatch at ${task.pos}`)
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
  const distance = Math.hypot(...['x', 'y', 'z'].map(k => Math.max(task.pos[k] - eye[k], 0, eye[k] - task.pos[k] - 1)))
  if (distance > 4.5) throw new Error('Container is out of physical reach (4.5 blocks)')
  return block
}

async function openContainer (bot, task, signal) {
  check(bot, signal)
  const pending = bot.openContainer(reachableContainer(bot, task))
  try { return await bounded(pending, signal, 'Open container') } catch (error) {
    pending.then(late => { if (bot.currentWindow === late) late.close() }, () => {})
    throw error
  }
}

function windowOffset (bot, task, window, size) {
  const offset = containerOffset(task.name, reachableContainer(bot, task).getProperties(), window.inventoryStart)
  const capacities = size === 27 && ['chest', 'trapped_chest'].includes(task.name) ? [27, 54] : [size]
  if (!capacities.includes(window.inventoryStart) || offset + size > window.inventoryStart) throw new Error('Unexpected container window shape')
  return offset
}

function verifyWindow (bot, task, window, contents) {
  const offset = windowOffset(bot, task, window, contents.size)
  for (let i = 0; i < contents.size; i++) {
    if (!equalItem(window.slots[offset + i], contents.desired[i])) throw new Error(`Container verification failed at ${task.pos}, slot ${i}; items may be moving`)
  }
  return { verified: true, slots: contents.entries.length, items: contents.entries.reduce((sum, e) => sum + e.item.count, 0) }
}

async function verifyContainer (bot, task, { signal } = {}) {
  check(bot, signal)
  const contents = desiredContents(bot, task)
  if (!contents) return { skipped: true, reason: 'no-container-items' }
  const release = await acquire(containerKey(bot, task), signal)
  let window
  let ownedBot = false
  try {
    check(bot, signal)
    if (activeBots.has(bot) || bot.currentWindow || bot.inventory.selectedItem) throw new Error('Bot already has an inventory operation or cursor item')
    activeBots.add(bot)
    ownedBot = true
    window = await openContainer(bot, task, signal)
    check(bot, signal)
    return verifyWindow(bot, task, window, contents)
  } finally {
    try {
      if (window && bot.currentWindow === window) await bounded(window.close(), null, 'Close container after verification')
    } finally {
      if (ownedBot) activeBots.delete(bot)
      release()
    }
  }
}

async function fillContainer (bot, task, { signal } = {}) {
  check(bot, signal)
  const contents = desiredContents(bot, task)
  if (!contents) return { skipped: true, reason: 'no-container-items' }
  const { size, desired } = contents
  const release = await acquire(containerKey(bot, task), signal)
  let window
  let saved
  let ownedBot = false
  let error
  let result
  try {
    check(bot, signal)
    if (activeBots.has(bot) || bot.currentWindow || bot.inventory.selectedItem) throw new Error('Bot already has an inventory operation or cursor item')
    activeBots.add(bot)
    ownedBot = true
    reachableContainer(bot, task)
    const spareSlot = size < 27 ? 9 + size : 44
    saved = [...Array.from({ length: size }, (_, i) => 9 + i), spareSlot]
      .map(slot => ({ slot, item: bot.inventory.slots[slot] }))
    const setSlot = async (slot, item) => {
      // Item.equal in Mineflayer does not compare modern components.
      if (!equalItem(bot.inventory.slots[slot], item)) {
        if (bot.inventory.slots[slot]) await bounded(bot.creative.setInventorySlot(slot, null), signal, 'Clear inventory staging slot')
        if (item) await bounded(bot.creative.setInventorySlot(slot, item), signal, 'Prepare inventory item')
      }
    }
    for (let i = 0; i < size; i++) {
      check(bot, signal)
      await setSlot(9 + i, desired[i])
    }
    await setSlot(spareSlot, null)
    window = await openContainer(bot, task, signal)
    const offset = windowOffset(bot, task, window, size)
    for (let i = 0; i < size; i++) {
      check(bot, signal)
      const destination = offset + i
      if (equalItem(window.slots[destination], desired[i])) continue
      const source = window.inventoryStart + i
      const spare = window.inventoryStart + spareSlot - 9
      const click = slot => bounded(bot.clickWindow(slot, 0, 0), signal, 'Container click')
      const previous = window.slots[destination]
      if (previous) {
        await click(destination)
        await click(desired[i] ? spare : source)
      }
      if (desired[i]) {
        await click(source)
        await click(destination)
        if (previous) {
          await click(spare)
          await click(source)
        }
      }
      if (window.selectedItem) throw new Error('Container cursor did not clear')
    }
    await bounded(window.close(), signal, 'Close container')
    window = null
    window = await openContainer(bot, task, signal)
    check(bot, signal)
    result = verifyWindow(bot, task, window, contents)
  } catch (caught) {
    error = caught
  } finally {
    try {
      if (window && bot.currentWindow === window) {
        if (window.selectedItem && saved) {
          const empty = window.slots.findIndex((item, i) => i >= window.inventoryStart && i < window.inventoryStart + size && !item)
          if (empty >= 0) await bounded(bot.clickWindow(empty, 0, 0), null, 'Recover container cursor')
        }
        await bounded(window.close(), null, 'Close container during cleanup')
      }
      if (saved && !bot._client?.ended) {
        for (const { slot, item } of saved) {
          if (!equalItem(bot.inventory.slots[slot], item)) {
            if (bot.inventory.slots[slot]) await bounded(bot.creative.setInventorySlot(slot, null), null, 'Clear staging slot during cleanup')
            if (item) await bounded(bot.creative.setInventorySlot(slot, item), null, 'Restore inventory slot')
          }
        }
      }
    } catch (cleanupError) {
      if (error) error.message += `; cleanup failed: ${cleanupError.message}`
      else error = cleanupError
    } finally {
      if (ownedBot) activeBots.delete(bot)
      release()
    }
  }
  if (error) throw error
  return result
}

module.exports = { fillContainer, verifyContainer, isContainerTask, normalizeItems, containerKey, containerOffset }
