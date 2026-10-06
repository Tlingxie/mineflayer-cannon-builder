const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { normalizeItems, fillContainer, verifyContainer, isContainerTask, containerKey, containerOffset } = require('../lib/physicalInventory')
const Block = require('prismarine-block')('1.21.4')
const Item = require('prismarine-item')('1.21.4')
const data = require('minecraft-data')('1.21.4')
const windows = require('prismarine-windows')('1.21.4')

test('normalizes current count and legacy Count with exact damage components', () => {
  const entries = normalizeItems([{ Slot: 2, id: 'minecraft:shears', count: 1, components: { 'minecraft:damage': 17 } }, { Slot: 0, id: 'minecraft:redstone', Count: 64 }], '1.21.4')
  assert.equal(entries[0].slot, 0)
  assert.equal(entries[0].item.count, 64)
  assert.equal(entries[1].item.durabilityUsed, 17)
  assert.deepEqual(Item.toNotch(entries[1].item).components, [{ type: 'damage', data: 17 }])
  assert.equal(normalizeItems([{ Slot: 0, id: 'minecraft:shears', Count: 1, tag: { Damage: 12 } }], '1.21.4')[0].item.durabilityUsed, 12)
})

test('rejects unrepresentable components, unknown tags, duplicate slots and oversized stacks', () => {
  const item = { Slot: 0, id: 'minecraft:shears', count: 1 }
  assert.throws(() => normalizeItems([{ ...item, components: { 'minecraft:custom_data': { secret: 1 } } }], '1.21.4'), /Unsupported item component/)
  assert.throws(() => normalizeItems([{ ...item, tag: { display: { Name: 'named' } } }], '1.21.4'), /Unsupported legacy item tag/)
  assert.throws(() => normalizeItems([item, item], '1.21.4'), /Duplicate/)
  assert.throws(() => normalizeItems([{ ...item, count: 2 }], '1.21.4'), /stack size/)
  assert.throws(() => normalizeItems([{ ...item, components: 4 }], '1.21.4'), /must be an object/)
  assert.throws(() => normalizeItems([{ ...item, tag: 4 }], '1.21.4'), /must be an object/)
})

function fixture (properties = {}, type = 'minecraft:generic_9x3') {
  const block = Block.fromProperties('chest', properties, 0)
  block.position = new Vec3(0, -60, 0)
  const serverSlots = Array(type === 'minecraft:generic_9x6' ? 54 : 27).fill(null)
  const inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory')
  inventory.updateSlot(9, new Item(data.itemsByName.diamond.id, 3))
  inventory.updateSlot(36, new Item(data.itemsByName.stone.id, 64))
  let opens = 0
  const bot = {
    version: '1.21.4',
    inventory,
    currentWindow: null,
    game: { gameMode: 'creative', dimension: 'overworld' },
    entity: { position: new Vec3(0.5, -60, 2.5), eyeHeight: 1.62 },
    blockAt: () => block,
    creative: { async setInventorySlot (slot, item) { inventory.updateSlot(slot, item) } },
    async openContainer () {
      opens++
      const window = windows.createWindow(opens, type, 'Chest')
      serverSlots.forEach((item, slot) => window.updateSlot(slot, item && Item.fromNotch(Item.toNotch(item))))
      for (let i = 9; i <= 44; i++) window.updateSlot(window.inventoryStart + i - 9, inventory.slots[i])
      window.close = async () => {
        for (let i = 9; i <= 44; i++) inventory.updateSlot(i, window.slots[window.inventoryStart + i - 9])
        bot.currentWindow = null
      }
      bot.currentWindow = window
      return window
    },
    async clickWindow (slot, mouseButton, mode) {
      const w = bot.currentWindow
      w.acceptClick({ slot, mouseButton, mode, item: w.slots[slot] })
      for (let i = 0; i < serverSlots.length; i++) serverSlots[i] = w.slots[i]
    }
  }
  const task = { name: 'chest', state: block.stateId, pos: block.position, blockEntity: { Items: [{ Slot: 2, id: 'minecraft:shears', count: 1, components: { 'minecraft:damage': 17 } }] } }
  return { bot, task, serverSlots, opens: () => opens }
}

