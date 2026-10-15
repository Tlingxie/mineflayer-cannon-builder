const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const nbt = require('prismarine-nbt')
const { readPlan } = require('../lib/strictSchematic')

const compile = (...args) => require('../lib/midiMusic').compileMidi(...args)
const vlq = value => {
  const bytes = [value & 127]
  while ((value = Math.floor(value / 128))) bytes.unshift((value & 127) | 128)
  return bytes
}
const event = (delta, ...bytes) => [...vlq(delta), ...bytes]
const tempo = (delta, microseconds) => event(delta, 255, 81, 3, microseconds >> 16, (microseconds >> 8) & 255, microseconds & 255)
const end = delta => event(delta, 255, 47, 0)
function midi (tracks, { format = tracks.length > 1 ? 1 : 0, division = 480 } = {}) {
  const header = Buffer.alloc(14)
  header.write('MThd')
  header.writeUInt32BE(6, 4)
  header.writeUInt16BE(format, 8)
  header.writeUInt16BE(tracks.length, 10)
  header.writeUInt16BE(division, 12)
  return Buffer.concat([header, ...tracks.map(events => {
    const data = Buffer.from(events.flat())
    const chunk = Buffer.alloc(8)
    chunk.write('MTrk')
    chunk.writeUInt32BE(data.length, 4)
    return Buffer.concat([chunk, data])
  })])
}
async function planFor (t, result) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'midi-music-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'music.schem')
  await fs.writeFile(filename, result.schematic)
  return readPlan(filename, '1.21.11', { x: 0, y: 0, z: 0 })
}

test('compiles onset-only MIDI into a standard Sponge schematic with physical note bases and clear space', async t => {
  const result = compile(midi([[
    event(0, 144, 54, 100), event(240, 128, 54, 0),
    event(240, 144, 60, 90), event(480, 144, 60, 0), end(0)
  ]]), { title: 'Two notes' })
  assert.ok(Buffer.isBuffer(result.schematic))
  assert.equal(result.music.sourceNoteCount, 2)
  assert.equal(result.music.noteCount, 2)
  assert.equal(result.music.quantumSeconds, 0.1)
  assert.equal(result.music.durationSeconds, 1)
  assert.deepEqual(result.music.notes.map(note => note.step), [0, 5])
  assert.deepEqual(result.music.notes.map(note => note.note), [0, 6])
  assert.deepEqual(result.music.start, { x: 1, y: 4, z: 14 })
  const { parsed } = await nbt.parse(result.schematic)
  const source = nbt.simplify(parsed)
  assert.equal(source.Version, 2)
  assert.equal(source.DataVersion, 4671)
  assert.equal(source.Metadata.MineflayerMusic, 1)
  assert.ok(source.Palette['minecraft:air'] !== undefined)
  const plan = await planFor(t, result)
  assert.deepEqual(plan.sourceMin, { x: 0, y: 0, z: 0 })
  assert.equal(plan.music, true)
  const lookup = new Map(plan.tasks.map(task => [task.id, task]))
  const Block = require('prismarine-block')('1.21.11')
  for (const note of result.music.notes) {
    const { x, y, z } = note.pos
    const task = lookup.get(`${x},${y},${z}`)
    assert.equal(task.name, 'note_block')
    assert.equal(Number(Block.fromStateId(task.state, 0).getProperties().note), note.note)
    assert.equal(Block.fromStateId(task.state, 0).getProperties().instrument, note.instrument)
    assert.equal(lookup.get(`${x},${y - 1},${z}`).name, 'dirt')
    assert.equal(lookup.get(`${x},${y - 2},${z}`).name, 'stone')
    assert.ok(plan.air.some(position => position.x === x && position.y === y + 1 && position.z === z))
  }
  assert.ok(result.music.warnings.some(warning => /100.*毫秒|0\.1.*秒/.test(warning)))
  assert.ok(result.music.warnings.some(warning => /持续|力度/.test(warning)))
})

