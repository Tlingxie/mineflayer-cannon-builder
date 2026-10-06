/**
 * Mineflayer Builder Plugin
 * 多机器人协同建筑插件
 */

const { Movements } = require('mineflayer-pathfinder')
const Build = require('./lib/Build')
const { Builder } = require('./lib/builder')
const { FlightPathfinder } = require('./lib/pathing')
const { getOtherBotPositions } = require('./lib/positionLock')
const { wait, withTimeout, hashString } = require('./lib/utils')

function inject (bot) {
  if (!bot.pathfinder) {
    throw new Error('pathfinder must be loaded before builder')
  }

  const mcData = require('minecraft-data')(bot.version)

  const movements = new Movements(bot, mcData)
  movements.canDig = true
  movements.digCost = 5
  movements.maxDropDown = 256
  movements.canPlace = true

  // 启用飞行模式
  movements.allow1by1towers = true
  movements.canFly = true
  movements.flySpeed = 0.5
  movements.maxJump = 256

  bot.pathfinder.searchRadius = 50

  bot.builder = {}

  // 创建路径查找器
  bot.builder.pathfinder = new FlightPathfinder(bot, getOtherBotPositions)

  // 启用飞行
  async function enableFlight () {
    try {
      if (bot.game.gameMode !== 'creative' && bot.game.gameMode !== 'spectator') {
        bot.chat('/gamemode creative')
        await wait(500)
      }
      console.log(`[${bot.username}] Flight mode ready`)
    } catch (e) {
      console.log(`[${bot.username}] Could not enable flight: ${e.message}`)
    }
  }

  bot.builder.enableFlight = enableFlight

  // 飞行到指定位置
  bot.builder.flyTo = async function (targetPos, tolerance = 1.5) {
    return bot.builder.pathfinder.flyTo(targetPos, tolerance)
  }

  // 装备物品
  async function equipItem (id) {
    const Item = require('prismarine-item')(bot.version)
    if (bot.inventory.items().length > 30) {
      bot.chat('/clear')
      await wait(1000)
    }
    if (!bot.inventory.items().find(x => x.type === id)) {
      const slot = bot.inventory.firstEmptyInventorySlot()
      await bot.creative.setInventorySlot(slot !== null ? slot : 36, new Item(id, 1))
    }
    const item = bot.inventory.items().find(x => x.type === id)
    await bot.equip(item, 'hand')
  }

  bot.builder.equipItem = equipItem

  // 主要建造函数
  bot.builder.build = async function (build, options = {}) {
    // 支持旧版调用方式: build(robotId, useFlight)
    if (typeof options === 'string') {
      options = { robotId: options }
    } else if (typeof options === 'boolean') {
      options = { useFlight: options }
    }

    const {
      robotId = null,
      useFlight = true,
      aggressiveStuckDetection = false, // 激进卡住检测模式
      stuckDetectionOptions = {} // 自定义检测参数
    } = options

    build.robotId = robotId || bot.username
    bot.builder.currentRobotId = build.robotId
    build.cleanupLocks()

    // 启用飞行模式
    if (useFlight) {
      try {
        await enableFlight()
      } catch (e) {
        console.log(`[${build.robotId}] Could not enable flight, continuing without it`)
      }
    }

    // 使用 Builder 执行建造
    const builder = new Builder(bot, build, {
      robotId: build.robotId,
      useFlight,
      aggressiveMode: aggressiveStuckDetection,
      ...stuckDetectionOptions
    })

    // 暴露卡住检测器状态
    bot.builder.stuckDetector = builder.stuckDetector

    await builder.run()
  }
}

module.exports = {
  Build,
  builder: inject,
  wait,
  withTimeout,
  hashString
}
