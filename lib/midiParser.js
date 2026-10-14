const MAX_BYTES = 8 * 1024 * 1024
const MAX_EVENTS = 200000
const MAX_NOTES = 20000
const MAX_SECONDS = 300

function parseMidi (buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('MIDI 必须是二进制文件')
  if (buffer.length > MAX_BYTES) throw new Error('MIDI 文件不能超过 8 MiB')
  if (buffer.length < 14 || buffer.toString('ascii', 0, 4) !== 'MThd') throw new Error('无效 MIDI：缺少 MThd 文件头')
  const headerLength = buffer.readUInt32BE(4)
  if (headerLength < 6 || headerLength > buffer.length - 8) throw new Error('MIDI 文件头长度无效或已截断')
  const format = buffer.readUInt16BE(8)
  const trackCount = buffer.readUInt16BE(10)
  const division = buffer.readUInt16BE(12)
  if (format === 2) throw new Error('暂不支持 MIDI 格式 2，请导出为格式 0 或格式 1')
  if (format > 1) throw new Error(`不支持 MIDI 格式 ${format}`)
  if (!trackCount || trackCount > 128 || (format === 0 && trackCount !== 1)) throw new Error('MIDI 轨道数量无效，最多支持 128 轨')
  if (division & 0x8000) throw new Error('暂不支持 SMPTE 时间格式，请导出为 PPQ 格式 MIDI')
  if (!division) throw new Error('MIDI PPQ 时间分辨率必须大于 0')

  const events = []
  let cursor = 8 + headerLength
  let eventCount = 0
  let sourceNoteCount = 0
  let ignoredVolumeValues = 0
  let maxTick = 0
  let tracksRead = 0
  while (cursor < buffer.length) {
    if (cursor + 8 > buffer.length) throw new Error('MIDI chunk 头不完整或存在多余数据')
    const chunkType = buffer.toString('ascii', cursor, cursor + 4)
    const chunkLength = buffer.readUInt32BE(cursor + 4)
    cursor += 8
    const trackEnd = cursor + chunkLength
    if (trackEnd > buffer.length) throw new Error('MIDI chunk 长度超出文件，文件已截断')
    if (chunkType !== 'MTrk') {
      cursor = trackEnd
      continue
    }
    if (tracksRead >= trackCount) throw new Error('MIDI 轨道数量超过文件头声明')
    const track = tracksRead++
    let tick = 0
    let running = 0
    let ended = false
    let order = 0
    const byte = () => {
      if (cursor >= trackEnd) throw new Error('MIDI 事件数据已截断')
      return buffer[cursor++]
    }
    const variable = () => {
      let value = 0
      for (let i = 0; i < 4; i++) {
        const next = byte()
        value = value * 128 + (next & 127)
        if (!(next & 128)) return value
      }
      throw new Error('MIDI VLQ 变长数超过 4 字节')
    }
    const skip = length => {
      if (cursor + length > trackEnd) throw new Error('MIDI 事件长度超出轨道，文件已截断')
      cursor += length
    }
    while (cursor < trackEnd) {
      if (++eventCount > MAX_EVENTS) throw new Error(`MIDI 事件数量超过 ${MAX_EVENTS}`)
      if (ended) throw new Error('MIDI End of Track 结束标记后仍有事件')
      tick += variable()
      if (!Number.isSafeInteger(tick)) throw new Error('MIDI 时间位置超出安全范围')
      maxTick = Math.max(maxTick, tick)
      let status = byte()
      if (status < 128) {
        if (!running) throw new Error('MIDI running status 运行状态缺失')
        status = running
        cursor--
      }
      if (status === 255) {
        running = 0
        const type = byte()
        const length = variable()
        if (type === 81) {
          if (length !== 3) throw new Error('MIDI tempo 速度事件必须包含 3 字节')
          const microseconds = byte() * 65536 + byte() * 256 + byte()
          if (!microseconds) throw new Error('MIDI tempo 速度不能为 0')
          events.push({ type: 'tempo', microseconds, tick, track, order })
        } else if (type === 47) {
          if (length !== 0) throw new Error('MIDI End of Track 结束标记长度必须为 0')
          ended = true
        } else skip(length)
      } else if (status === 240 || status === 247) {
        running = 0
        skip(variable())
      } else if (status >= 128 && status <= 239) {
        running = status
        const kind = status >> 4
        const channel = status & 15
        const data1 = byte()
        const data2 = kind === 12 || kind === 13 ? 0 : byte()
        const legacyVolume = kind === 11 && data1 === 7 && data2 === 255
        if (data1 > 127 || (data2 > 127 && !legacyVolume)) throw new Error('MIDI 通道事件包含无效数据字节')
        if (legacyVolume) ignoredVolumeValues++
        if (kind === 12) events.push({ type: 'program', program: data1, channel, tick, track, order })
        if (kind === 9 && data2 > 0) {
          if (++sourceNoteCount > MAX_NOTES) throw new Error(`MIDI 音符数量超过 ${MAX_NOTES}，请拆分文件`)
          events.push({ type: 'note', midi: data1, velocity: data2, channel, tick, track, order })
        }
      } else throw new Error(`不支持的 MIDI 系统事件 0x${status.toString(16)}`)
      order++
    }
    if (!ended) throw new Error('MIDI 轨道缺少 End of Track 结束标记')
  }
  if (tracksRead !== trackCount) throw new Error('MIDI 声明轨道缺失，轨道数量不符')
  events.sort((a, b) => a.tick - b.tick || a.track - b.track || a.order - b.order)
  const programs = Array(16).fill(0)
  const notes = []
  let currentTick = 0
  let microticks = 0
  let microseconds = 500000
  for (const event of events) {
    microticks += (event.tick - currentTick) * microseconds
    currentTick = event.tick
    const seconds = microticks / division / 1000000
    if (seconds > MAX_SECONDS) throw new Error(`MIDI 时长超过 ${MAX_SECONDS} 秒，请拆分文件`)
    if (event.type === 'tempo') microseconds = event.microseconds
    if (event.type === 'program') programs[event.channel] = event.program
    if (event.type === 'note') notes.push({ ...event, timeSeconds: seconds, microticks, program: programs[event.channel] })
  }
  microticks += (maxTick - currentTick) * microseconds
  const seconds = microticks / division / 1000000
  if (seconds > MAX_SECONDS) throw new Error(`MIDI 时长超过 ${MAX_SECONDS} 秒，请拆分文件`)
  if (!notes.length) throw new Error('MIDI 没有可播放的音符')
  const warnings = ignoredVolumeValues ? [`${ignoredVolumeValues} 个遗留 MIDI 非法音量值（CC7=255）已忽略；音符和节拍未改。`] : []
  return { notes, sourceNoteCount, durationSeconds: seconds, format, trackCount, ppq: division, warnings }
}

module.exports = { parseMidi }