test('merges tempo maps across tracks and honors running status, program changes and note-on velocity zero', () => {
  const result = compile(midi([
    [tempo(0, 500000), tempo(480, 1000000), end(480)],
    [event(0, 192, 24), event(0, 144, 42, 99), event(480, 54, 99), event(480, 54, 0), end(0)]
  ]))
  assert.equal(result.music.sourceNoteCount, 2)
  assert.equal(result.music.durationSeconds, 1.5)
  assert.deepEqual(result.music.notes.map(note => note.timeSeconds), [0, 0.5])
  assert.deepEqual(result.music.notes.map(note => note.instrument), ['guitar', 'guitar'])
  assert.deepEqual(result.music.notes.map(note => note.note), [0, 12])
  const crossTrack = compile(midi([
    [event(0, 192, 32), event(240, 192, 72), end(240)],
    [event(0, 144, 30, 99), event(480, 144, 66, 99), end(0)]
  ]))
  assert.deepEqual(crossTrack.music.notes.map(note => note.instrument), ['bass', 'flute'])
})

test('applies global tempo changes to notes on earlier tracks and preserves their chronological order', () => {
  const result = compile(midi([
    [event(0, 144, 54, 100), event(480, 144, 55, 100), event(480, 144, 56, 100), end(0)],
    [tempo(0, 500000), tempo(240, 1000000), tempo(480, 250000), end(240)]
  ]))
  assert.deepEqual(result.music.notes.map(note => note.timeSeconds), [0, 0.75, 1.375])
  assert.deepEqual(result.music.notes.map(note => note.step), [0, 8, 14])
  assert.equal(result.music.durationSeconds, 1.375)
})

test('rounds timing to 100 ms, preserves initial silence and compresses gaps using legal repeater delays', async t => {
  const result = compile(midi([[
    event(60, 144, 60, 100), event(900, 144, 62, 100), end(0)
  ]]))
  assert.deepEqual(result.music.notes.map(note => note.step), [1, 10])
  assert.ok(Math.abs(result.music.maxTimingErrorMs - 37.5) < 1e-8)
  let elapsed = 0
  for (const module of result.music.modules) {
    assert.ok(Number.isInteger(module.delay) && module.delay >= 1 && module.delay <= 4)
    elapsed += module.delay
    if (module.step !== null) assert.equal(elapsed, 1 + module.step)
  }
  assert.deepEqual(result.music.modules.map(module => module.delay), [2, 4, 4, 1])
  const plan = await planFor(t, result)
  const Block = require('prismarine-block')('1.21.11')
  const repeaters = plan.tasks.filter(task => task.name === 'repeater').sort((a, b) => a.pos.x - b.pos.x)
  assert.deepEqual(repeaters.map(task => Number(Block.fromStateId(task.state, 0).getProperties().delay)), [2, 4, 4, 1])
  assert.ok(repeaters.every(task => Block.fromStateId(task.state, 0).getProperties().facing === 'west'))
  const lookup = new Map(plan.tasks.map(task => [task.id, task.name]))
  for (const repeater of repeaters) {
    const { x, y, z } = repeater.pos
    assert.equal(lookup.get(`${x},${y - 1},${z}`), 'stone')
    assert.equal(lookup.get(`${x + 1},${y},${z}`), 'stone')
    assert.equal(lookup.get(`${x + 2},${y},${z}`), 'redstone_wire')
    assert.equal(lookup.get(`${x + 3},${y},${z}`), 'redstone_wire')
  }
})

test('rounds exact half-quantum onsets consistently despite floating-point representation', () => {
  const result = compile(midi([[event(144, 144, 54, 100), end(0)]]))
  assert.equal(result.music.notes[0].timeSeconds, 0.15)
  assert.equal(result.music.notes[0].step, 2)
  assert.ok(Math.abs(result.music.maxTimingErrorMs - 50) < 1e-8)
})

