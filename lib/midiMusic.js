const zlib = require('node:zlib')
const nbt = require('prismarine-nbt')
const { parseMidi } = require('./midiParser')
const { resolveState } = require('./strictSchematic')

const INSTRUMENTS = {
  harp: { base: 54, block: 'dirt' },
  bass: { base: 30, block: 'oak_planks' },
  basedrum: { base: 54, block: 'stone' },
  snare: { base: 54, block: 'sand' },
  hat: { base: 54, block: 'glass' },
  guitar: { base: 42, block: 'white_wool' },
  flute: { base: 66, block: 'clay' },
  bell: { base: 78, block: 'gold_block' },
  chime: { base: 78, block: 'packed_ice' },
  xylophone: { base: 78, block: 'bone_block' },
  iron_xylophone: { base: 54, block: 'iron_block' },
  cow_bell: { base: 66, block: 'soul_sand' },
  didgeridoo: { base: 30, block: 'pumpkin' },
  bit: { base: 54, block: 'emerald_block' },
  banjo: { base: 54, block: 'hay_block' },
  pling: { base: 54, block: 'glowstone' }
}
const FAMILIES = ['harp', 'xylophone', 'pling', 'guitar', 'bass', 'guitar', 'harp', 'didgeridoo', 'didgeridoo', 'flute', 'bit', 'chime', 'bell', 'banjo', 'iron_xylophone', 'cow_bell']
const CENTER = 14
const HEIGHT = 5
const LENGTH = 29
const QUANTUM = 0.1

function instrumentFor (note) {
  if (note.channel !== 9) return FAMILIES[Math.floor(note.program / 8)]
  if ([35, 36, 41, 43, 45, 47, 48, 50].includes(note.midi)) return 'basedrum'
  if ([42, 44, 46, 49, 51, 52, 53, 55, 57, 59].includes(note.midi)) return 'hat'
  if (note.midi === 56) return 'cow_bell'
  return 'snare'
}

