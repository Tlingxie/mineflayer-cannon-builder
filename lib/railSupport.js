const TOP_SLICE = 1 - 1e-7
const RIM = [
  [0, 0, 1, 1 / 8], [0, 7 / 8, 1, 1],
  [0, 1 / 8, 1 / 8, 7 / 8], [7 / 8, 1 / 8, 1, 7 / 8]
]

function covered (wanted, rectangles) {
  let remaining = [wanted]
  for (const cover of rectangles) {
    const next = []
    for (const area of remaining) {
      const x0 = Math.max(area[0], cover[0])
      const z0 = Math.max(area[1], cover[1])
      const x1 = Math.min(area[2], cover[2])
      const z1 = Math.min(area[3], cover[3])
      if (x0 >= x1 || z0 >= z1) { next.push(area); continue }
      if (area[0] < x0) next.push([area[0], area[1], x0, area[3]])
      if (x1 < area[2]) next.push([x1, area[1], area[2], area[3]])
      if (area[1] < z0) next.push([x0, area[1], x1, z0])
      if (z1 < area[3]) next.push([x0, z1, x1, area[3]])
    }
    remaining = next
    if (!remaining.length) return true
  }
  return false
}

function isRigidRailSupport (block) {
  if (!block || typeof block.name !== 'string') return false
  // Vanilla 1.21.4 support-shape overrides, distinct from movement collision.
  if (block.name === 'soul_sand' || block.name === 'mud') return true
  if (block.name === 'snow') return Number(block.getProperties?.().layers) === 8
  if (block.name.endsWith('_leaves')) return false
  if (block.name === 'chorus_flower' || block.name.endsWith('_hanging_sign') || block.name === 'shulker_box' || block.name.endsWith('_shulker_box')) return false
  if (!Array.isArray(block.shapes) || block.shapes.some(shape => !Array.isArray(shape) || shape.length !== 6 || !shape.every(Number.isFinite))) return false
  const top = block.shapes.filter(shape => shape[1] <= TOP_SLICE && shape[4] > TOP_SLICE)
    .map(shape => [Math.max(0, shape[0]), Math.max(0, shape[2]), Math.min(1, shape[3]), Math.min(1, shape[5])])
    .filter(rectangle => rectangle[0] < rectangle[2] && rectangle[1] < rectangle[3])
  // SupportType.RIGID requires the complete outer two-pixel ring, not its center.
  return RIM.every(rectangle => covered(rectangle, top))
}

module.exports = { isRigidRailSupport }