test('maps instrument families, percussion and octave folding without dropping distinct chords', async t => {
  const tracks = [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120].map((program, index) => [
    event(0, 192 | (index % 9), program), event(0, 144 | (index % 9), program < 32 ? 0 : 127, 99), end(0)
  ])
  tracks.push([event(0, 153, 36, 100), event(0, 153, 38, 100), event(0, 153, 42, 100), end(0)])
  const result = compile(midi(tracks))
  assert.equal(result.music.sourceNoteCount, 19)
  assert.ok(result.music.notes.every(note => note.note >= 0 && note.note <= 24))
  assert.ok(result.music.octaveAdjustedNotes >= 16)
  assert.ok(result.music.instruments.some(instrument => instrument.name === 'basedrum'))
  assert.ok(result.music.instruments.some(instrument => instrument.name === 'snare'))
  assert.ok(result.music.instruments.some(instrument => instrument.name === 'hat'))
  const plan = await planFor(t, result)
  const lookup = new Map(plan.tasks.map(task => [task.id, task.name]))
  for (const note of result.music.notes) {
    assert.equal(lookup.get(`${note.pos.x},1,${note.pos.z}`), note.baseBlock)
    const branchX = result.music.modules[note.moduleIndex].x + 1
    assert.equal(lookup.get(`${branchX},2,${note.pos.z}`), 'stone')
    assert.equal(lookup.get(`${branchX},3,${note.pos.z}`), 'redstone_wire')
  }
})

test('maps every General MIDI family to a verified instrument and stable material', () => {
  const families = [
    ['harp', 54, 'dirt'], ['xylophone', 78, 'bone_block'], ['pling', 54, 'glowstone'], ['guitar', 42, 'white_wool'],
    ['bass', 30, 'oak_planks'], ['guitar', 42, 'white_wool'], ['harp', 54, 'dirt'], ['didgeridoo', 30, 'pumpkin'],
    ['didgeridoo', 30, 'pumpkin'], ['flute', 66, 'clay'], ['bit', 54, 'emerald_block'], ['chime', 78, 'packed_ice'],
    ['bell', 78, 'gold_block'], ['banjo', 54, 'hay_block'], ['iron_xylophone', 54, 'iron_block'], ['cow_bell', 66, 'soul_sand']
  ]
  for (const [family, [instrument, pitch, block]] of families.entries()) {
    const result = compile(midi([[event(0, 192, family * 8), event(0, 144, pitch, 100), end(0)]]))
    assert.equal(result.music.notes[0].instrument, instrument)
    assert.equal(result.music.notes[0].baseBlock, block)
    assert.equal(result.music.notes[0].note, 0)
    assert.equal(result.music.octaveAdjustedNotes, 0)
  }
})

test('deduplicates only notes with identical quantized time, mapped instrument and pitch', () => {
  const result = compile(midi([[
    event(0, 144, 54, 100), event(0, 144, 54, 80),
    event(1, 144, 66, 90), event(0, 193, 32), event(0, 145, 54, 100), end(0)
  ]]))
  assert.equal(result.music.sourceNoteCount, 4)
  assert.equal(result.music.noteCount, 3)
  assert.equal(result.music.deduplicatedNotes, 1)
  assert.deepEqual(result.music.notes.map(note => note.instrument).sort(), ['bass', 'harp', 'harp'])
})

test('compiles dense source MIDI beyond 20000 onsets when mapped notes deduplicate to a bounded track', () => {
  const rawNotes = Array.from({ length: 47903 }, () => event(0, 144, 60, 100))
  const result = compile(midi([[...rawNotes, end(0)]]))
  assert.equal(result.music.sourceNoteCount, 47903)
  assert.equal(result.music.noteCount, 1)
  assert.equal(result.music.deduplicatedNotes, 47902)
  assert.equal(result.music.moduleCount, 1)
  assert.deepEqual(result.music.size, { x: 6, y: 5, z: 29 })
})

test('supports a full 52-note chord with isolated side branches and free air above every note', async t => {
  const notes = []
  for (const [channel, program, base] of [[0, 0, 54], [1, 24, 42], [2, 32, 30]]) {
    notes.push(event(0, 192 | channel, program))
    for (let pitch = base; pitch <= base + 24 && notes.filter(message => (message[1] & 240) === 144).length < 52; pitch++) notes.push(event(0, 144 | channel, pitch, 100))
  }
  notes.push(end(0))
  const result = compile(midi([notes]))
  assert.equal(result.music.noteCount, 52)
  const plan = await planFor(t, result)
  const cells = new Map(plan.tasks.map(task => [task.id, task.name]))
  assert.equal(plan.tasks.filter(task => task.name === 'note_block').length, 52)
  for (const note of result.music.notes) {
    assert.ok(Math.abs(note.pos.z - 14) >= 1 && Math.abs(note.pos.z - 14) <= 13)
    assert.ok(note.pos.x === 2 || note.pos.x === 4)
    assert.equal(cells.has(`${note.pos.x},3,${note.pos.z}`), false)
  }
})

