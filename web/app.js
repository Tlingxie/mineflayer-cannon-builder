/* global fetch, document, window, AbortController, ResizeObserver */
'use strict'

const element = id => document.getElementById(id)
const activeStatuses = new Set(['preparing', 'running', 'stopping'])
const statusLabels = { preparing: '准备中', running: '施工中', stopping: '正在停止', cancelled: '已停止', completed: '已完成', failed: '未完成' }
const numberFormat = new Intl.NumberFormat('zh-CN')
const state = {
  config: null,
  blueprint: null,
  job: null,
  uploading: false,
  uploadSequence: 0,
  uploadController: null,
  starting: false,
  stopping: false,
  connected: false,
  lastLogSignature: '',
  statusRevision: 0,
  stopError: ''
}

const formatNumber = value => Number.isFinite(value) ? numberFormat.format(value) : '—'
const isActive = () => Boolean(state.job && activeStatuses.has(state.job.status))
const setText = (id, text) => { element(id).textContent = text }

function notice (id, message) {
  element(id).textContent = message || ''
  element(id).hidden = !message
}

async function request (url, options = {}) {
  const headers = { ...options.headers }
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = state.config.csrfToken
  const response = await fetch(url, { ...options, headers, cache: 'no-store' })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `请求未完成（${response.status}），请稍后重试。`)
  return body
}

function origin () {
  return { x: Number(element('origin-x').value), y: Number(element('origin-y').value), z: Number(element('origin-z').value) }
}

function minimumOrigin () {
  const coordinates = origin()
  const sourceMin = state.blueprint && state.blueprint.sourceMin
  if (element('origin-mode').value === 'schematic' && sourceMin) {
    return { x: coordinates.x + sourceMin.x, y: coordinates.y + sourceMin.y, z: coordinates.z + sourceMin.z }
  }
  return coordinates
}

function validateBuild () {
  if (!state.blueprint) return '请先选择一份蓝图。'
  const coordinates = origin()
  if (['x', 'y', 'z'].some(axis => element(`origin-${axis}`).value.trim() === '' || !Number.isSafeInteger(coordinates[axis]))) return '原点 X、Y、Z 需要填写整数。'
  const bots = Number(element('bot-count').value)
  if (!Number.isInteger(bots) || bots < 1 || bots > 30) return '建造队人数需要在 1 到 30 之间。'
  const minimum = minimumOrigin()
  const dimensions = state.blueprint.dimensions
  if (dimensions && (minimum.y < -64 || minimum.y + dimensions.y > 320)) return '蓝图超出了主世界高度范围（Y = -64 至 319），请调整原点 Y。'
  if (Math.abs(minimum.x) > 29999984 || Math.abs(minimum.z) > 29999984 || (dimensions && (minimum.x + dimensions.x > 29999984 || minimum.z + dimensions.z > 29999984))) return '施工范围超出了世界边界，请调整 X、Z 坐标。'
  if (state.blueprint.requiresAlignment) {
    const sourceMin = state.blueprint.sourceMin || { x: 0, y: 0, z: 0 }
    const schematicOrigin = element('origin-mode').value === 'schematic' ? coordinates : { x: coordinates.x - sourceMin.x, y: coordinates.y - sourceMin.y, z: coordinates.z - sourceMin.z }
    if (['x', 'y', 'z'].some(axis => schematicOrigin[axis] % 16 !== 0)) return '这份轨道炮需要对齐：蓝图原点 X、Y、Z 都必须能被 16 整除。'
  }
  return null
}

function updateControls () {
  const active = isActive()
  const locked = active || state.starting
  const uploadLocked = locked || !state.config || state.uploading
  element('configuration-fields').disabled = locked || !state.config
  element('blueprint-input').disabled = uploadLocked
  element('drop-zone').classList.toggle('is-disabled', uploadLocked)
  element('drop-zone').setAttribute('aria-disabled', String(uploadLocked))
  element('drop-zone').tabIndex = uploadLocked ? -1 : 0
  element('start-build').disabled = !state.connected || !state.config || !state.blueprint || state.uploading || locked
  setText('start-label', state.starting ? '正在启动建造队…' : active ? '建造队正在施工' : state.uploading ? '正在解析蓝图…' : state.blueprint ? '开始施工' : '选择蓝图后开始施工')
  element('stop-build').hidden = !active
  element('stop-build').disabled = state.stopping || (state.job && state.job.status === 'stopping') || !state.connected
  setText('stop-label', state.stopping || (state.job && state.job.status === 'stopping') ? '正在停止…' : '停止施工')
}