test('fills exact server slots, clears stale contents and restores main inventory and hotbar', async () => {
  const f = fixture()
  f.serverSlots[0] = new Item(data.itemsByName.dirt.id, 7)
  f.serverSlots[4] = new Item(data.itemsByName.redstone.id, 7)
  f.task.blockEntity.Items.push({ Slot: 4, id: 'minecraft:redstone', count: 5 })
  f.bot.inventory.updateSlot(44, new Item(data.itemsByName.diamond.id, 2))
  const result = await fillContainer(f.bot, f.task)
  assert.equal(f.serverSlots[0], null)
  assert.equal(f.serverSlots[2].name, 'shears')
  assert.equal(f.serverSlots[2].durabilityUsed, 17)
  assert.equal(f.serverSlots[4].count, 5)
  assert.equal(f.bot.inventory.slots[9].name, 'diamond')
  assert.equal(f.bot.inventory.slots[9].count, 3)
  assert.equal(f.bot.inventory.slots[36].count, 64)
  assert.equal(f.bot.inventory.slots[44].name, 'diamond')
  assert.equal(f.bot.inventory.slots[44].count, 2)
  assert.equal(f.bot.currentWindow, null)
  assert.ok(f.opens() >= 2)
  assert.equal(result.verified, true)
})

test('reads the server again and rejects optimistic clicks the server ignored', async () => {
  const f = fixture()
  f.bot.clickWindow = async (slot, mouseButton, mode) => {
    const w = f.bot.currentWindow
    w.acceptClick({ slot, mouseButton, mode, item: w.slots[slot] })
  }
  await assert.rejects(fillContainer(f.bot, f.task), /verification failed/)
  assert.equal(f.bot.currentWindow, null)
  assert.equal(f.bot.inventory.slots[9].name, 'diamond')
})

test('maps double chest halves to their own 27 slots and identical locks', async () => {
  const f = fixture({ type: 'left', facing: 'east' }, 'minecraft:generic_9x6')
  const right = { ...f.task, pos: f.task.pos.offset(0, 0, 1), state: Block.fromProperties('chest', { type: 'right', facing: 'east' }, 0).stateId }
  assert.equal(containerKey(f.bot, f.task), containerKey(f.bot, right))
  assert.equal(containerOffset('chest', { type: 'right' }, 54), 0)
  assert.equal(containerOffset('chest', { type: 'left' }, 54), 27)
  assert.equal(containerOffset('chest', { type: 'left' }, 27), 0)
  f.serverSlots[2] = new Item(data.itemsByName.gold_ingot.id, 5)
  await fillContainer(f.bot, f.task)
  assert.equal(f.serverSlots[2].name, 'gold_ingot')
  assert.equal(f.serverSlots[29].name, 'shears')
})

test('skips default block entities and rejects out of range or aborted GUI operations', async () => {
  const f = fixture()
  assert.equal((await fillContainer(f.bot, { ...f.task, blockEntity: { OutputSignal: 0, components: {} } })).skipped, true)
  await assert.rejects(fillContainer(f.bot, { ...f.task, blockEntity: { components: 4 } }), /must be an object/)
  assert.equal((await fillContainer(f.bot, { ...f.task, name: 'campfire', blockEntity: { CookingTimes: [0, 0, 0, 0], CookingTotalTimes: [0, 0, 0, 0], Items: [] } })).skipped, true)
  f.bot.entity.position = new Vec3(30, -60, 30)
  await assert.rejects(fillContainer(f.bot, f.task), /reach/)
  assert.equal(f.opens(), 0)
  await assert.rejects(fillContainer(f.bot, f.task, { signal: AbortSignal.abort() }), { name: 'AbortError' })
})

