const installed = new WeakSet()

function forbidden () {
  return Object.assign(new Error('Debug sticks are forbidden for physical construction'), { code: 'DEBUG_STICK_FORBIDDEN' })
}

function assertPhysicalItem (name) {
  if (name?.replace(/^minecraft:/, '') === 'debug_stick') throw forbidden()
}

function installPhysicalItemPolicy (bot) {
  const client = bot._client
  if (installed.has(client)) return
  const registry = bot.registry || require('minecraft-data')(bot.version)
  const id = registry.itemsByName.debug_stick?.id
  const isForbidden = item => item && (item.name === 'debug_stick' || (id !== undefined && [item.type, item.itemId, item.blockId].includes(id)))
  const hasHand = name => registry.protocol.play.toServer.types[`packet_${name}`]?.[1]?.some(field => field.name === 'hand')
  const originalWrite = client.write
  client.write = function (name, params, ...args) {
    if (name === 'set_creative_slot' && isForbidden(params.item)) throw forbidden()
    if (['block_place', 'use_item', 'block_dig', 'use_entity'].includes(name)) {
      const selectsHand = hasHand(name) && (name !== 'use_entity' || [0, 2].includes(params.mouse))
      const item = selectsHand && params.hand === 1 ? bot.inventory?.slots[45] : bot.heldItem
      if (isForbidden(item) || isForbidden(params.heldItem)) throw forbidden()
    }
    return originalWrite.call(this, name, params, ...args)
  }
  installed.add(client)
}

module.exports = { assertPhysicalItem, installPhysicalItemPolicy }