function updateHeight () {
  if (!state.blueprint || !state.blueprint.dimensions) return
  const minimum = minimumOrigin()
  const height = state.blueprint.dimensions.y
  setText('blueprint-height', Number.isFinite(minimum.y) ? `${minimum.y} → ${minimum.y + height - 1}` : '—')
}

function showBlueprint () {
  const blueprint = state.blueprint
  const hasDimensions = blueprint && blueprint.dimensions
  setText('blueprint-name', blueprint ? blueprint.name || blueprint.filename : '尚未选择蓝图')
  setText('blueprint-dimensions', hasDimensions ? `${formatNumber(blueprint.dimensions.x)} × ${formatNumber(blueprint.dimensions.y)} × ${formatNumber(blueprint.dimensions.z)} 方块 · X / Y / Z` : '支持 Litematica 与 Sponge 蓝图')
  setText('blueprint-blocks', blueprint ? formatNumber(blueprint.activeBlocks ?? blueprint.blocks) : '—')
  setText('blueprint-layers', blueprint ? formatNumber(blueprint.layers) : '—')
  setText('blueprint-height', '—')
  const extension = blueprint && blueprint.filename ? blueprint.filename.split('.').pop().toUpperCase() : ''
  setText('blueprint-file-badge', extension)
  element('blueprint-file-badge').hidden = !extension
  notice('blueprint-warnings', blueprint && Array.isArray(blueprint.warnings) ? blueprint.warnings.join(' ') : '')
  const schematicOption = element('origin-mode').querySelector('option[value="schematic"]')
  schematicOption.disabled = Boolean(blueprint && !blueprint.sourceMin)
  if (schematicOption.disabled) element('origin-mode').value = 'minimum'
  setText('origin-help', blueprint && !blueprint.sourceMin ? '这份蓝图不含原点偏移，以上坐标作为包围盒最小角。' : 'Mk6 轨道炮的蓝图原点 X、Y、Z 都需要能被 16 整除。')
  updateHeight()
  drawPreview()
}

function drawPreview () {
  const blueprint = state.blueprint
  const points = blueprint && blueprint.preview
  const hasPreview = Array.isArray(points) && points.length > 0
  const canvas = element('blueprint-preview')
  canvas.hidden = !hasPreview
  element('preview-empty').hidden = hasPreview
  element('preview-caption').hidden = !hasPreview
  if (!hasPreview) {
    const label = element('preview-empty').querySelector('strong')
    const description = element('preview-empty').querySelector('span')
    label.textContent = blueprint ? '蓝图已就绪' : '工地等待第一张蓝图'
    description.textContent = blueprint ? '详细规模与施工范围见下方' : '上传后查看规模与施工范围'
    return
  }
  const size = element('blueprint-stage').getBoundingClientRect()
  const density = window.devicePixelRatio || 1
  canvas.width = Math.round(size.width * density)
  canvas.height = Math.round(size.height * density)
  const context = canvas.getContext('2d')
  context.scale(density, density)
  const validPoints = points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.z))
  if (!validPoints.length) return
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of validPoints) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minZ = Math.min(minZ, point.z)
    maxZ = Math.max(maxZ, point.z)
    const y = Number.isFinite(point.y) ? point.y : 0
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }
  const scale = Math.min((size.width - 90) / (maxX - minX + 1), (size.height - 64) / (maxZ - minZ + 1), 18)
  const offsetX = (size.width - (maxX - minX + 1) * scale) / 2
  const offsetZ = (size.height - (maxZ - minZ + 1) * scale) / 2 - 3
  const sorted = [...validPoints].sort((a, b) => (a.y || 0) - (b.y || 0))
  for (const point of sorted) {
    const height = ((point.y || 0) - minY) / Math.max(1, maxY - minY)
    context.fillStyle = `hsl(${100 + height * 30} 22% ${65 - height * 32}%)`
    const gap = scale > 3 ? Math.min(1, scale * 0.12) : 0
    context.fillRect(offsetX + (point.x - minX) * scale, offsetZ + (point.z - minZ) * scale, Math.max(1, scale - gap), Math.max(1, scale - gap))
  }
}

