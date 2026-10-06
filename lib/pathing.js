/**
 * 飞行路径规划模块
 * 包含 A* 寻路和直接飞行控制
 */

const { Vec3 } = require('vec3')

// 预计算的飞行邻居偏移（3x3x3 网格，排除中心）
const FLIGHT_NEIGHBORS = []
for (let dx = -1; dx <= 1; dx++) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dy === 0 && dz === 0) continue
      const offset = new Vec3(dx, dy, dz)
      const cost = Math.sqrt(dx * dx + dy * dy + dz * dz)
      FLIGHT_NEIGHBORS.push({ offset, cost })
    }
  }
}

// 简单的优先队列（二叉堆）用于 A* 搜索
class PriorityQueue {
  constructor () {
    this.items = []
    this.keyToIndex = new Map()
  }

  push (key, priority) {
    const item = { key, priority }
    this.items.push(item)
    this.keyToIndex.set(key, this.items.length - 1)
    this._siftUp(this.items.length - 1)
  }

  pop () {
    if (this.items.length === 0) return null
    const root = this.items[0]
    const last = this.items.pop()
    this.keyToIndex.delete(root.key)

    if (this.items.length > 0) {
      this.items[0] = last
      this.keyToIndex.set(last.key, 0)
      this._siftDown(0)
    }

    return root.key
  }

  peek () {
    return this.items.length > 0 ? this.items[0].key : null
  }

  has (key) {
    return this.keyToIndex.has(key)
  }

  update (key, priority) {
    const index = this.keyToIndex.get(key)
    if (index === undefined) return
    this.items[index].priority = priority
    if (index > 0 && priority < this.items[Math.floor((index - 1) / 2)].priority) {
      this._siftUp(index)
    } else {
      this._siftDown(index)
    }
  }

  _siftUp (index) {
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2)
      if (this.items[index].priority >= this.items[parentIndex].priority) break
      this._swap(index, parentIndex)
      index = parentIndex
    }
  }

  _siftDown (index) {
    const length = this.items.length
    while (true) {
      const leftChild = 2 * index + 1
      const rightChild = 2 * index + 2
      let smallest = index

      if (leftChild < length && this.items[leftChild].priority < this.items[smallest].priority) {
        smallest = leftChild
      }
      if (rightChild < length && this.items[rightChild].priority < this.items[smallest].priority) {
        smallest = rightChild
      }

      if (smallest === index) break
      this._swap(index, smallest)
      index = smallest
    }
  }

  _swap (i, j) {
    const temp = this.items[i]
    this.items[i] = this.items[j]
    this.items[j] = temp
    this.keyToIndex.set(this.items[i].key, i)
    this.keyToIndex.set(this.items[j].key, j)
  }

  get size () {
    return this.items.length
  }
}

class FlightPathfinder {
  constructor (bot, getOtherBotPositions = null) {
    this.bot = bot
    this.getOtherBotPositions = getOtherBotPositions || (() => [])
    this.cachedObstacleKeys = null
    this.cachedObstacleKeysExpire = 0
    this.OBSTACLE_CACHE_TTL = 500
  }

  toFlightCell (pos) {
    return new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
  }

  toFlightCenter (cell) {
    return cell.offset(0.5, 0.5, 0.5)
  }

  getFlightCellKey (pos) {
    return pos.x + ',' + pos.y + ',' + pos.z
  }

  isSameFlightCell (left, right) {
    return left.x === right.x && left.y === right.y && left.z === right.z
  }

  getFlightObstacleKeys () {
    const now = Date.now()
    if (this.cachedObstacleKeys && now < this.cachedObstacleKeysExpire) {
      return this.cachedObstacleKeys
    }

    const obstacles = new Set()
    const robotId = this.bot.builder?.currentRobotId || this.bot.username

    for (const other of this.getOtherBotPositions(robotId)) {
      const base = new Vec3(Math.floor(other.x), Math.floor(other.y), Math.floor(other.z))
      obstacles.add(this.getFlightCellKey(base))
      obstacles.add(this.getFlightCellKey(base.offset(0, 1, 0)))
    }

    this.cachedObstacleKeys = obstacles
    this.cachedObstacleKeysExpire = now + this.OBSTACLE_CACHE_TTL
    return obstacles
  }

  isFlightBlockPassable (block) {
    return !block || block.name === 'air' || block.boundingBox === 'empty' ||
      (Array.isArray(block.shapes) && block.shapes.length === 0)
  }

  isFlightCellPassable (cell, startCell, obstacleKeys) {
    if (this.isSameFlightCell(cell, startCell)) return true

    const key = this.getFlightCellKey(cell)
    if (obstacleKeys.has(key)) return false

    return this.isFlightBlockPassable(this.bot.blockAt(cell)) &&
      this.isFlightBlockPassable(this.bot.blockAt(cell.offset(0, 1, 0)))
  }

