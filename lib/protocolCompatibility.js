'use strict'

const installed = new WeakMap()
const integerComponents = new Set(['damage', 'repair_cost', 'max_damage', 'max_stack_size'])

function fieldType (container, name) {
  return container?.[0] === 'container' ? container[1].find(field => field.name === name)?.type : undefined
}

function isHashedSlot (type) {
  return Array.isArray(type) && type[0] === 'option' && type[1] === 'HashedSlot'
}

function integerHash (value) {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new TypeError('Item component HashOps INT requires a signed 32-bit integer')
  }
  // HashOps hashes the semantic INT tag and little-endian value, not its wire VarInt.
  // Vanilla vectors: damage=10 -> -919192125; repair_cost=3 -> -499649379.
  const bytes = Buffer.alloc(5)
  bytes[0] = 8
  bytes.writeInt32LE(value, 1)
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0)
  }
  return (crc ^ 0xffffffff) | 0
}

function hashedComponent (component) {
  if (Object.hasOwn(component, 'hash') && !Object.hasOwn(component, 'data')) {
    if (!Number.isInteger(component.hash) || component.hash < -2147483648 || component.hash > 2147483647) {
      throw new TypeError(`Invalid signed component hash for ${component.type}`)
    }
    return component
  }
  if (!integerComponents.has(component.type)) {
    throw new Error(`Unsupported HashedSlot component: ${component.type}; its semantic hash is not implemented`)
  }
  return { type: component.type, hash: integerHash(component.data) }
}

function hashedSlot (item) {
  if (!item || item.present === false || item.itemCount === 0) return null
  if (!Number.isInteger(item.itemId) || !Number.isInteger(item.itemCount) || item.itemCount < 1) {
    throw new TypeError('HashedSlot requires a nonempty network item with itemId and itemCount')
  }
  return {
    itemId: item.itemId,
    itemCount: item.itemCount,
    components: (item.components || []).map(hashedComponent),
    removeComponents: item.removeComponents || []
  }
}

function untrustedSlot (item, proto) {
  if (!item || item.itemCount === 0) return item || { itemCount: 0 }
  const components = (item.components || []).map(component => {
    if (Buffer.isBuffer(component.data)) return component
    // The native inline registry-holder writer skips its zero discriminator.
    // Zero-initialize this buffer rather than exposing uninitialized bytes on wire.
    const encoded = Buffer.alloc(proto.sizeOf(component, 'SlotComponent'))
    proto.write(component, encoded, 0, 'SlotComponent')
    const prefix = proto.createPacketBuffer('SlotComponentType', component.type)
    return { ...component, data: encoded.subarray(prefix.length) }
  })
  return {
    ...item,
    components,
    addedComponentCount: components.length,
    removeComponents: item.removeComponents || [],
    removedComponentCount: item.removeComponents?.length || 0
  }
}

function installProtocolCompatibility (bot) {
  const client = bot._client
  if (installed.has(client)) return installed.get(client)
  const registry = bot.registry || require('minecraft-data')(bot.version)
  const packetTypes = {
    ...registry.protocol.play.toServer.types,
    ...client.customPackets?.[registry.version.majorVersion]?.play?.toServer?.types
  }
  const creative = fieldType(packetTypes.packet_set_creative_slot, 'item') === 'UntrustedSlot'
  const clickType = packetTypes.packet_window_click
  const changes = fieldType(clickType, 'changedSlots')
  const hashedChanges = changes?.[0] === 'array' && isHashedSlot(fieldType(changes[1].type, 'item'))
  const hashedCursor = isHashedSlot(fieldType(clickType, 'cursorItem'))
  const originalWrite = client.write

  function write (name, params, ...args) {
    if (name === 'set_creative_slot' && creative) {
      params = { ...params, item: untrustedSlot(params.item, client.serializer.proto) }
    } else if (name === 'window_click' && (hashedChanges || hashedCursor)) {
      params = {
        ...params,
        ...(hashedChanges ? { changedSlots: params.changedSlots.map(change => ({ ...change, item: hashedSlot(change.item) })) } : {}),
        ...(hashedCursor ? { cursorItem: hashedSlot(params.cursorItem) } : {})
      }
    }
    return originalWrite.call(this, name, params, ...args)
  }

  function restore () {
    if (client.write === write) client.write = originalWrite
    client.removeListener('end', restore)
    if (installed.get(client) === restore) installed.delete(client)
  }

  if (creative || hashedChanges || hashedCursor) client.write = write
  installed.set(client, restore)
  client.once('end', restore)
  return restore
}

module.exports = { installProtocolCompatibility }