async function uploadBlueprint (file) {
  if (!file || isActive() || state.starting || !state.config) return
  if (state.uploading) return notice('form-error', '正在解析当前蓝图，请等解析完成后再更换。')
  if (!/\.(litematic|schem)$/i.test(file.name)) return notice('form-error', '请选择 .litematic 或 .schem 格式的蓝图。')
  if (file.size > state.config.maxUploadBytes) return notice('form-error', `蓝图文件过大，请选择不超过 ${Math.floor(state.config.maxUploadBytes / 1024 / 1024)} MB 的文件。`)
  if (file.size === 0) return notice('form-error', '这份文件是空的，请重新选择蓝图。')
  if (state.uploadController) state.uploadController.abort()
  const sequence = ++state.uploadSequence
  state.uploadController = new AbortController()
  state.uploading = true
  state.blueprint = null
  notice('form-error', '')
  showBlueprint()
  setText('upload-title', file.name)
  setText('upload-subtitle', '正在读取方块与施工层…')
  setText('upload-state', '解析中')
  element('drop-zone').classList.add('is-loading')
  element('drop-zone').classList.remove('is-selected')
  element('file-summary').hidden = true
  updateControls()
  try {
    const blueprint = await request(`/api/blueprints?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal: state.uploadController.signal })
    if (sequence !== state.uploadSequence) return
    state.blueprint = blueprint
    setText('upload-title', blueprint.filename || file.name)
    setText('upload-subtitle', '点击或拖入文件以更换蓝图')
    setText('upload-state', '已就绪')
    setText('file-summary', `${formatNumber(blueprint.blocks)} 个方块 · ${formatNumber(blueprint.layers)} 层${blueprint.derivedBlocks ? ` · ${formatNumber(blueprint.derivedBlocks)} 个由游戏自然生成` : ''}`)
    element('file-summary').hidden = false
    element('drop-zone').classList.add('is-selected')
    showBlueprint()
  } catch (error) {
    if (sequence !== state.uploadSequence || error.name === 'AbortError') return
    notice('form-error', error.message)
    setText('upload-subtitle', '解析未完成，点击或拖入其他蓝图')
    setText('upload-state', '请重新选择')
  } finally {
    if (sequence === state.uploadSequence) {
      state.uploading = false
      element('drop-zone').classList.remove('is-loading')
      updateControls()
    }
  }
}

function renderLogs (logs, jobId) {
  const rows = Array.isArray(logs) ? logs : []
  const signature = JSON.stringify([jobId, rows])
  if (signature === state.lastLogSignature) return
  state.lastLogSignature = signature
  setText('log-count', `${rows.length} 条`)
  const output = element('log-output')
  const follow = output.scrollTop + output.clientHeight >= output.scrollHeight - 35
  output.replaceChildren()
  if (!rows.length) {
    const placeholder = document.createElement('p')
    placeholder.className = 'log-empty'
    placeholder.textContent = jobId ? '等待建造队回传记录…' : '任务启动后，连接、放置与验证记录会显示在这里。'
    output.append(placeholder)
    return
  }
  for (const log of rows) {
    const line = document.createElement('div')
    line.className = 'log-line'
    if (log.level === 'error') line.classList.add('is-error')
    if (log.level === 'warn' || log.level === 'warning') line.classList.add('is-warn')
    const time = document.createElement('span')
    time.className = 'log-time'
    const date = new Date(log.time)
    time.textContent = Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString('zh-CN', { hour12: false })
    const message = document.createElement('span')
    message.className = 'log-message'
    message.textContent = String(log.message || '')
    line.append(time, message)
    output.append(line)
  }
  if (follow) output.scrollTop = output.scrollHeight
}

function elapsedLabel (seconds) {
  if (!Number.isFinite(seconds)) return '—'
  const safe = Math.max(0, Math.floor(seconds))
  if (safe < 60) return `${safe} 秒`
  if (safe < 3600) return `${Math.floor(safe / 60)} 分 ${safe % 60} 秒`
  return `${Math.floor(safe / 3600)} 时 ${Math.floor(safe % 3600 / 60)} 分`
}

function renderJob (job) {
  const previousId = state.job && state.job.id
  state.job = job
  const progress = (job && job.progress) || {}
  const completed = Number.isFinite(progress.completed) ? progress.completed : 0
  const total = Number.isFinite(progress.total) ? progress.total : 0
  const percentage = total > 0 ? Math.min(100, Math.max(0, completed / total * 100)) : 0
  const displayedPercentage = percentage > 0 && percentage < 1 ? '<1%' : `${Math.floor(percentage)}%`
  setText('job-status', job ? statusLabels[job.status] || job.status : '待命')
  element('job-status').className = 'job-status'
  if (job && Object.hasOwn(statusLabels, job.status)) element('job-status').classList.add(`is-${job.status}`)
  setText('progress-count', formatNumber(completed))
  setText('progress-total', ` / ${total ? formatNumber(total) : '—'} 块已验证`)
  setText('progress-percent', displayedPercentage)
  element('progress-fill').style.width = `${percentage}%`
  element('progress-bar').setAttribute('aria-valuenow', String(Math.floor(percentage)))
  setText('current-layer', formatNumber(progress.layer))
  setText('completed-layers', job ? `${formatNumber(progress.completedLayers)} / ${formatNumber(progress.totalLayers)}` : '—')
  setText('connected-bots-label', job && !isActive() ? '参与 bot' : '已连接 bot')
  setText('connected-bots', job ? `${formatNumber(progress.connectedBots)} / ${formatNumber(job.bots)}` : '—')
  setText('elapsed-time', elapsedLabel(progress.elapsedSeconds))
  element('job-context').hidden = !job
  if (job) {
    const name = job.blueprint?.name || job.blueprint?.filename || '施工任务'
    const coordinates = job.origin ? `${job.origin.x}, ${job.origin.y}, ${job.origin.z}` : '—'
    const detail = `${job.originMode === 'minimum' ? '最小角' : '原点'} (${coordinates}) · ${job.bots} bot`
    setText('job-name', name)
    setText('job-origin', detail)
    element('job-context').title = `${name} · ${detail}`
  }
  const descriptions = {
    preparing: '建造队正在连接服务器并飞往施工位置。',
    running: '先完成并验证当前层，再一起进入上一层。',
    stopping: '正在停止放置并退出建造队，请等待所有 bot 离线。',
    cancelled: '建造队已退出。已完成的方块保留在现场。',
    completed: '本次施工已完成并通过最终验证。',
    failed: '本次施工未完成，请查看下方原因与施工日志。'
  }
  setText('job-description', job ? descriptions[job.status] || '正在获取任务状态。' : '准备好蓝图后，即可开始第一层。')
  notice('job-error', (job && job.error) || state.stopError)
  if (job && job.id !== previousId) {
    if (job.origin && isActive()) {
      for (const axis of ['x', 'y', 'z']) element(`origin-${axis}`).value = job.origin[axis]
    }
    if (job.originMode && isActive()) element('origin-mode').value = job.originMode
    if (job.bots && isActive()) {
      element('bot-count').value = job.bots
      element('bot-slider').value = job.bots
    }
    if (isActive() && state.blueprint && state.blueprint.id !== job.blueprint?.id) {
      state.blueprint = null
      showBlueprint()
    }
    if (isActive() && state.uploading) {
      state.uploadController.abort()
      state.uploadSequence++
      state.uploading = false
      element('drop-zone').classList.remove('is-loading')
    }
  }
  if (job && !state.blueprint && !state.uploading && job.blueprint) {
    setText('blueprint-name', job.blueprint.name || job.blueprint.filename || '施工蓝图')
    setText('blueprint-dimensions', isActive() ? '已恢复正在进行的任务' : '上次施工使用的蓝图 · 可重新上传以开始新任务')
    setText('blueprint-blocks', formatNumber(total))
    setText('blueprint-layers', formatNumber(progress.totalLayers))
    setText('upload-title', job.blueprint.filename || job.blueprint.name || '施工蓝图')
    setText('upload-subtitle', isActive() ? '已恢复正在进行的任务' : '重新上传蓝图以新建任务')
    setText('upload-state', isActive() ? '使用中' : '上次任务')
  }
  renderLogs(job && job.logs, job && job.id)
  updateControls()
}

async function pollStatus () {
  const revision = state.statusRevision
  try {
    const result = await request('/api/status')
    if (revision !== state.statusRevision) return
    state.connected = true
    notice('connection-error', '')
    const server = result.server || {}
    setText('server-status', server.status === 'online' ? '服务器在线' : server.status === 'offline' ? '服务器离线' : '服务器待检测')
    element('server-badge').className = `server-badge${server.status === 'online' ? ' is-online' : server.status === 'offline' ? ' is-offline' : ''}`
    element('server-badge').title = server.error || `${server.host || '127.0.0.1'}:${server.port || 25566}`
    renderJob(result.job || null)
  } catch (error) {
    if (revision !== state.statusRevision) return
    state.connected = false
    setText('server-status', '控制台连接中断')
    element('server-badge').className = 'server-badge is-offline'
    notice('connection-error', `暂时无法连接建造控制台，正在重连。${isActive() ? ' 施工可能仍在继续，请等待状态恢复。' : ''}`)
    updateControls()
  } finally {
    window.setTimeout(pollStatus, 1000)
  }
}

element('build-form').addEventListener('submit', async event => {
  event.preventDefault()
  if (state.starting || isActive() || state.uploading || !state.connected) return
  const error = validateBuild()
  if (error) return notice('form-error', error)
  notice('form-error', '')
  state.stopError = ''
  state.statusRevision++
  state.starting = true
  updateControls()
  try {
    const job = await request('/api/builds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blueprintId: state.blueprint.id, origin: origin(), originMode: element('origin-mode').value, bots: Number(element('bot-count').value) })
    })
    state.statusRevision++
    renderJob(job)
  } catch (error) {
    notice('form-error', error.message)
  } finally {
    state.starting = false
    updateControls()
  }
})

element('stop-build').addEventListener('click', async () => {
  if (!isActive() || state.stopping || state.job.status === 'stopping') return
  state.stopError = ''
  state.statusRevision++
  state.stopping = true
  updateControls()
  try {
    const job = await request(`/api/builds/${encodeURIComponent(state.job.id)}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    state.statusRevision++
    renderJob(job)
  } catch (error) {
    state.stopError = error.message
    notice('job-error', error.message)
  } finally {
    state.stopping = false
    updateControls()
  }
})

