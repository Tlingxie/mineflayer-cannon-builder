const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const LEGACY = {
  b: 'base',
  bl: 'square_bottom_left',
  br: 'square_bottom_right',
  tl: 'square_top_left',
  tr: 'square_top_right',
  bs: 'stripe_bottom',
  ts: 'stripe_top',
  ls: 'stripe_left',
  rs: 'stripe_right',
  cs: 'stripe_center',
  ms: 'stripe_middle',
  drs: 'stripe_downright',
  dls: 'stripe_downleft',
  ss: 'small_stripes',
  cr: 'cross',
  sc: 'straight_cross',
  bt: 'triangle_bottom',
  tt: 'triangle_top',
  bts: 'triangles_bottom',
  tts: 'triangles_top',
  ld: 'diagonal_left',
  rd: 'diagonal_up_right',
  lud: 'diagonal_up_left',
  rud: 'diagonal_right',
  mc: 'circle',
  mr: 'rhombus',
  vh: 'half_vertical',
  hh: 'half_horizontal',
  vhr: 'half_vertical_right',
  hhb: 'half_horizontal_bottom',
  bo: 'border',
  cbo: 'curly_border',
  gra: 'gradient',
  gru: 'gradient_up',
  bri: 'bricks',
  cre: 'creeper',
  sku: 'skull',
  flo: 'flower',
  moj: 'mojang',
  glb: 'globe',
  pig: 'piglin',
  flw: 'flow',
  gus: 'guster'
}
const PATTERNS = new Set(Object.values(LEGACY))

function bannerPatterns (task) {
  if (!task.name?.endsWith('_banner')) return []
  const tile = task.blockEntity || {}
  const raw = tile.patterns ?? tile.Patterns ?? []
  if (!Array.isArray(raw) || raw.length > 128) throw new Error('Invalid banner patterns')
  return raw.map(layer => {
    let pattern = layer.pattern ?? LEGACY[layer.Pattern]
    if (typeof pattern !== 'string') throw new Error(`Unsupported banner pattern: ${layer.Pattern}`)
    pattern = pattern.replace(/^minecraft:/, '')
    if (!PATTERNS.has(pattern)) throw new Error(`Unsupported banner pattern: ${pattern}`)
    const color = layer.color ?? COLORS[layer.Color]
    if (!COLORS.includes(color)) throw new Error('Invalid banner color')
    return { pattern: `minecraft:${pattern}`, color }
  })
}

function bannerItemComponents (task) {
  const patterns = bannerPatterns(task)
  if (!patterns.length) return []
  return [{
    type: 'banner_patterns',
    data: { layers: patterns.map(({ pattern, color }) => ({ pattern: { data: { assetId: pattern, translationKey: `block.minecraft.banner.${pattern.slice(10)}` } }, colorId: COLORS.indexOf(color) })) }
  }]
}

function bannerDifferences (task, actual) {
  const patterns = actual.patterns || []
  if (!Array.isArray(patterns)) return ['patterns']
  const observed = patterns.map(({ pattern, color }) => {
    if (pattern && typeof pattern === 'object') {
      if (pattern.translation_key !== `block.minecraft.banner.${pattern.asset_id?.replace(/^minecraft:/, '')}`) return null
      pattern = pattern.asset_id
    }
    return { pattern, color }
  })
  return JSON.stringify(bannerPatterns(task)) === JSON.stringify(observed) ? [] : ['patterns']
}

module.exports = { bannerPatterns, bannerItemComponents, bannerDifferences }
