'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const minecraftProtocol = require('minecraft-protocol')
const minecraftData = require('minecraft-data')
const loadItem = require('prismarine-item')
const { installProtocolCompatibility } = require('../lib/protocolCompatibility')

function fixture (version) {
  const serializer = minecraftProtocol.createSerializer({ state: 'play', version })
  const parser = minecraftProtocol.createDeserializer({ state: 'play', version, isServer: true })
  const writes = []
  const client = new EventEmitter()
  client.serializer = serializer
  client.write = function (name, params) {
    assert.equal(this, client)
    const buffer = serializer.createPacketBuffer({ name, params })
    const packet = parser.parsePacketBuffer(buffer).data
    writes.push({ name, params, packet, buffer })
    return buffer.length
  }
  const registry = minecraftData(version)
  const bot = { _client: client, version, registry }
  const Item = loadItem(version)
  function slot (name, components = []) {
    const item = new Item(registry.itemsByName[name].id, 1)
    item.components = components
    return { item, network: Item.toNotch(item) }
  }
  return { bot, client, slot, writes, serializer }
}

function windowClick (changedItem, cursorItem) {
  return {
    windowId: 0,
    stateId: 1,
    slot: 36,
    mouseButton: 0,
    mode: 0,
    changedSlots: [{ location: 36, item: changedItem }],
    cursorItem
  }
}

test('1.21.11 creative item components serialize as UntrustedSlot without changing local items', () => {
  const { bot, client, slot, writes, serializer } = fixture('1.21.11')
  const { item, network } = slot('flint_and_steel', [{ type: 'damage', data: 5 }, { type: 'repair_cost', data: 3 }])
  const packet = { slot: 36, item: network }
  const before = structuredClone(packet)
  installProtocolCompatibility(bot)
  assert.ok(client.write('set_creative_slot', packet) > 0)
  const decoded = writes[0].packet.params.item
  assert.equal(decoded.itemId, item.type)
  assert.deepEqual(decoded.components, [{ type: 'damage', data: Buffer.from([5]) }, { type: 'repair_cost', data: Buffer.from([3]) }])
  for (const component of decoded.components) {
    const prefix = serializer.proto.createPacketBuffer('SlotComponentType', component.type)
    assert.deepEqual(serializer.proto.parsePacketBuffer('SlotComponent', Buffer.concat([prefix, component.data])).data, item.components.find(c => c.type === component.type))
  }
  assert.deepEqual(packet, before)
  assert.strictEqual(network.components, item.components)
  assert.equal(item.components[0].data, 5)
})

test('1.21.11 empty changed slot and empty cursor become absent HashedSlot values', () => {
  const { bot, client, writes } = fixture('1.21.11')
  const empty = { itemCount: 0, components: [], removeComponents: [] }
  const packet = windowClick(empty, empty)
  installProtocolCompatibility(bot)
  client.write('window_click', packet)
  assert.equal(writes[0].packet.params.changedSlots[0].item, undefined)
  assert.equal(writes[0].packet.params.cursorItem, undefined)
  assert.equal(writes[0].params.changedSlots[0].item, null)
  assert.equal(writes[0].params.cursorItem, null)
  assert.strictEqual(packet.cursorItem, empty)
})

test('1.21.11 window clicks hash semantic integer components using vanilla HashOps', () => {
  const { bot, client, slot, writes } = fixture('1.21.11')
  const { network } = slot('flint_and_steel', [{ type: 'damage', data: 10 }, { type: 'repair_cost', data: 3 }])
  network.removeComponents = [{ type: 'custom_name' }]
  network.removedComponentCount = 1
  const packet = windowClick(network, network)
  const before = structuredClone(packet)
  installProtocolCompatibility(bot)
  client.write('window_click', packet)
  const expected = {
    itemId: network.itemId,
    itemCount: 1,
    components: [{ type: 'damage', hash: -919192125 }, { type: 'repair_cost', hash: -499649379 }],
    removeComponents: [{ type: 'custom_name' }]
  }
  assert.deepEqual(writes[0].packet.params.changedSlots[0].item, expected)
  assert.deepEqual(writes[0].packet.params.cursorItem, expected)
  assert.deepEqual(packet, before)
})