test('serializes bots on the same container and cancels a waiting lock without opening a GUI', async () => {
  const first = fixture()
  const second = fixture()
  let enter
  let resume
  const entered = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { resume = resolve })
  const open = first.bot.openContainer
  first.bot.openContainer = async () => { enter(); await gate; return open() }
  const operation = fillContainer(first.bot, first.task)
  await entered
  const controller = new AbortController()
  const waiting = assert.rejects(fillContainer(second.bot, second.task, { signal: controller.signal }), { name: 'AbortError' })
  controller.abort()
  await waiting
  assert.equal(second.opens(), 0)
  const third = fixture()
  const thirdOperation = fillContainer(third.bot, third.task)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(third.opens(), 0)
  resume()
  await operation
  await thirdOperation
  assert.equal(third.serverSlots[2].name, 'shears')
})

test('final container verification only reads newly opened server slots and preserves inventories', async () => {
  const f = fixture()
  await fillContainer(f.bot, f.task)
  f.bot.creative.setInventorySlot = async () => assert.fail('Read-only verification wrote inventory')
  f.bot.clickWindow = async () => assert.fail('Read-only verification clicked a slot')
  const before = f.bot.inventory.slots.map(item => item && Item.toNotch(item))
  assert.deepEqual(await verifyContainer(f.bot, f.task), { verified: true, slots: 1, items: 1 })
  assert.deepEqual(f.bot.inventory.slots.map(item => item && Item.toNotch(item)), before)
  f.serverSlots[2] = null
  await assert.rejects(verifyContainer(f.bot, f.task), /verification failed.*slot 2/)
  assert.equal(f.bot.currentWindow, null)
  assert.equal(f.serverSlots[2], null)
})

test('read-only verification checks the correct double chest half and explicit empty contents', async () => {
  const f = fixture({ type: 'left', facing: 'east' }, 'minecraft:generic_9x6')
  f.serverSlots[2] = new Item(data.itemsByName.gold_ingot.id, 5)
  await fillContainer(f.bot, f.task)
  assert.equal((await verifyContainer(f.bot, f.task)).verified, true)
  f.task.blockEntity.Items = []
  await assert.rejects(verifyContainer(f.bot, f.task), /verification failed.*slot 2/)
  f.serverSlots[29] = null
  assert.deepEqual(await verifyContainer(f.bot, f.task), { verified: true, slots: 0, items: 0 })
  assert.equal(f.serverSlots[2].name, 'gold_ingot')
  assert.equal((await verifyContainer(f.bot, { ...f.task, name: 'campfire', blockEntity: { Items: [] } })).skipped, true)
  assert.equal((await verifyContainer(f.bot, { ...f.task, blockEntity: { OutputSignal: 0, components: {} } })).skipped, true)
})

test('resume filling explicit empty containers clears old contents instead of skipping', async () => {
  const f = fixture()
  f.task.blockEntity.Items = []
  f.serverSlots[2] = new Item(data.itemsByName.redstone.id, 64)
  assert.deepEqual(await fillContainer(f.bot, f.task), { verified: true, slots: 0, items: 0 })
  assert.equal(f.serverSlots.every(item => item === null), true)
  assert.equal(f.bot.inventory.slots[9].name, 'diamond')
})

test('container task detection includes explicit empty containers without claiming comparator or campfire GUIs', () => {
  assert.equal(isContainerTask({ name: 'hopper', blockEntity: { Items: [] } }), true)
  assert.equal(isContainerTask({ name: 'white_shulker_box', blockEntity: { Items: [] } }), true)
  assert.equal(isContainerTask({ name: 'chest', blockEntity: { components: {} } }), false)
  assert.equal(isContainerTask({ name: 'campfire', blockEntity: { Items: [] } }), false)
  assert.equal(isContainerTask({ name: 'comparator', blockEntity: { OutputSignal: 0 } }), false)
  assert.equal(isContainerTask({ name: 'unknown', blockEntity: { Items: [{ Slot: 0 }] } }), true)
})
