/**
 * 方块放置模块
 */

class BlockPlacer {
  constructor (bot, build) {
    this.bot = bot
    this.build = build
  }

  async placeBlock (action, options = {}) {
    const { refBlock, placeFace, half, delta } = options

    try {
      if (delta) {
        await this.bot._placeBlockWithOptions(refBlock, placeFace, { half, delta })
      } else {
        await this.bot._placeBlockWithOptions(refBlock, placeFace, { half })
      }
      return true
    } catch (err) {
      try {
        await this.bot.placeBlock(refBlock, placeFace)
        return true
      } catch (fallbackErr) {
        return false
      }
    }
  }

  async digBlock (action, timeout = 15000) {
    const block = this.bot.blockAt(action.pos)
    if (!block || block.name === 'air') return true

    const { withTimeout } = require('./utils')
    await withTimeout(this.bot.dig(block, true), timeout, 'Dig timeout')
    return true
  }

  async interactToMatch (action, block) {
    const { withTimeout } = require('./utils')

    await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
    await withTimeout(this.bot.activateBlock(block), 5000, 'Activate block timeout')
    await this.bot.wait(80)
    return this.build.isActionSatisfied(action, this.bot.blockAt(action.pos), { exactProperties: true })
  }
}

module.exports = BlockPlacer
