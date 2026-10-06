const { Vec3 } = require('vec3')
const { FlightPathfinder } = require('./pathing')

class PhysicalFlightPathfinder extends FlightPathfinder {
  getFlightObstacleKeys () {
    // Players are pushable, transient obstacles; placement checks their bodies.
    return new Set()
  }

  findFlightPath (start, target, margin = 0, maxVisited = 600) {
    this.searchDeadline = Date.now() + 35
    try {
      if (this.segmentClear(start, target)) return [target.clone()]
      const altitude = Math.max(start.y, target.y) + 2
      const departure = new Vec3(start.x, altitude, start.z)
      const arrival = new Vec3(target.x, altitude, target.z)
      if (this.segmentClear(start, departure) && this.segmentClear(departure, arrival) && this.segmentClear(arrival, target)) {
        return [departure, arrival, target.clone()]
      }
      return super.findFlightPath(start, target, margin, Math.min(maxVisited, 600))
    } catch (error) {
      if (error.code !== 'FLIGHT_SEARCH_DEADLINE') throw error
      return null
    } finally {
      this.searchDeadline = 0
    }
  }

  segmentClear (from, to) {
    const steps = Math.max(1, Math.ceil(from.distanceTo(to) / 0.25))
    if (!this.positionClear(from)) return this.escapeSegmentClear(from, to, steps)
    for (let index = 1; index <= steps; index++) {
      if (!this.positionClear(from.plus(to.minus(from).scaled(index / steps)))) return false
    }
    return true
  }

  collisionOverlaps (feet) {
    const min = feet.offset(-0.299, 0.001, -0.299)
    const max = feet.offset(0.299, 1.799, 0.299)
    const overlaps = new Map()
    for (let y = Math.floor(min.y) - 1; y <= Math.floor(max.y); y++) {
      for (let z = Math.floor(min.z); z <= Math.floor(max.z); z++) {
        for (let x = Math.floor(min.x); x <= Math.floor(max.x); x++) {
          const block = this.bot.blockAt(new Vec3(x, y, z))
          if (!block || !block.shapes) return null
          for (const shape of block.shapes) {
            const depths = [
              Math.min(max.x, x + shape[3]) - Math.max(min.x, x + shape[0]),
              Math.min(max.y, y + shape[4]) - Math.max(min.y, y + shape[1]),
              Math.min(max.z, z + shape[5]) - Math.max(min.z, z + shape[2])
            ]
            if (depths.every(value => value > 0)) overlaps.set(`${x},${y},${z}:${block.stateId}:${shape}`, depths)
          }
        }
      }
    }
    return overlaps
  }

  escapeSegmentClear (from, to, steps) {
    // Restored players can overlap a block built after they disconnected.
    let previous = this.collisionOverlaps(from)
    if (!previous?.size) return false
    const volume = overlaps => [...overlaps.values()].reduce((sum, depths) => sum + depths.reduce((a, b) => a * b, 1), 0)
    const initialVolume = volume(previous)
    for (let index = 1; index <= steps; index++) {
      const current = this.collisionOverlaps(from.plus(to.minus(from).scaled(index / steps)))
      if (!current) return false
      for (const [key, depths] of current) {
        const before = previous.get(key)
        if (!before || depths.some((value, axis) => value > before[axis] + 1e-9)) return false
      }
      previous = current
    }
    return volume(previous) < initialVolume - 1e-9
  }

  toFlightCenter (cell) {
    return cell.offset(0.5, 0.1, 0.5)
  }

  positionClear (feet) {
    if (this.searchDeadline && Date.now() > this.searchDeadline) {
      const error = new Error('Flight search time budget exceeded')
      error.code = 'FLIGHT_SEARCH_DEADLINE'
      throw error
    }
    const min = feet.offset(-0.299, 0.001, -0.299)
    const max = feet.offset(0.299, 1.799, 0.299)
    // Fences and walls protrude into the block cell above them.
    for (let y = Math.floor(min.y) - 1; y <= Math.floor(max.y); y++) {
      for (let z = Math.floor(min.z); z <= Math.floor(max.z); z++) {
        for (let x = Math.floor(min.x); x <= Math.floor(max.x); x++) {
          const block = this.bot.blockAt(new Vec3(x, y, z))
          if (!block || !block.shapes) return false
          for (const shape of block.shapes) {
            if (x + shape[0] < max.x && x + shape[3] > min.x &&
                y + shape[1] < max.y && y + shape[4] > min.y &&
                z + shape[2] < max.z && z + shape[5] > min.z) return false
          }
        }
      }
    }
    return true
  }

  isFlightCellPassable (cell, start, obstacles) {
    if (this.isSameFlightCell(cell, start)) return true
    return !obstacles.has(this.getFlightCellKey(cell)) && this.positionClear(this.toFlightCenter(cell))
  }

  canTraverseFlightStep (from, to, start, obstacles) {
    return this.isFlightCellPassable(to, start, obstacles) && this.hasFlightLineOfSight(from, to, start, obstacles)
  }

  hasFlightLineOfSight (from, to, start, obstacles) {
    const a = this.toFlightCenter(from)
    const b = this.toFlightCenter(to)
    const steps = Math.max(1, Math.ceil(a.distanceTo(b) / 0.2))
    for (let i = 1; i <= steps; i++) {
      const point = a.plus(b.minus(a).scaled(i / steps))
      if (!this.positionClear(point) || obstacles.has(this.getFlightCellKey(point.floored()))) return false
    }
    return true
  }

  compressFlightCells (cells) {
    return cells
  }
}

module.exports = { PhysicalFlightPathfinder }
