const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const server = require('../scripts/server-local')
const { createServerSnapshot } = require('../lib/serverSnapshot')
const { bannerDifferences, bannerItemComponents } = require('../lib/physicalBanners')
const { normalizeDecorationEntities } = require('../lib/physicalDecorationsData')
const { PhysicalBuilder } = require('../lib/physicalBuilder')
const { EventEmitter } = require('node:events')
const minecraftProtocol = require('minecraft-protocol')
const { installProtocolCompatibility } = require('../lib/protocolCompatibility')

const banner = { name: 'black_wall_banner', blockEntity: { Patterns: [{ Pattern: 'bo', Color: 0 }, { Pattern: 'ms', Color: 0 }] } }

test('inline banner holders survive vanilla NBT serialization and match the source patterns', () => {
  const actual = {
    patterns: [
      { pattern: { asset_id: 'minecraft:border', translation_key: 'block.minecraft.banner.border' }, color: 'white' },
      { pattern: { asset_id: 'minecraft:stripe_middle', translation_key: 'block.minecraft.banner.stripe_middle' }, color: 'white' }
    ]
  }
  assert.deepEqual(bannerDifferences(banner, actual), [])
})

test('snapshot trusts its type constrained selector when vanilla entity NBT omits id', async t => {
  const options = { host: '127.0.0.1', port: 25566, version: '1.21.11' }
  const directory = path.resolve(__dirname, '../.runtime/server')
  const state = { ...options, rconPort: 25576, password: 'review-fixture-only', pid: process.pid, directory }
  t.mock.method(fs, 'readFile', async filename => {
    assert.equal(filename, path.join(directory, 'run.json'))
    return JSON.stringify(state)
  })
  t.mock.method(server, 'rconCommand', async () => 'Armor Stand has the following entity data: {UUID:[I;1,2,3,4],Pos:[1.5d,2.0d,3.5d],Rotation:[0.0f,0.0f],fall_distance:0.0d,NoGravity:0b,Pose:{},equipment:{}}')
  const [expected] = normalizeDecorationEntities({ version: options.version, origin: { x: 0, y: 0, z: 0 }, sourceMin: { x: 0, y: 0, z: 0 }, entities: [{ id: 'minecraft:armor_stand', Pos: [1.5, 2, 3.5] }] })
  const snapshot = await createServerSnapshot(options)
  assert.deepEqual((await snapshot.readDecoration(expected)).differences, [])
  await assert.rejects(snapshot.verifyDecorations([expected, { ...expected, id: 'duplicate-target' }]), /same UUID/)
})

test('equipping a patterned banner indexes every supplied component by its own type', async () => {
  const mcData = require('minecraft-data')('1.21.11')
  const Item = require('prismarine-item')('1.21.11')
  let supplied
  const bot = {
    inventory: { slots: Array(46).fill(null) },
    creative: { setInventorySlot: async (_slot, value) => { supplied = value } },
    setQuickBarSlot: () => {}
  }
  const components = bannerItemComponents(banner)
  await PhysicalBuilder.prototype.equip.call({ bot, mcData, Item }, 'black_banner', undefined, { rotation: '0' }, components)
  assert.equal(supplied.componentMap.get('banner_patterns'), supplied.components.find(c => c.type === 'banner_patterns'))
  assert.equal(supplied.componentMap.get('block_state'), supplied.components.find(c => c.type === 'block_state'))
})

test('creative banner components initialize every inline registry holder wire byte', t => {
  const serializer = minecraftProtocol.createSerializer({ state: 'play', version: '1.21.11' })
  const client = new EventEmitter()
  client.serializer = serializer
  let packet
  client.write = (_name, params) => { packet = params }
  const registry = require('minecraft-data')('1.21.11')
  const Item = require('prismarine-item')('1.21.11')
  const components = bannerItemComponents(banner)
  const stack = new Item(registry.itemsByName.black_banner.id, 1)
  stack.components = components
  installProtocolCompatibility({ _client: client, registry, version: '1.21.11' })
  const originalAllocUnsafe = Buffer.allocUnsafe
  t.mock.method(Buffer, 'allocUnsafe', size => originalAllocUnsafe(size).fill(0x7f))
  client.write('set_creative_slot', { slot: 36, item: Item.toNotch(stack) })
  const component = packet.item.components[0]
  assert.ok(Buffer.isBuffer(component.data))
  const prefix = serializer.proto.createPacketBuffer('SlotComponentType', component.type)
  const encoded = Buffer.concat([prefix, component.data])
  const decoded = serializer.proto.parsePacketBuffer('SlotComponent', encoded)
  assert.deepEqual(decoded.data, components[0])
  assert.equal(decoded.metadata.size, encoded.length)
})