test('1.21.11 already encoded creative components and hashed components are preserved', () => {
  const { bot, client, slot, writes } = fixture('1.21.11')
  const { network } = slot('flint_and_steel', [{ type: 'damage', data: Buffer.from([5]) }])
  const hashed = { itemId: network.itemId, itemCount: 1, components: [{ type: 'damage', hash: 645064431 }], removeComponents: [] }
  installProtocolCompatibility(bot)
  client.write('set_creative_slot', { slot: 36, item: network })
  client.write('window_click', windowClick(hashed, hashed))
  assert.deepEqual(writes[0].packet.params.item.components, network.components)
  assert.deepEqual(writes[1].packet.params.cursorItem, hashed)
})

test('zero damage and maximum durability use the vanilla semantic integer hash vectors', () => {
  const { bot, client, slot, writes } = fixture('1.21.11')
  const { network } = slot('flint_and_steel', [{ type: 'damage', data: 0 }, { type: 'max_damage', data: 50 }])
  installProtocolCompatibility(bot)
  client.write('window_click', windowClick(network, null))
  assert.deepEqual(writes[0].packet.params.changedSlots[0].item.components, [
    { type: 'damage', hash: -2146075228 },
    { type: 'max_damage', hash: 20183955 }
  ])
})

test('creative conversion uses each component wire codec including compound data and multi-byte values', () => {
  const { bot, client, slot, writes, serializer } = fixture('1.21.11')
  const components = [
    { type: 'damage', data: 300 },
    { type: 'custom_name', data: { type: 'string', value: 'Builder tool' } },
    { type: 'block_state', data: { properties: [{ name: 'facing', value: 'north' }] } }
  ]
  const { network } = slot('flint_and_steel', components)
  installProtocolCompatibility(bot)
  client.write('set_creative_slot', { slot: 36, item: network })
  assert.deepEqual(writes[0].packet.params.item.components[0].data, Buffer.from([0xac, 0x02]))
  for (const component of writes[0].packet.params.item.components) {
    const prefix = serializer.proto.createPacketBuffer('SlotComponentType', component.type)
    const decoded = serializer.proto.parsePacketBuffer('SlotComponent', Buffer.concat([prefix, component.data])).data
    assert.deepEqual(decoded, components.find(c => c.type === component.type))
  }
})

test('1.21.11 rejects unimplemented component hashes instead of claiming a zero hash', () => {
  const { bot, client, slot, writes } = fixture('1.21.11')
  const { network } = slot('stone', [{ type: 'custom_name', data: { type: 'string', value: 'named' } }])
  installProtocolCompatibility(bot)
  assert.throws(() => client.write('window_click', windowClick(network, null)), /unsupported.*custom_name/i)
  assert.equal(writes.length, 0)
})

test('1.21.4 Slot packets remain unchanged and round trip through the original serializer', () => {
  const { bot, client, slot, writes } = fixture('1.21.4')
  const { network } = slot('flint_and_steel', [{ type: 'damage', data: 5 }])
  const creative = { slot: 36, item: network }
  const click = windowClick(network, { itemCount: 0 })
  installProtocolCompatibility(bot)
  client.write('set_creative_slot', creative)
  client.write('window_click', click)
  assert.strictEqual(writes[0].params, creative)
  assert.strictEqual(writes[1].params, click)
  assert.deepEqual(writes[0].packet.params.item.components, network.components)
  assert.equal(writes[1].packet.params.cursorItem.itemCount, 0)
})

test('packet field definitions select compatibility instead of the bot version string', () => {
  const { bot, client } = fixture('1.21.4')
  const originalWrite = client.write
  bot.version = '1.21.11'
  installProtocolCompatibility(bot)
  assert.strictEqual(client.write, originalWrite)
})

test('compatibility install is idempotent and cleanup restores the original client write', () => {
  const { bot, client } = fixture('1.21.11')
  const originalWrite = client.write
  const restore = installProtocolCompatibility(bot)
  const wrappedWrite = client.write
  assert.equal(typeof restore, 'function')
  assert.strictEqual(installProtocolCompatibility(bot), restore)
  assert.strictEqual(client.write, wrappedWrite)
  client.emit('end')
  assert.strictEqual(client.write, originalWrite)
  restore()
  assert.equal(client.listenerCount('end'), 0)
})

test('an already restored handle cannot remove a later installation', () => {
  const { bot, client } = fixture('1.21.11')
  const firstRestore = installProtocolCompatibility(bot)
  firstRestore()
  const secondRestore = installProtocolCompatibility(bot)
  firstRestore()
  assert.strictEqual(installProtocolCompatibility(bot), secondRestore)
  assert.equal(client.listenerCount('end'), 1)
  secondRestore()
})