  canTraverseFlightStep (fromCell, toCell, startCell, obstacleKeys) {
    if (!this.isFlightCellPassable(toCell, startCell, obstacleKeys)) return false

    const dx = toCell.x - fromCell.x
    const dy = toCell.y - fromCell.y
    const dz = toCell.z - fromCell.z
    const checks = []

    if (dx !== 0) checks.push(fromCell.offset(dx, 0, 0))
    if (dy !== 0) checks.push(fromCell.offset(0, dy, 0))
    if (dz !== 0) checks.push(fromCell.offset(0, 0, dz))
    if (dx !== 0 && dy !== 0) checks.push(fromCell.offset(dx, dy, 0))
    if (dx !== 0 && dz !== 0) checks.push(fromCell.offset(dx, 0, dz))
    if (dy !== 0 && dz !== 0) checks.push(fromCell.offset(0, dy, dz))

    for (const check of checks) {
      if (!this.isFlightCellPassable(check, startCell, obstacleKeys)) return false
    }

    return true
  }

  getFlightHeuristic (from, to) {
    const dx = from.x - to.x
    const dy = from.y - to.y
    const dz = from.z - to.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  getFlightBounds (startCell, targetCell, extraMargin = 0) {
    const dx = Math.abs(targetCell.x - startCell.x)
    const dy = Math.abs(targetCell.y - startCell.y)
    const dz = Math.abs(targetCell.z - startCell.z)
    const span = dx + dy + dz
    const horizontalMargin = Math.min(16, Math.max(6, Math.ceil(span / 4))) + extraMargin
    const verticalMargin = Math.min(10, Math.max(4, Math.ceil(dy / 2) + 3)) + extraMargin

    return {
      minX: Math.min(startCell.x, targetCell.x) - horizontalMargin,
      maxX: Math.max(startCell.x, targetCell.x) + horizontalMargin,
      minY: Math.min(startCell.y, targetCell.y) - verticalMargin,
      maxY: Math.max(startCell.y, targetCell.y) + verticalMargin,
      minZ: Math.min(startCell.z, targetCell.z) - horizontalMargin,
      maxZ: Math.max(startCell.z, targetCell.z) + horizontalMargin
    }
  }

  isWithinFlightBounds (cell, bounds) {
    return cell.x >= bounds.minX && cell.x <= bounds.maxX &&
      cell.y >= bounds.minY && cell.y <= bounds.maxY &&
      cell.z >= bounds.minZ && cell.z <= bounds.maxZ
  }

  getFlightDirection (from, to) {
    return new Vec3(
      Math.sign(to.x - from.x),
      Math.sign(to.y - from.y),
      Math.sign(to.z - from.z)
    )
  }

  sameFlightDirection (left, right) {
    return left && right && left.x === right.x && left.y === right.y && left.z === right.z
  }

  getFlightPointBetween (from, to, ratio) {
    return new Vec3(
      from.x + (to.x - from.x) * ratio,
      from.y + (to.y - from.y) * ratio,
      from.z + (to.z - from.z) * ratio
    )
  }

  hasFlightLineOfSight (fromCell, toCell, startCell, obstacleKeys) {
    if (this.isSameFlightCell(fromCell, toCell)) return true

    const from = this.toFlightCenter(fromCell)
    const to = this.toFlightCenter(toCell)
    const distance = from.distanceTo(to)
    const steps = Math.max(1, Math.ceil(distance / 0.35))
    let previousCell = fromCell

    for (let step = 1; step <= steps; step++) {
      const point = this.getFlightPointBetween(from, to, step / steps)
      const cell = this.toFlightCell(point)
      if (this.isSameFlightCell(cell, previousCell)) continue
      if (!this.canTraverseFlightStep(previousCell, cell, startCell, obstacleKeys)) return false
      previousCell = cell
    }

    return true
  }

  smoothFlightCells (cells, startCell, obstacleKeys) {
    if (cells.length <= 2) return cells

    const smoothed = [cells[0]]
    let index = 0

    while (index < cells.length - 1) {
      let nextIndex = cells.length - 1
      while (nextIndex > index + 1 && !this.hasFlightLineOfSight(cells[index], cells[nextIndex], startCell, obstacleKeys)) {
        nextIndex--
      }
      smoothed.push(cells[nextIndex])
      index = nextIndex
    }

    return smoothed
  }

  compressFlightCells (cells) {
    if (cells.length <= 2) return cells

    const compressed = [cells[0]]
    let previousDirection = null

    for (let index = 1; index < cells.length; index++) {
      const from = cells[index - 1]
      const current = cells[index]
      const next = cells[index + 1]
      const direction = this.getFlightDirection(from, current)

      if (next && this.sameFlightDirection(previousDirection, direction)) continue

      compressed.push(current)
      previousDirection = direction
    }

    return compressed
  }

  reconstructPath (cameFrom, nodes, currentKey, target, startCell, obstacleKeys) {
    const cells = []
    let key = currentKey

    while (key) {
      cells.push(nodes.get(key).pos)
      key = cameFrom.get(key)
    }

    cells.reverse()

    const smoothed = this.smoothFlightCells(cells, startCell, obstacleKeys)
    const compressed = this.compressFlightCells(smoothed)
    const waypoints = compressed.slice(1).map(cell => this.toFlightCenter(cell))
    if (waypoints.length === 0) return [target.clone()]
    waypoints[waypoints.length - 1] = target.clone()
    return waypoints
  }

  findFlightPath (startPos, targetPos, extraMargin = 0, maxVisited = 6000) {
    const startCell = this.toFlightCell(startPos)
    const targetCell = this.toFlightCell(targetPos)

    if (this.isSameFlightCell(startCell, targetCell)) {
      return [targetPos.clone()]
    }

    const obstacleKeys = this.getFlightObstacleKeys()
    const bounds = this.getFlightBounds(startCell, targetCell, extraMargin)
    const startKey = this.getFlightCellKey(startCell)
    const targetKey = this.getFlightCellKey(targetCell)

    const openSet = new PriorityQueue()
    const cameFrom = new Map()
    const gScore = new Map([[startKey, 0]])
    const nodes = new Map([[startKey, { pos: startCell }]])

    const startH = this.getFlightHeuristic(startCell, targetCell)
    openSet.push(startKey, startH)

    let visited = 0

    while (openSet.size > 0 && visited < maxVisited) {
      const currentKey = openSet.pop()
      visited++

      if (currentKey === targetKey) {
        return this.reconstructPath(cameFrom, nodes, currentKey, targetPos, startCell, obstacleKeys)
      }

      const current = nodes.get(currentKey).pos
      const baseCost = gScore.get(currentKey) ?? Number.POSITIVE_INFINITY

      for (const neighborStep of FLIGHT_NEIGHBORS) {
        const neighbor = current.plus(neighborStep.offset)
        const neighborKey = this.getFlightCellKey(neighbor)

        if (!this.isWithinFlightBounds(neighbor, bounds)) continue
        if (!this.canTraverseFlightStep(current, neighbor, startCell, obstacleKeys)) continue

        const tentativeG = baseCost + neighborStep.cost
        const previousG = gScore.get(neighborKey)
        if (previousG !== undefined && tentativeG >= previousG) continue

        cameFrom.set(neighborKey, currentKey)
        nodes.set(neighborKey, { pos: neighbor })
        gScore.set(neighborKey, tentativeG)
        const fScore = tentativeG + this.getFlightHeuristic(neighbor, targetCell)

        if (!openSet.has(neighborKey)) {
          openSet.push(neighborKey, fScore)
        }
      }
    }

    return null
  }

  async flyDirectTo (targetPos, tolerance = 0.35, timeoutMs = 4000) {
    const target = targetPos.clone()

    return new Promise((resolve, reject) => {
      let finished = false
      let lastDistance = Number.POSITIVE_INFINITY
      let lastProgressAt = Date.now()
      let timeoutId = null

      const cleanup = () => {
        if (finished) return
        finished = true
        if (timeoutId) clearTimeout(timeoutId)
        this.bot.entity.velocity.x = 0
        this.bot.entity.velocity.y = 0
        this.bot.entity.velocity.z = 0
      }

      const flyingInterval = setInterval(() => {
        const currentPos = this.bot.entity.position
        const direction = target.minus(currentPos)
        const distance = direction.norm()

        if (distance < tolerance) {
          cleanup()
          clearInterval(flyingInterval)
          resolve()
          return
        }

        if (distance < lastDistance - 0.05) {
          lastDistance = distance
          lastProgressAt = Date.now()
        } else if (Date.now() - lastProgressAt > 1200) {
          cleanup()
          clearInterval(flyingInterval)
          reject(new Error('Fly segment stuck'))
          return
        }

        const speed = Math.min(0.6, Math.max(0.18, distance * 0.2))
        const normalized = direction.normalize()
        this.bot.entity.velocity.x = normalized.x * speed
        this.bot.entity.velocity.y = normalized.y * speed
        this.bot.entity.velocity.z = normalized.z * speed
      }, 50)

      timeoutId = setTimeout(() => {
        cleanup()
        clearInterval(flyingInterval)
        reject(new Error('Fly timeout'))
      }, timeoutMs)
    })
  }

  async flyTo (targetPos, tolerance = 1.5) {
    const target = targetPos.clone()
    let lastError = null

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.bot.creative.startFlying()
      } catch (e) {}

      const path = this.findFlightPath(this.bot.entity.position, target, attempt * 3, 6000 + attempt * 2500)
      if (!path || path.length === 0) {
        lastError = new Error('Flight A* path not found')
        continue
      }

      try {
        for (let index = 0; index < path.length; index++) {
          const waypoint = path[index]
          const isLast = index === path.length - 1
          await this.flyDirectTo(waypoint, isLast ? tolerance : 0.35, isLast ? 6000 : 3500)
        }
        return
      } catch (err) {
        lastError = err
      }
    }

    throw lastError || new Error('Fly timeout')
  }
}

module.exports = {
  FlightPathfinder,
  PriorityQueue,
  FLIGHT_NEIGHBORS
}