element('blueprint-input').addEventListener('change', event => {
  uploadBlueprint(event.target.files[0])
  event.target.value = ''
})
element('drop-zone').addEventListener('keydown', event => {
  if (event.target !== element('drop-zone') || isActive() || state.starting || state.uploading || !state.config) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    element('blueprint-input').click()
  }
})
for (const name of ['dragenter', 'dragover']) {
  element('drop-zone').addEventListener(name, event => {
    event.preventDefault()
    if (!isActive() && !state.starting && !state.uploading && state.config) element('drop-zone').classList.add('is-dragover')
  })
}
element('drop-zone').addEventListener('dragleave', event => {
  if (!element('drop-zone').contains(event.relatedTarget)) element('drop-zone').classList.remove('is-dragover')
})
element('drop-zone').addEventListener('drop', event => {
  event.preventDefault()
  element('drop-zone').classList.remove('is-dragover')
  if (event.dataTransfer.files.length !== 1) return notice('form-error', '每次请选择一份蓝图。')
  uploadBlueprint(event.dataTransfer.files[0])
})
window.addEventListener('dragover', event => { event.preventDefault() })
window.addEventListener('drop', event => { event.preventDefault() })
element('bot-slider').addEventListener('input', event => { element('bot-count').value = event.target.value })
element('bot-count').addEventListener('input', event => {
  const value = Number(event.target.value)
  if (Number.isInteger(value) && value >= 1 && value <= 30) element('bot-slider').value = value
})
for (const id of ['origin-x', 'origin-y', 'origin-z', 'origin-mode']) {
  element(id).addEventListener('input', () => {
    updateHeight()
    notice('form-error', '')
  })
}
element('toggle-logs').addEventListener('click', () => {
  const output = element('log-output')
  output.hidden = !output.hidden
  element('toggle-logs').setAttribute('aria-expanded', String(!output.hidden))
  setText('toggle-logs', output.hidden ? '展开日志' : '收起日志')
})
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(drawPreview).observe(element('blueprint-stage'))

async function initialize () {
  updateControls()
  try {
    state.config = await request('/api/config')
    const defaults = state.config.defaults || {}
    if (defaults.origin) {
      for (const axis of ['x', 'y', 'z']) element(`origin-${axis}`).value = defaults.origin[axis]
    }
    if (defaults.bots) {
      element('bot-count').value = defaults.bots
      element('bot-slider').value = defaults.bots
    }
    setText('server-address', `${defaults.host || '127.0.0.1'}:${defaults.port || 25566}`)
    setText('upload-size-limit', `最大 ${Math.floor(state.config.maxUploadBytes / 1024 / 1024)} MB`)
    updateControls()
    pollStatus()
  } catch (error) {
    setText('server-status', '控制台连接中断')
    notice('connection-error', '建造控制台暂时无法连接，正在重试。')
    window.setTimeout(initialize, 3000)
  }
}

initialize()