test('roundtrips palettes above 127 entries using Sponge varints and rejects only excessive simultaneous voices', async t => {
  const events = []
  for (const [program, base] of [[0, 54], [8, 78], [16, 54], [24, 42], [32, 30], [72, 66]]) {
    events.push(event(96, 192, program))
    for (let note = 0; note < 25; note++) events.push(event(0, 144, base + note, 100))
  }
  events.push(end(0))
  const result = compile(midi([events]))
  assert.equal(result.music.noteCount, 150)
  const { parsed } = await nbt.parse(result.schematic)
  assert.ok(nbt.simplify(parsed).PaletteMax > 127)
  const plan = await planFor(t, result)
  const Block = require('prismarine-block')('1.21.11')
  const actual = new Map(plan.tasks.filter(task => task.name === 'note_block').map(task => [task.id, Block.fromStateId(task.state, 0).getProperties()]))
  assert.equal(actual.size, 150)
  for (const note of result.music.notes) {
    const properties = actual.get(`${note.pos.x},${note.pos.y},${note.pos.z}`)
    assert.equal(properties.instrument, note.instrument)
    assert.equal(Number(properties.note), note.note)
  }
})

test('rejects unsupported or malformed MIDI explicitly instead of partially compiling', () => {
  const valid = midi([[event(0, 144, 60, 100), end(0)]])
  assert.throws(() => compile(Buffer.from('invalid')), /MIDI|MThd/)
  assert.throws(() => compile(valid.subarray(0, -1)), /截断|长度|完整/)
  assert.throws(() => compile(midi([[end(0)]], { format: 2 })), /格式 2|format 2/)
  assert.throws(() => compile(midi([[end(0)]], { division: 0xe728 })), /SMPTE/)
  assert.throws(() => compile(midi([[end(0)]], { division: 0 })), /PPQ|分辨率/)
  assert.throws(() => compile(midi([[end(0)]])), /没有.*音符/)
  assert.throws(() => compile(midi([[event(0, 60, 100), end(0)]])), /running status|运行状态/)
  assert.throws(() => compile(midi([[[128, 128, 128, 128, 0], end(0)]])), /VLQ|变长/)
  assert.throws(() => compile(midi([[event(0, 144, 60, 255), end(0)]])), /数据字节/)
  assert.throws(() => compile(midi([[event(0, 255, 81, 2, 0, 1), end(0)]])), /速度|tempo/)
  assert.throws(() => compile(midi([[tempo(0, 0), event(0, 144, 60, 100), end(0)]])), /速度|tempo/)
  assert.throws(() => compile(midi([[event(0, 144, 60, 100), event(0, 255, 1, 0), event(0, 62, 100), end(0)]])), /running status|运行状态/)
  assert.throws(() => compile(midi([[event(0, 144, 60, 100), event(0, 240, 1, 247), event(0, 62, 100), end(0)]])), /running status|运行状态/)
  assert.throws(() => compile(midi([[event(0, 144, 60, 100), end(0), event(0, 144, 62, 100)]])), /结束|End of Track/)
  assert.throws(() => compile(midi([[end(0)], [end(0)]], { format: 0 })), /轨道数量/)
  assert.throws(() => compile(Buffer.concat([valid, Buffer.from([0])])), /多余/)
  assert.throws(() => compile(midi([[event(0, 144, 60, 100)]])), /结束|End of Track/)
})

test('skips bounded alien chunks while enforcing declared track counts and complete chunk lengths', () => {
  const valid = midi([[event(0, 144, 60, 100), end(0)]])
  const alien = Buffer.from('4a554e4b0000000100', 'hex')
  const before = Buffer.concat([valid.subarray(0, 14), alien, valid.subarray(14)])
  const after = Buffer.concat([valid, alien])
  assert.equal(compile(before).music.noteCount, 1)
  assert.equal(compile(after).music.noteCount, 1)
  const twoTracks = midi([[tempo(0, 500000), end(0)], [event(0, 144, 60, 100), end(0)]])
  const secondTrack = 22 + twoTracks.readUInt32BE(18)
  const between = Buffer.concat([twoTracks.subarray(0, secondTrack), alien, twoTracks.subarray(secondTrack)])
  assert.equal(compile(between).music.noteCount, 1)
  assert.throws(() => compile(Buffer.concat([valid, alien.subarray(0, -1)])), /截断|完整|长度/)
  assert.throws(() => compile(Buffer.concat([valid, alien.subarray(0, 5)])), /截断|完整|长度|多余/)
  assert.throws(() => compile(Buffer.concat([valid.subarray(0, 14), alien])), /轨道.*缺失|轨道数量/)
  assert.throws(() => compile(Buffer.concat([valid, valid.subarray(14)])), /轨道数量|轨道.*超过/)
})