function compileMidi (buffer, { version = '1.21.11', title = 'MIDI Music' } = {}) {
  if (typeof title !== 'string' || !title.trim() || title.length > 120) throw new Error('音乐标题必须是 1 到 120 个字符')
  const data = require('minecraft-data')(version)
  if (!data?.version?.dataVersion || !data.blocksByName.note_block) throw new Error(`不支持 Minecraft 版本 ${version}`)
  const parsed = parseMidi(buffer)
  const notes = []
  const seen = new Set()
  let octaveAdjustedNotes = 0
  let deduplicatedNotes = 0
  let maxTimingErrorMs = 0
  for (const source of parsed.notes) {
    const instrument = instrumentFor(source)
    const definition = INSTRUMENTS[instrument]
    let pitch = source.midi
    while (pitch < definition.base) pitch += 12
    while (pitch > definition.base + 24) pitch -= 12
    if (pitch !== source.midi) octaveAdjustedNotes++
    // Keep half-tick rounding exact across fractional PPQ times and tempo changes.
    const step = Math.floor((source.microticks * 10 + parsed.ppq * 500000) / (parsed.ppq * 1000000))
    maxTimingErrorMs = Math.max(maxTimingErrorMs, Math.abs(step * QUANTUM - source.timeSeconds) * 1000)
    const note = pitch - definition.base
    const id = `${step}:${instrument}:${note}`
    if (seen.has(id)) {
      deduplicatedNotes++
      continue
    }
    seen.add(id)
    notes.push({ sourceMidi: source.midi, channel: source.channel, program: source.program, instrument, note, baseBlock: definition.block, timeSeconds: source.timeSeconds, step })
  }
  const groups = new Map()
  for (const note of notes) {
    if (!groups.has(note.step)) groups.set(note.step, [])
    groups.get(note.step).push(note)
  }
  const modules = []
  let elapsed = 0
  for (const [step, chord] of groups) {
    if (chord.length > 52) throw new Error(`第 ${step} 个时间格的和弦有 ${chord.length} 音，超过 52 音和弦上限，请减少同时发声的音符`)
    let gap = 1 + step - elapsed
    while (gap > 4) {
      modules.push({ delay: 4, step: null, notes: [] })
      gap -= 4
      elapsed += 4
    }
    modules.push({ delay: gap, step, notes: chord })
    elapsed += gap
  }
  const width = 2 + modules.length * 4
  const volume = width * HEIGHT * LENGTH
  if (width > 32767 || volume > 2000000) throw new Error('生成轨道超过 200 万格体积上限，请拆分 MIDI')
  const palette = new Map([['minecraft:air', 0]])
  const cells = new Uint16Array(volume)
  const place = (x, y, z, name, properties = {}) => {
    const suffix = Object.keys(properties).length ? '[' + Object.entries(properties).sort(([a], [b]) => a.localeCompare(b)).map(([property, value]) => `${property}=${value}`).join(',') + ']' : ''
    const text = `minecraft:${name}${suffix}`
    if (!palette.has(text)) {
      resolveState(name, properties, version)
      palette.set(text, palette.size)
    }
    const index = x + z * width + y * width * LENGTH
    const state = palette.get(text)
    if (cells[index] && cells[index] !== state) throw new Error('生成的音乐轨道方块发生重叠')
    cells[index] = state
  }
  place(1, 2, CENTER, 'stone')
  place(1, 3, CENTER, 'stone')
  place(1, 4, CENTER, 'stone_button', { face: 'floor', facing: 'west', powered: false })
  modules.forEach((module, moduleIndex) => {
    const x = 2 + moduleIndex * 4
    module.x = x
    module.y = 3
    module.z = CENTER
    for (let offset = 0; offset < 4; offset++) place(x + offset, 2, CENTER, 'stone')
    place(x, 3, CENTER, 'repeater', { delay: module.delay, facing: 'west', locked: false, powered: false })
    place(x + 1, 3, CENTER, 'stone')
    for (const offset of [2, 3]) place(x + offset, 3, CENTER, 'redstone_wire', { east: 'side', north: 'none', south: 'none', west: 'side', power: 0 })
    for (let index = 0; index < module.notes.length; index++) {
      const note = module.notes[index]
      const side = Math.floor(index / 26) === 0 ? -1 : 1
      const distance = Math.floor((index % 26) / 2) + 1
      const z = CENTER + side * distance
      const noteX = x + (index % 2 === 0 ? 0 : 2)
      for (let branch = 1; branch <= distance; branch++) {
        const branchZ = CENTER + side * branch
        place(x + 1, 2, branchZ, 'stone')
        place(x + 1, 3, branchZ, 'redstone_wire', { east: 'none', north: 'side', south: 'side', west: 'none', power: 0 })
      }
      place(noteX, 0, z, 'stone')
      place(noteX, 1, z, note.baseBlock)
      place(noteX, 2, z, 'note_block', { instrument: note.instrument, note: note.note, powered: false })
      note.moduleIndex = moduleIndex
      note.pos = { x: noteX, y: 2, z }
    }
  })
  const bytes = []
  for (let value of cells) {
    do {
      const next = value & 127
      value >>>= 7
      const encoded = next | (value ? 128 : 0)
      bytes.push(encoded > 127 ? encoded - 256 : encoded)
    } while (value)
  }
  const source = nbt.comp({
    Version: nbt.int(2),
    DataVersion: nbt.int(data.version.dataVersion),
    Width: nbt.short(width),
    Height: nbt.short(HEIGHT),
    Length: nbt.short(LENGTH),
    Offset: nbt.intArray([0, 0, 0]),
    Metadata: nbt.comp({ Name: nbt.string(title.trim()), MineflayerMusic: nbt.int(1) }),
    PaletteMax: nbt.int(palette.size),
    Palette: nbt.comp(Object.fromEntries([...palette].map(([name, index]) => [name, nbt.int(index)]))),
    BlockData: nbt.byteArray(bytes),
    BlockEntities: nbt.list(nbt.comp([])),
    Entities: nbt.list(nbt.comp([]))
  })
  const instrumentCounts = new Map()
  for (const note of notes) instrumentCounts.set(note.instrument, (instrumentCounts.get(note.instrument) || 0) + 1)
  const warnings = [
    ...parsed.warnings,
    '红石时间格为 100 毫秒，音符起始时间会四舍五入；点击起点按钮后统一增加 100 毫秒启动延迟。',
    '音符盒只还原每个音符的起音，无法还原 MIDI 的持续音、力度、踏板和全部原始音色。',
    '轨道沿 +X 延伸；长曲播放时需要跟随信号或提前加载沿途区块，避免信号进入未加载区块后停顿。'
  ]
  if (octaveAdjustedNotes) warnings.push(`${octaveAdjustedNotes} 个源音符已按八度折叠到对应音符盒的 25 音范围，音高可能与原曲不同。`)
  if (deduplicatedNotes) warnings.push(`${deduplicatedNotes} 个相同时间格、音色和音高的重复音已合并。`)
  return {
    schematic: zlib.gzipSync(nbt.writeUncompressed(source)),
    music: {
      title: title.trim(),
      noteCount: notes.length,
      sourceNoteCount: parsed.sourceNoteCount,
      durationSeconds: parsed.durationSeconds,
      playbackDurationSeconds: elapsed * QUANTUM,
      quantumSeconds: QUANTUM,
      startDelaySeconds: QUANTUM,
      maxTimingErrorMs,
      octaveAdjustedNotes,
      deduplicatedNotes,
      instruments: [...instrumentCounts].map(([name, count]) => ({ name, notes: count })),
      start: { x: 1, y: 4, z: CENTER },
      size: { x: width, y: HEIGHT, z: LENGTH },
      moduleCount: modules.length,
      format: parsed.format,
      trackCount: parsed.trackCount,
      ppq: parsed.ppq,
      notes,
      modules,
      warnings
    }
  }
}

module.exports = { compileMidi }
