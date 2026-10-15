const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const registry = require('minecraft-data')('1.21.11')
const Item = require('prismarine-item')(registry)

function fixture () {
  const writes = []
  const bot = {
    registry,
    version: '1.21.11',
    inventory: { slots: Array(46).fill(null) },
    _client: Object.assign(new EventEmitter(), { write: (...args) => writes.push(args) })
  }
  const { installPhysicalItemPolicy } = require('../lib/physicalItemPolicy')
  installPhysicalItemPolicy(bot)
  return { bot, writes, installPhysicalItemPolicy }
}

test('debug sticks cannot be created through the outgoing creative inventory packet', () => {
  const { bot, writes } = fixture()
  for (const item of [Item.toNotch(new Item(registry.itemsByName.debug_stick.id, 1)), { blockId: registry.itemsByName.debug_stick.id, itemCount: 1 }]) {
    assert.throws(() => bot._client.write('set_creative_slot', { slot: 36, item }), { code: 'DEBUG_STICK_FORBIDDEN' })
  }
  assert.deepEqual(writes, [])
})

test('existing debug sticks cannot be used from either hand or for digging', () => {
  const { bot, writes } = fixture()
  const stick = new Item(registry.itemsByName.debug_stick.id, 1)
  bot.heldItem = stick
  for (const name of ['block_place', 'use_item', 'block_dig', 'use_entity']) {
    assert.throws(() => bot._client.write(name, { hand: 0 }), { code: 'DEBUG_STICK_FORBIDDEN' })
  }
  bot.heldItem = new Item(registry.itemsByName.stone.id, 1)
  bot.inventory.slots[45] = stick
  for (const name of ['block_place', 'use_item']) {
    assert.throws(() => bot._client.write(name, { hand: 1 }), { code: 'DEBUG_STICK_FORBIDDEN' })
  }
  assert.deepEqual(writes, [])
})

test('ordinary material packets and clearing a forbidden slot remain allowed', () => {
  const { bot, writes, installPhysicalItemPolicy } = fixture()
  const write = bot._client.write
  installPhysicalItemPolicy(bot)
  assert.strictEqual(bot._client.write, write)
  bot.heldItem = new Item(registry.itemsByName.stone.id, 1)
  const slot = { slot: 36, item: Item.toNotch(bot.heldItem) }
  bot._client.write('set_creative_slot', slot)
  bot._client.write('block_place', { hand: 0 })
  bot._client.write('set_creative_slot', { slot: 37, item: Item.toNotch(null) })
  bot._client.write('position', { x: 1, y: 2, z: 3 })
  assert.deepEqual(writes.map(([name]) => name), ['set_creative_slot', 'block_place', 'set_creative_slot', 'position'])
})

test('digging and attack packets cannot disguise a main hand debug stick with a nonexistent hand field', () => {
  const { bot, writes } = fixture()
  bot.heldItem = new Item(registry.itemsByName.debug_stick.id, 1)
  bot.inventory.slots[45] = new Item(registry.itemsByName.stone.id, 1)
  assert.throws(() => bot._client.write('block_dig', { status: 0, location: { x: 0, y: 64, z: 0 }, face: 1, sequence: 1, hand: 1 }), { code: 'DEBUG_STICK_FORBIDDEN' })
  assert.throws(() => bot._client.write('use_entity', { target: 12, mouse: 1, hand: 1, sneaking: false }), { code: 'DEBUG_STICK_FORBIDDEN' })
  assert.deepEqual(writes, [])
})