test('reads long VLQs and skips bounded metadata and sysex without inventing notes', () => {
  const result = compile(midi([[
    event(0, 255, 3, 5, 84, 105, 116, 108, 101),
    event(0, 240, 3, 1, 2, 247),
    event(15360, 144, 54, 100), end(0)
  ]]))
  assert.equal(result.music.sourceNoteCount, 1)
  assert.equal(result.music.notes[0].timeSeconds, 16)
  assert.equal(result.music.notes[0].step, 160)
  assert.equal(result.music.playbackDurationSeconds, 16.1)
})

test('enforces duration, note-count and simultaneous voice limits without silent truncation', () => {
  assert.equal(compile(midi([[event(0, 144, 60, 100), end(480 * 600)]])).music.durationSeconds, 300)
  assert.throws(() => compile(midi([[event(0, 144, 60, 100), end(480 * 602)]])), /300.*秒/)
  const tooMany = Array.from({ length: 100001 }, () => event(0, 144, 60, 100))
  assert.throws(() => compile(midi([[...tooMany, end(0)]])), /100000|100,000/)
  const chord = [event(0, 192, 0), ...Array.from({ length: 25 }, (_, n) => event(0, 144, 54 + n, 100)),
    event(0, 193, 24), ...Array.from({ length: 25 }, (_, n) => event(0, 145, 42 + n, 100)),
    event(0, 194, 32), ...Array.from({ length: 3 }, (_, n) => event(0, 146, 30 + n, 100)), end(0)]
  assert.throws(() => compile(midi([chord])), /52.*和弦|和弦.*52/)
})

test('retains file-byte and total-event limits for dense MIDI', () => {
  const { parseMidi } = require('../lib/midiParser')
  assert.throws(() => parseMidi(Buffer.alloc(8 * 1024 * 1024 + 1)), /8 MiB/)
  const controllers = Array.from({ length: 199998 }, () => event(0, 176, 7, 100))
  assert.equal(parseMidi(midi([[event(0, 144, 60, 100), ...controllers, end(0)]])).sourceNoteCount, 1)
  assert.throws(() => parseMidi(midi([[event(0, 144, 60, 100), ...controllers, event(0, 176, 7, 100), end(0)]])), /200000/)
})

test('ignores only legacy CC7 volume 255 sentinels, reports their count and preserves notes and timing', () => {
  const sentinels = Array.from({ length: 16 }, (_, channel) => event(0, 176 | channel, 7, 255))
  const input = midi([[...sentinels, event(144, 144, 60, 100), event(480, 144, 64, 90), end(0)]])
  const original = Buffer.from(input)
  const result = compile(input)
  const reference = compile(midi([[event(144, 144, 60, 100), event(480, 144, 64, 90), end(0)]]))
  assert.deepEqual(input, original)
  assert.deepEqual(result.music.notes, reference.music.notes)
  assert.deepEqual(result.music.modules, reference.music.modules)
  assert.equal(result.music.durationSeconds, reference.music.durationSeconds)
  assert.ok(result.music.warnings.some(warning => /16.*非法音量值.*忽略.*音符和节拍未改/.test(warning)))
  const parsed = require('../lib/midiParser').parseMidi(input)
  assert.equal(parsed.warnings.length, 1)
  assert.match(parsed.warnings[0], /16.*CC7=255/)
  for (const bytes of [[176, 7, 128], [176, 7, 254], [176, 8, 255], [176, 128, 255], [144, 60, 255]]) {
    assert.throws(() => compile(midi([[event(0, ...bytes), event(0, 144, 60, 100), end(0)]])), /数据字节/)
  }
})
