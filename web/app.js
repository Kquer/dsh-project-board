/* dsh-project-board — standalone browser board.
 * No framework, no build step. Data comes from /project-board/api/* with a token.
 */
const $ = id => document.getElementById(id)
const params = new URLSearchParams(location.search)
const TOKEN = params.get('token') || ''
const SVGNS = 'http://www.w3.org/2000/svg'

const STATUS = {
  done: { label: '已完成', color: '#2ea121' },
  partial: { label: '进行中', color: '#d97706' },
  todo: { label: '未开始', color: '#8f959e' },
  unknown: { label: '待确认', color: '#3370ff' },
  blocked: { label: '受阻', color: '#d93026' },
}

const CONCERNS = {
  gameplay: { label: '玩法', color: '#d97706' },
  presentation: { label: '表现', color: '#3370ff' },
  services: { label: '服务', color: '#2ea121' },
  data: { label: '数据', color: '#8b5cf6' },
  core: { label: '内核', color: '#64748b' },
  tooling: { label: '工具', color: '#0ea5e9' },
}

const EDGE_KINDS = {
  depends: { label: '依赖', color: '#9aa3af' },
  uses: { label: '使用', color: '#d97706' },
  contains: { label: '包含', color: '#3370ff' },
  event: { label: '事件', color: '#2ea121' },
}

const state = {
  token: TOKEN,
  sessionId: params.get('sessionId') || '',
  root: params.get('root') || '',
  index: null,
  loading: true,
  error: null,
  stale: false,
  view: 'docs',
  docFilter: '',
  docs: { selected: null, content: null, error: null, mtimeMs: 0, lastPath: null, renderKey: null },
  log: { content: null, error: null, mtimeMs: 0, loaded: false },
  longterm: { saving: false },
  context: { loading: false, markdown: null, error: null, renderKey: null },
  layoutLoadedFor: null,
  graph: {
    model: null,
    mode: 'arch',
    scope: null,
    subsystem: null,
    archSelected: null,
    showLater: false,
    selectedAttribute: null,
    selectedFlow: null,
    flowStep: 0,
    visible: [],
    visibleEdges: [],
    stubs: [],
    layout: null,
    manual: {},
    serverLayout: {},
    view: { x: 0, y: 0, k: 1 },
    selected: null,
    hiddenLayers: new Set(),
    hiddenStatuses: new Set(),
    search: '',
    nodeEls: new Map(),
    edgeEls: [],
    saveTimer: 0,
    frame: 0,
    dragging: null,
    panning: null,
    moved: false,
  },
}

// ---------------------------------------------------------------- utilities

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue
    node.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child)
  }
  return node
}

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVGNS, tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue
    node.setAttribute(key, String(value))
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue
    node.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child)
  }
  return node
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

function debounce(fn, ms) {
  let timer = 0
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function fmtTime(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function dirname(path) {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function posixResolve(baseDir, target) {
  const parts = baseDir === '' ? [] : baseDir.split('/')
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

function download(filename, text, type) {
  const blob = new Blob([text], { type: type || 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const link = el('a', { href: url, download: filename })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

let toastTimer = 0
function toast(message) {
  const node = $('toast')
  node.textContent = message
  node.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { node.hidden = true }, 2600)
}

function fatal(message) {
  const node = $('fatal')
  clear(node)
  node.append(el('div', { class: 'box' },
    el('h2', { text: '看板打不开' }),
    el('p', { text: message }),
  ))
  node.hidden = false
}

// --------------------------------------------------------------------- api

function apiQuery(extra) {
  const query = new URLSearchParams({ token: state.token })
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, value)
  }
  return query.toString()
}

async function api(endpoint, extra = {}) {
  const response = await fetch(`./api/${endpoint}?${apiQuery(extra)}`, { cache: 'no-store' })
  let body
  try {
    body = await response.json()
  } catch {
    throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status })
  }
  if (!response.ok || body.ok === false) {
    throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status })
  }
  return body
}

function assetUrl(path) {
  return `./api/asset?${apiQuery({ root: state.root, path })}`
}

// ------------------------------------------------------------------ markdown

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|!\[[^\]\n]*\]\([^)\s]+\)|~~[^~\n]+~~|\*[^*\n]+\*)/g

function renderMarkdown(text, sourcePath) {
  const doc = document.createDocumentFragment()
  const normalized = String(text || '').replace(/\r\n?/g, '\n')
  for (const block of parseBlocks(normalized)) {
    doc.append(renderBlock(block, sourcePath))
  }
  return doc
}

function renderInline(text, sourcePath, prefix) {
  const out = document.createDocumentFragment()
  const parts = text.split(INLINE).filter(part => part !== '')
  parts.forEach((part, index) => {
    const key = `${prefix}-${index}`
    if (part.startsWith('`') && part.endsWith('`')) {
      out.append(el('code', { text: part.slice(1, -1) }))
      return
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      out.append(el('strong', { text: part.slice(2, -2) }))
      return
    }
    if (part.startsWith('~~') && part.endsWith('~~')) {
      out.append(el('del', { text: part.slice(2, -2) }))
      return
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      out.append(el('em', { text: part.slice(1, -1) }))
      return
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(part)
    if (image !== null) {
      const src = resolveAsset(image[2], sourcePath)
      if (src !== null) {
        out.append(el('img', { src, alt: image[1], loading: 'lazy', referrerpolicy: 'no-referrer' }))
      } else {
        out.append(el('span', { text: image[1] || image[2] }))
      }
      return
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part)
    if (link !== null) {
      const label = link[1]
      const target = link[2]
      if (/^(https?:|mailto:)/i.test(target)) {
        out.append(el('a', { href: target, target: '_blank', rel: 'noreferrer noopener', text: label }))
      } else if (target.toLowerCase().split('#')[0].endsWith('.md')) {
        const resolved = posixResolve(dirname(sourcePath), target.split('#')[0])
        const exists = state.index?.docs?.some(doc => doc.path === resolved)
        out.append(exists
          ? el('a', { href: '#', text: label, onclick: event => { event.preventDefault(); openDoc(resolved) } })
          : el('span', { text: label }))
      } else {
        out.append(el('span', { text: label }))
      }
      return
    }
    out.append(document.createTextNode(part))
  })
  return out
}

function resolveAsset(target, sourcePath) {
  if (/^https?:/i.test(target)) return target
  if (target.startsWith('/') || target.startsWith('data:')) return null
  const resolved = posixResolve(dirname(sourcePath), target)
  const referenceDir = state.index?.paths?.referenceDir || 'docs/reference'
  const contextDir = state.index?.paths?.contextDir || 'docs/board'
  if (resolved.startsWith(`${contextDir}/generated/`)) {
    return `./api/context-asset?${apiQuery({ root: state.root, path: resolved })}`
  }
  if (!resolved.startsWith(`${referenceDir}/`)) return null
  return assetUrl(resolved)
}

function parseBlocks(text) {
  const lines = text.split('\n')
  const blocks = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (/^\s*$/.test(line)) { index += 1; continue }

    const fence = /^```(.*)$/.exec(line)
    if (fence !== null) {
      index += 1
      const buffer = []
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        buffer.push(lines[index])
        index += 1
      }
      index += 1
      blocks.push({ type: 'code', lang: fence[1].trim(), text: buffer.join('\n') })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      index += 1
      continue
    }

    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      index += 1
      continue
    }

    if (/^\s*>/.test(line)) {
      const buffer = []
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        buffer.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push({ type: 'quote', text: buffer.join('\n') })
      continue
    }

    if (/\|/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[index + 1])) {
      const header = splitTableRow(line)
      index += 2
      const rows = []
      while (index < lines.length && /\|/.test(lines[index]) && !/^\s*$/.test(lines[index])) {
        rows.push(splitTableRow(lines[index]))
        index += 1
      }
      blocks.push({ type: 'table', header, rows })
      continue
    }

    const listItem = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (listItem !== null) {
      const base = listItem[1].length
      const items = []
      while (index < lines.length) {
        const match = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[index])
        if (match === null || match[1].length < base) break
        items.push({
          level: Math.floor((match[1].length - base) / 2),
          ordered: /\d/.test(match[2]),
          text: match[3],
        })
        index += 1
      }
      blocks.push({ type: 'list', items })
      continue
    }

    const buffer = [line]
    index += 1
    while (
      index < lines.length &&
      !/^\s*$/.test(lines[index]) &&
      !/^```/.test(lines[index]) &&
      !/^(#{1,6})\s/.test(lines[index]) &&
      !/^\s*>/.test(lines[index]) &&
      !/^(\s*)([-*+]|\d+\.)\s+/.test(lines[index])
    ) {
      buffer.push(lines[index])
      index += 1
    }
    blocks.push({ type: 'p', text: buffer.join(' ') })
  }
  return blocks
}

function splitTableRow(line) {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|')) row = row.slice(0, -1)
  return row.split('|').map(cell => cell.trim())
}

function renderBlock(block, sourcePath) {
  if (block.type === 'heading') {
    const tag = `h${Math.min(block.level, 6)}`
    return el(tag, {}, renderInline(block.text, sourcePath, 'h'))
  }
  if (block.type === 'code') {
    return el('pre', {},
      block.lang ? el('span', { class: 'code-lang', text: block.lang === 'mermaid' ? 'mermaid（按源码显示）' : block.lang }) : null,
      el('code', { text: block.text }),
    )
  }
  if (block.type === 'hr') return el('hr')
  if (block.type === 'quote') {
    return el('blockquote', {}, renderMarkdown(block.text, sourcePath))
  }
  if (block.type === 'table') {
    return el('div', { class: 'table-wrap' },
      el('table', {},
        el('thead', {}, el('tr', {}, block.header.map((cell, i) => el('th', {}, renderInline(cell, sourcePath, `th${i}`))))),
        el('tbody', {}, block.rows.map((row, r) => el('tr', {}, row.map((cell, c) => el('td', {}, renderInline(cell, sourcePath, `td${r}${c}`)))))),
      ),
    )
  }
  if (block.type === 'list') {
    return renderList(buildListTree(block.items), sourcePath, block.items[0]?.ordered)
  }
  return el('p', {}, renderInline(block.text, sourcePath, 'p'))
}

function buildListTree(items) {
  const root = { level: -1, children: [] }
  const stack = [root]
  for (const item of items) {
    while (stack.length > 1 && stack[stack.length - 1].level >= item.level) stack.pop()
    const node = { level: item.level, ordered: item.ordered, text: item.text, children: [] }
    stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return root.children
}

function renderList(nodes, sourcePath, ordered) {
  const list = el(ordered ? 'ol' : 'ul')
  for (const node of nodes) {
    list.append(el('li', {},
      renderInline(node.text, sourcePath, 'li'),
      node.children.length > 0 ? renderList(node.children, sourcePath, node.ordered) : null,
    ))
  }
  return list
}

// ------------------------------------------------------------------- header

function renderHeader() {
  const index = state.index
  if (!index) return
  document.title = `${index.projectName || '项目看板'} · 项目看板`
  $('project-path').textContent = index.root || ''
  $('project-path').title = index.root || ''

  const switchWrap = $('project-switch')
  const select = $('project-select')
  const projects = index.projects || []
  switchWrap.hidden = projects.length < 2
  if (!switchWrap.hidden) {
    clear(select)
    for (const project of projects) {
      select.append(el('option', {
        value: project.path,
        text: project.path === index.root ? `${project.title}（当前）` : project.title,
        title: project.path,
      }))
    }
    select.value = index.root
  }

  const meta = $('top-meta')
  clear(meta)
  if (index.phase) meta.append(el('span', { class: 'pill', text: index.phase }))
  const docsCount = Array.isArray(index.docs) ? index.docs.length : 0
  meta.append(el('span', { text: `${docsCount} 篇文档` }))
  if (index.map?.modules) {
    const done = index.map.modules.filter(module => module.status === 'done').length
    meta.append(el('span', { text: `${done}/${index.map.modules.length} 模块完成` }))
  }
  const updated = fmtTime(index.generatedAt)
  if (updated) meta.append(el('span', { text: `更新于 ${updated}` }))

  const conn = $('conn')
  conn.classList.toggle('stale', state.stale || state.error !== null)
  $('conn-text').textContent = state.error !== null ? '刷新失败' : state.stale ? '数据可能过期' : '只读 · 已连接'
  $('ref-dir').textContent = index.paths?.referenceDir || 'docs/reference'

  $('count-docs').textContent = String(docsCount)
  $('count-structure').textContent = index.map?.modules
    ? `${index.map.modules.filter(module => module.status === 'done').length}/${index.map.modules.length}`
    : '0'
}

// --------------------------------------------------------------------- docs

function renderDocList() {
  const list = $('doc-list')
  const scrollTop = list.scrollTop
  clear(list)
  const docs = state.index?.docs || []
  const filter = state.docFilter.trim().toLowerCase()
  const shown = docs.filter(doc => filter === '' || doc.title.toLowerCase().includes(filter) || doc.path.toLowerCase().includes(filter))
  if (shown.length === 0) {
    list.append(el('div', { class: 'loading', text: docs.length === 0 ? '参考文档区还是空的。' : '没有匹配的文档。' }))
    return
  }
  let lastGroup = null
  for (const doc of shown) {
    if (doc.group !== lastGroup) {
      lastGroup = doc.group
      list.append(el('div', { class: 'doc-group', text: doc.group === '' ? '根目录' : doc.group }))
    }
    list.append(el('button', {
      class: `doc-item${state.docs.selected === doc.path ? ' active' : ''}`,
      title: doc.path,
      onclick: () => openDoc(doc.path),
    },
      el('span', {}, doc.title),
      el('small', {}, doc.path),
    ))
  }
  list.scrollTop = scrollTop
}

function selectDefaultDoc() {
  const docs = state.index?.docs || []
  if (docs.length === 0) {
    state.docs.selected = null
    state.docs.content = null
    return false
  }
  if (docs.some(doc => doc.path === state.docs.selected)) return false
  const preferred = docs.find(doc => doc.path.endsWith('/INDEX.md') || doc.path === 'docs/reference/INDEX.md') || docs[0]
  state.docs.selected = preferred.path
  state.docs.content = null
  return true
}

async function openDoc(path, force = false) {
  if (!force && path === state.docs.selected && state.docs.content !== null) return
  state.docs.selected = path
  state.docs.content = null
  state.docs.error = null
  renderDocList()
  renderDocPane()
  try {
    const doc = await api('doc', { root: state.root, path })
    if (state.docs.selected !== path) return
    state.docs.content = doc.content
    state.docs.mtimeMs = doc.mtimeMs
  } catch (error) {
    if (state.docs.selected !== path) return
    state.docs.error = error.message
  }
  renderDocPane()
}

function renderDocPane() {
  const pane = $('doc-pane')
  const selected = state.docs.selected
  const key = `${selected}|${state.docs.mtimeMs}|${state.docs.content?.length ?? 0}|${state.docs.error ?? ''}`
  if (state.docs.renderKey === key && pane.childElementCount > 0) return
  state.docs.renderKey = key
  const keepScroll = state.docs.lastPath === selected ? pane.scrollTop : 0
  clear(pane)
  if (!selected) {
    pane.append(el('div', { class: 'loading', text: '从左侧选择一篇文档。' }))
    return
  }
  pane.append(el('div', { class: 'doc-head' },
    el('span', { class: 'ro', text: '只读' }),
    el('span', { class: 'path', text: selected, title: selected }),
    state.docs.content !== null ? el('span', { class: 'size', text: fmtBytes(new Blob([state.docs.content]).size) }) : null,
  ))
  if (state.docs.error !== null) {
    pane.append(el('div', { class: 'error-box', text: state.docs.error }))
    return
  }
  if (state.docs.content === null) {
    pane.append(el('div', { class: 'loading', text: '读取中…' }))
    return
  }
  const md = el('div', { class: 'md' }, renderMarkdown(state.docs.content, selected))
  pane.append(md)
  pane.scrollTop = keepScroll
  state.docs.lastPath = selected
}

// ---------------------------------------------------------------------- log

async function loadLog(force = false) {
  const meta = state.index?.devlog
  if (!meta) {
    state.log.content = null
    state.log.error = null
    state.log.loaded = true
    renderLog()
    return
  }
  if (!force && state.log.loaded && state.log.error === null && state.log.mtimeMs === meta.mtimeMs) return
  try {
    const doc = await api('doc', { root: state.root, path: meta.path })
    state.log.content = doc.content
    state.log.error = null
    state.log.mtimeMs = doc.mtimeMs
  } catch (error) {
    state.log.error = error.message
  }
  state.log.loaded = true
  renderLog()
}

function renderLog() {
  const pane = $('log-pane')
  clear(pane)
  if (state.log.error !== null) {
    pane.append(el('div', { class: 'error-box', text: state.log.error }))
    return
  }
  if (!state.log.loaded) {
    pane.append(el('div', { class: 'loading', text: '读取中…' }))
    return
  }
  if (state.log.content === null) {
    pane.append(el('div', { class: 'loading', text: '还没有开发日志。在仓库里创建 docs/DEVLOG.md 即可。' }))
    return
  }
  const { preamble, entries } = splitLog(state.log.content)
  if (preamble !== '') pane.append(el('div', { class: 'log-intro md' }, renderMarkdown(preamble, state.index?.paths?.devlogPath || 'docs/DEVLOG.md')))
  if (entries.length === 0) {
    pane.append(el('div', { class: 'md' }, renderMarkdown(state.log.content, state.index?.paths?.devlogPath || 'docs/DEVLOG.md')))
    return
  }
  entries.forEach((entry, index) => {
    const details = el('details', { class: 'entry', open: index === 0 })
    details.append(el('summary', {}, entry.title, el('small', { text: `${entry.lines.length} 行` })))
    details.append(el('div', { class: 'entry-body' },
      el('div', { class: 'md' }, renderMarkdown(entry.lines.join('\n'), state.index?.paths?.devlogPath || 'docs/DEVLOG.md')),
    ))
    pane.append(details)
  })
}

function splitLog(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  const entries = []
  const preamble = []
  let current = null
  const finalize = entry => {
    const kept = entry.lines.slice()
    while (kept.length > 0 && /^\s*$/.test(kept[kept.length - 1])) kept.pop()
    if (kept.length > 0 && /^\s*---\s*$/.test(kept[kept.length - 1])) kept.pop()
    while (kept.length > 0 && /^\s*$/.test(kept[kept.length - 1])) kept.pop()
    return { title: entry.title, lines: kept }
  }
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match !== null) {
      if (current) entries.push(finalize(current))
      current = { title: match[1], lines: [] }
    } else if (current) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
  }
  if (current) entries.push(finalize(current))
  return { preamble: preamble.join('\n').trim(), entries }
}

function renderLongterm() {
  const main = $('lt-main')
  const ref = $('lt-ref')
  if (main === null || ref === null) return
  const mainScroll = main.scrollTop
  const refScroll = ref.scrollTop
  clear(main)
  clear(ref)
  const index = state.index
  const roadmap = index?.roadmap
  const directions = Array.isArray(roadmap?.directions) ? roadmap.directions : []
  const horizons = [...(Array.isArray(roadmap?.horizons) ? roadmap.horizons : [])].sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  const selected = new Set(Array.isArray(index?.longTermReference?.items) ? index.longTermReference.items : [])
  const count = $('count-longterm')
  if (count !== null) count.textContent = String(directions.length)

  const meta = $('lt-meta')
  if (meta !== null) {
    meta.textContent = roadmap
      ? `${roadmap.generator || 'AI'} · 生成于 ${roadmap.generatedAt || '未知'} · ${directions.length} 条建议${roadmap.note ? ` · ${roadmap.note}` : ''}`
      : '由 AI 根据 docs 与当前结构生成；建议不是承诺。'
  }

  ref.append(el('h3', { text: '长期参考' }))
  ref.append(el('div', { class: 'sub', text: `${selected.size} 条已选 · 写入 ${index?.paths?.referencePath || 'docs/board/long-term-reference.json'}` }))

  if (index?.roadmapError) {
    main.append(el('div', { class: 'lt-error', text: index.roadmapError }))
  }
  if (!roadmap || directions.length === 0) {
    main.append(el('div', { class: 'lt-empty' },
      el('strong', { text: index?.roadmapError ? '长期方向数据有误' : '还没有生成长期方向' }),
      el('div', { text: '在对话里说「生成长期开发方向」，AI 会读取 docs/reference 与当前 project-map，生成 docs/board/roadmap.json；也可以点右上角「复制生成指令」。' }),
    ))
    ref.append(el('div', { class: 'lt-ref-empty', text: '长期方向生成后，可在卡片上点「加入长期参考」。' }))
    return
  }

  const byHorizon = new Map(horizons.map(horizon => [horizon.id, []]))
  for (const direction of directions) {
    if (!byHorizon.has(direction.horizon)) byHorizon.set(direction.horizon, [])
    byHorizon.get(direction.horizon).push(direction)
  }
  for (const horizon of horizons) {
    const items = byHorizon.get(horizon.id) || []
    if (items.length === 0) continue
    const section = el('section', { class: 'lt-horizon' },
      el('h3', {}, horizon.label, el('span', { text: `${items.length} 条` })),
      el('div', { class: 'lt-grid' }),
    )
    const grid = section.querySelector('.lt-grid')
    for (const direction of items) {
      const isSelected = selected.has(direction.id)
      const card = el('article', { class: `lt-card${isSelected ? ' selected' : ''}` })
      card.append(el('div', { class: 'lt-card-head' },
        el('h4', { text: direction.label }),
        el('span', { class: 'horizon', text: horizon.label }),
      ))
      card.append(el('p', { text: direction.summary || '' }))
      if (direction.rationale) card.append(el('div', { class: 'why' }, el('b', { text: '为什么：' }), direction.rationale))
      if (Array.isArray(direction.relatedModules) && direction.relatedModules.length > 0) {
        card.append(el('div', { class: 'chips' }, direction.relatedModules.map(id => {
          const module = state.graph.model?.byId.get(id)
          return el('button', {
            class: 'chip',
            title: id,
            onclick: () => { setView('structure'); jumpToModule(id) },
          }, module?.label || id)
        })))
      }
      if (Array.isArray(direction.sourceDocs) && direction.sourceDocs.length > 0) {
        card.append(el('div', { class: 'docs', text: direction.sourceDocs.join('  ·  ') }))
      }
      card.append(el('div', { class: 'lt-card-actions' },
        el('button', {
          class: `btn small${isSelected ? ' on' : ''}`,
          disabled: state.longterm.saving,
          text: isSelected ? '已在长期参考' : '加入长期参考',
          onclick: () => toggleReference(direction.id),
        }),
      ))
      grid.append(card)
    }
    main.append(section)
  }

  const selectedDirections = directions.filter(direction => selected.has(direction.id))
  if (selectedDirections.length === 0) {
    ref.append(el('div', { class: 'lt-ref-empty', text: '还没有选中任何长期方向。在左侧卡片点「加入长期参考」，这里会作为长期参考持续保存。' }))
  } else {
    for (const direction of selectedDirections) {
      const horizon = horizons.find(item => item.id === direction.horizon)
      ref.append(el('div', { class: 'lt-ref-item' },
        el('div', { class: 'row' },
          el('div', {},
            el('b', { text: direction.label }),
            el('small', { text: `${horizon?.label || direction.horizon} · ${direction.summary || ''}` }),
          ),
          el('button', { class: 'btn small', text: '移除', disabled: state.longterm.saving, onclick: () => toggleReference(direction.id) }),
        ),
      ))
    }
  }
  if (index?.referenceError) ref.append(el('div', { class: 'lt-error', text: index.referenceError, style: 'margin-top:10px' }))
  main.scrollTop = mainScroll
  ref.scrollTop = refScroll
}

async function toggleReference(id) {
  if (state.longterm.saving) return
  const index = state.index
  if (index === null) return
  const current = new Set(Array.isArray(index.longTermReference?.items) ? index.longTermReference.items : [])
  if (current.has(id)) current.delete(id)
  else current.add(id)
  state.longterm.saving = true
  renderLongterm()
  try {
    const response = await fetch(`./api/reference?${apiQuery({ root: state.root })}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [...current] }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`)
    state.index.longTermReference = { items: body.items }
    state.index.referenceError = null
    toast(current.has(id) ? '已加入长期参考' : '已移出长期参考')
  } catch (error) {
    toast(`保存失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    state.longterm.saving = false
    renderLongterm()
  }
}

function exportReference() {
  const items = Array.isArray(state.index?.longTermReference?.items) ? state.index.longTermReference.items : []
  download('long-term-reference.json', JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    items,
  }, null, 2), 'application/json')
  toast('长期参考已导出')
}

function copyGenerationPrompt() {
  copyText('请根据 docs/reference 下的技术文档和玩法文档，以及 docs/board/project-map.json 的当前结构，重新生成 docs/board/roadmap.json 的长期开发方向。保持建议性质：不要替我决定玩法、数值或优先级；每条方向写清 summary、rationale、relatedModules、sourceDocs，并标 horizon（next/mid/later）。')
}

function openWorkspaceDialog() {
  const modal = $('workspace-modal')
  const input = $('workspace-input')
  const error = $('workspace-error')
  if (modal === null || input === null) return
  input.value = state.root || ''
  if (error !== null) error.textContent = ''
  modal.hidden = false
  requestAnimationFrame(() => { input.focus(); input.select() })
}

function closeWorkspaceDialog() {
  const modal = $('workspace-modal')
  if (modal !== null) modal.hidden = true
}

async function pickWorkspaceFolder() {
  const button = $('workspace-pick')
  if (button.disabled) return
  button.disabled = true
  try {
    const response = await fetch(`./api/pick-folder?${apiQuery({ root: state.root })}`, { method: 'POST' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`)
    if (body.path) $('workspace-input').value = body.path
  } catch (error) {
    $('workspace-error').textContent = `选择文件夹失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    button.disabled = false
  }
}

async function applyWorkspace() {
  const input = $('workspace-input')
  const error = $('workspace-error')
  const button = $('workspace-apply')
  if (input === null || button.disabled) return
  const root = input.value.trim()
  if (root === '') {
    if (error !== null) error.textContent = '请输入项目工作区的绝对路径。'
    input.focus()
    return
  }
  button.disabled = true
  if (error !== null) error.textContent = ''
  try {
    const probe = await api('index', { sessionId: state.sessionId, root })
    if (probe.map === null && probe.mapError) {
      throw new Error(probe.mapError)
    }
    state.root = probe.root || root
    closeWorkspaceDialog()
    await loadIndex()
    toast(`已切换到工作区：${state.root}`)
  } catch (err) {
    if (error !== null) error.textContent = err instanceof Error ? err.message : String(err)
  } finally {
    button.disabled = false
  }
}

function sourceStorageKey() {
  return `dsh-project-board:docs-dir:v1:${state.root || ''}`
}

function renderSourceBar() {
  const input = $('doc-source-input')
  const status = $('source-status')
  if (input === null || status === null) return
  const saved = localStorage.getItem(sourceStorageKey()) || ''
  const source = saved || state.index?.context?.sourceDir || ''
  if (document.activeElement !== input) input.value = source
  const context = state.index?.context
  clear(status)
  status.className = 'sourcebar-status'
  if (context) {
    status.classList.add('ok')
    status.textContent = `${context.documentCount} 文档 · ${context.imageCount} 图片 · ${context.flowCount} 流程 · ${fmtTime(context.generatedAt) || '已生成'}`
    status.title = context.warnings?.length ? context.warnings.join('\n') : context.sourceDir
  } else {
    status.textContent = '尚未生成 AI 上下文'
    status.title = '选择项目文档文件夹后，点右侧按钮生成'
  }
}

async function pickFolder() {
  const button = $('pick-folder')
  if (button.disabled) return
  button.disabled = true
  try {
    const response = await fetch(`./api/pick-folder?${apiQuery({ root: state.root })}`, { method: 'POST' })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`)
    if (body.path) {
      $('doc-source-input').value = body.path
      localStorage.setItem(sourceStorageKey(), body.path)
      toast('已选择文档文件夹；点「更新状态」生成 AI 上下文')
    } else {
      toast('已取消选择')
    }
  } catch (error) {
    toast(`选择文件夹失败：${error instanceof Error ? error.message : String(error)}；可直接输入绝对路径`)
    $('doc-source-input').focus()
  } finally {
    button.disabled = false
  }
}

async function reindexDocs() {
  const button = $('reindex')
  const input = $('doc-source-input')
  if (button.disabled) return
  const sourceDir = input.value.trim()
  if (sourceDir === '') {
    toast('先选择项目文档文件夹，或输入绝对路径')
    input.focus()
    return
  }
  button.disabled = true
  $('source-status').className = 'sourcebar-status'
  $('source-status').textContent = '解析中…'
  try {
    const response = await fetch(`./api/reindex?${apiQuery({ root: state.root })}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceDir }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`)
    localStorage.setItem(sourceStorageKey(), sourceDir)
    await loadIndex({ silent: true })
    if (state.view === 'context') await loadContext(true)
    toast(`已生成 AI 上下文：${body.documentCount} 文档 / ${body.imageCount} 图片 / ${body.flowCount} 流程`)
  } catch (error) {
    toast(`更新失败：${error instanceof Error ? error.message : String(error)}`)
    $('source-status').className = 'sourcebar-status bad'
    $('source-status').textContent = '解析失败'
  } finally {
    button.disabled = false
    renderSourceBar()
  }
}

async function loadContext(force = false) {
  const pane = $('context-pane')
  if (pane === null) return
  if (state.context.loading && !force) return
  state.context.loading = true
  state.context.error = null
  if (force || state.context.markdown === null) {
    clear(pane)
    pane.append(el('div', { class: 'loading', text: '读取 AI 上下文…' }))
  }
  try {
    const body = await api('context', { root: state.root })
    state.context.markdown = body.markdown
    state.context.error = null
    state.index = state.index ? { ...state.index, context: body.summary } : state.index
  } catch (error) {
    state.context.markdown = null
    state.context.error = error.message
  } finally {
    state.context.loading = false
    renderContext()
    renderSourceBar()
  }
}

function renderContext() {
  const pane = $('context-pane')
  const meta = $('context-meta')
  if (pane === null) return
  clear(pane)
  const context = state.index?.context
  if (meta !== null) {
    meta.textContent = context
      ? `${context.documentCount} 个文档 · ${context.imageCount} 张图片 · ${context.flowCount} 个流程 · 生成于 ${fmtTime(context.generatedAt) || context.generatedAt || '未知'}`
      : '生成后，这里会显示 AI 可直接阅读的项目文档上下文。'
  }
  if (state.context.error !== null) {
    pane.append(el('div', { class: 'error-box', text: `${state.context.error}。先在顶部选择文档文件夹并点「更新状态」。` }))
    return
  }
  if (state.context.markdown === null) {
    pane.append(el('div', { class: 'loading', text: '还没有生成 AI 上下文。选择文档文件夹后点「以当前项目文档文件夹更新状态」。' }))
    return
  }
  const source = context?.paths?.markdown || 'docs/board/AI-CONTEXT.md'
  pane.append(el('div', { class: 'md' }, renderMarkdown(state.context.markdown, source)))
}

// -------------------------------------------------------------------- graph

function nodeWidth(module) {
  const text = String(module.label || module.id)
  return clamp(48 + text.length * 12.5, 132, 232)
}

function buildGraphModel(index) {
  const map = index?.map
  if (!map) return null
  const declared = [...(Array.isArray(map.layers) ? map.layers : [])]
  declared.sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  const declaredLayers = declared.map(layer => ({ id: layer.id, label: layer.label || layer.id, order: layer.order ?? 0 }))
  const modules = Array.isArray(map.modules) ? map.modules : []
  const byId = new Map(modules.map(module => [module.id, module]))
  const children = new Map(modules.map(module => [module.id, []]))
  const topLevel = []
  for (const module of modules) {
    const parent = typeof module.parent === 'string' && byId.has(module.parent) ? module.parent : null
    if (parent === null) topLevel.push(module)
    else children.get(parent).push(module)
  }
  const ids = new Set(modules.map(module => module.id))
  const edges = (Array.isArray(map.edges) ? map.edges : [])
    .filter(edge => ids.has(edge.from) && ids.has(edge.to))
    .map((edge, index_) => ({
      id: `e${index_}`,
      from: edge.from,
      to: edge.to,
      kind: EDGE_KINDS[edge.kind] ? edge.kind : 'depends',
      label: typeof edge.label === 'string' ? edge.label : '',
    }))
  const neighbors = new Map()
  for (const id of ids) neighbors.set(id, new Set())
  for (const edge of edges) {
    neighbors.get(edge.from)?.add(edge.to)
    neighbors.get(edge.to)?.add(edge.from)
  }
  const focus = new Set([
    ...(Array.isArray(map.focus) ? map.focus.map(item => (typeof item === 'string' ? item : item?.module)).filter(Boolean) : []),
    ...modules.filter(module => module.focus === true).map(module => module.id),
  ])
  const subsystems = (Array.isArray(map.subsystems) ? map.subsystems : []).map((subsystem, index_) => ({
    id: subsystem.id,
    label: subsystem.label,
    summary: typeof subsystem.summary === 'string' ? subsystem.summary : '',
    concern: typeof subsystem.concern === 'string' ? subsystem.concern : 'gameplay',
    horizon: typeof subsystem.horizon === 'string' ? subsystem.horizon : 'current',
    order: Number.isFinite(subsystem.order) ? subsystem.order : index_ + 1,
    modules: Array.isArray(subsystem.modules) ? subsystem.modules.filter(id => byId.has(id)) : [],
  })).sort((left, right) => left.order - right.order)
  const subsystemById = new Map(subsystems.map(subsystem => [subsystem.id, subsystem]))
  const moduleSubsystems = new Map()
  for (const subsystem of subsystems) {
    for (const moduleId of subsystem.modules) {
      if (!moduleSubsystems.has(moduleId)) moduleSubsystems.set(moduleId, [])
      moduleSubsystems.get(moduleId).push(subsystem.id)
    }
  }
  const assigned = new Set(moduleSubsystems.keys())
  const unassigned = modules.filter(module => !assigned.has(module.id))
  if (unassigned.length > 0) {
    const fallback = {
      id: '__unassigned',
      label: '未归类模块',
      summary: '还没有归入任何概念子系统；补充 subsystems 后会自动收编。',
      concern: 'tooling',
      order: 9999,
      modules: unassigned.map(module => module.id),
    }
    subsystems.push(fallback)
    subsystemById.set(fallback.id, fallback)
    for (const module of unassigned) {
      if (!moduleSubsystems.has(module.id)) moduleSubsystems.set(module.id, [])
      moduleSubsystems.get(module.id).push(fallback.id)
    }
  }
  const attributes = new Map((Array.isArray(map.attributes) ? map.attributes : []).map(attribute => [attribute.id, attribute]))
  const attributeModules = new Map()
  for (const attribute of attributes.values()) {
    const ids_ = new Set([
      ...(attribute.writtenBy || []),
      ...(attribute.readBy || []),
      ...(attribute.sourceModule ? [attribute.sourceModule] : []),
    ])
    for (const id of ids_) {
      if (!attributeModules.has(id)) attributeModules.set(id, [])
      attributeModules.get(id).push(attribute.id)
    }
  }
  const flowModules = new Map()
  const flows = (Array.isArray(map.flows) ? map.flows : []).map((flow, index_) => {
    for (const step of flow.steps || []) {
      if (!flowModules.has(step.module)) flowModules.set(step.module, [])
      flowModules.get(step.module).push(flow.id)
    }
    return { ...flow, id: flow.id, index: index_ }
  })
  return {
    layers: declaredLayers,
    modules,
    byId,
    children,
    topLevel,
    edges,
    neighbors,
    focus,
    attributes,
    attributeModules,
    flows,
    flowModules,
    subsystems,
    subsystemById,
    moduleSubsystems,
  }
}

function expandSubsystem(model, subsystem) {
  if (!subsystem) return []
  const ids = new Set()
  const add = id => {
    if (ids.has(id)) return
    const module = model.byId.get(id)
    if (!module) return
    ids.add(id)
    for (const child of model.children.get(id) || []) add(child.id)
  }
  for (const moduleId of subsystem.modules) add(moduleId)
  return model.modules.filter(module => ids.has(module.id))
}

function layersFor(modules, declared) {
  const present = new Set(modules.map(module => module.layer))
  const layers = []
  for (const layer of declared) {
    if (present.has(layer.id)) layers.push({ ...layer })
  }
  for (const module of modules) {
    if (!layers.some(layer => layer.id === module.layer)) {
      layers.push({ id: module.layer || '__other', label: module.layer === '__external' ? '外部依赖' : (module.layer || '其他'), order: module.layer === '__external' ? 9999 : 9998 })
    }
  }
  layers.sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  return layers
}

function autoLayout(modules, layers) {
  const NODE_H = 54
  const NODE_GAP = 26
  const ROW_GAP = 16
  const BAND_TOP = 34
  const BAND_BOTTOM = 22
  const BAND_GAP = 26
  const MAX_ROW = 1480
  const byLayer = new Map(layers.map(layer => [layer.id, []]))
  for (const module of modules) {
    const layerId = byLayer.has(module.layer) ? module.layer : layers[layers.length - 1]?.id
    if (layerId === undefined) continue
    byLayer.get(layerId).push(module)
  }
  const order = new Map(layers.map(layer => [layer.id, [...(byLayer.get(layer.id) || [])]]))
  const neighbors = state.graph.model?.neighbors || new Map()

  const indexOf = (layerId) => {
    const map = new Map()
    order.get(layerId)?.forEach((module, index) => map.set(module.id, index))
    return map
  }
  const sortBy = (layerId, refLayerId) => {
    const ref = indexOf(refLayerId)
    const current = order.get(layerId)
    if (!current || !ref) return
    const scored = current.map((module, index) => {
      const positions = [...(neighbors.get(module.id) || [])]
        .map(id => ref.get(id))
        .filter(value => value !== undefined)
      return { module, index, score: positions.length > 0 ? positions.reduce((a, b) => a + b, 0) / positions.length : index }
    })
    scored.sort((left, right) => left.score - right.score)
    order.set(layerId, scored.map(item => item.module))
  }
  for (let sweep = 0; sweep < 3; sweep += 1) {
    for (let i = 1; i < layers.length; i += 1) sortBy(layers[i].id, layers[i - 1].id)
    for (let i = layers.length - 2; i >= 0; i -= 1) sortBy(layers[i].id, layers[i + 1].id)
  }

  const positions = new Map()
  const bands = []
  let top = 0
  for (const layer of layers) {
    const layerModules = order.get(layer.id) || []
    if (layerModules.length === 0) {
      bands.push({ id: layer.id, label: layer.label, x: -300, y: top, width: 600, height: BAND_TOP + BAND_BOTTOM })
      top += BAND_TOP + BAND_BOTTOM + BAND_GAP
      continue
    }
    const rows = []
    for (const module of layerModules) {
      const width = nodeWidth(module)
      let row = rows[rows.length - 1]
      const used = row ? row.reduce((sum, item) => sum + nodeWidth(item) + NODE_GAP, -NODE_GAP) : 0
      if (row === undefined || used + NODE_GAP + width > MAX_ROW) {
        row = []
        rows.push(row)
      }
      row.push(module)
    }
    const bandWidth = Math.max(...rows.map(row => row.reduce((sum, item) => sum + nodeWidth(item) + NODE_GAP, -NODE_GAP))) + 56
    const bandHeight = BAND_TOP + rows.length * NODE_H + Math.max(0, rows.length - 1) * ROW_GAP + BAND_BOTTOM
    bands.push({ id: layer.id, label: layer.label, x: -bandWidth / 2, y: top, width: bandWidth, height: bandHeight })
    rows.forEach((row, rowIndex) => {
      const rowWidth = row.reduce((sum, item) => sum + nodeWidth(item) + NODE_GAP, -NODE_GAP)
      let x = -rowWidth / 2
      for (const module of row) {
        const width = nodeWidth(module)
        positions.set(module.id, {
          x,
          y: top + BAND_TOP + rowIndex * (NODE_H + ROW_GAP),
          w: width,
          h: NODE_H,
        })
        x += width + NODE_GAP
      }
    })
    top += bandHeight + BAND_GAP
  }
  return { positions, bands, width: Math.max(...bands.map(band => band.width + 80), 900), height: top }
}

function applyManual(layout) {
  const apply = positions => {
    if (positions === null || typeof positions !== 'object') return
    for (const [id, pos] of Object.entries(positions)) {
      const node = layout.positions.get(id)
      if (node && Number.isFinite(pos?.x) && Number.isFinite(pos?.y)) {
        node.x = pos.x
        node.y = pos.y
      }
    }
  }
  apply(state.graph.serverLayout)
  apply(state.graph.manual)
}

function computeView() {
  const model = state.graph.model
  if (!model) {
    state.graph.visible = []
    state.graph.visibleEdges = []
    state.graph.stubs = []
    state.graph.layout = null
    return
  }
  let modules
  let edges
  let stubs = []
  if (state.graph.mode === 'deps') {
    let visible
    if (state.graph.subsystem !== null) {
      visible = expandSubsystem(model, model.subsystemById.get(state.graph.subsystem))
    } else {
      const scope = state.graph.scope
      visible = model.modules.filter(module => (module.parent ?? null) === scope)
    }
    const visibleIds = new Set(visible.map(module => module.id))
    const stubMap = new Map()
    const edgeKeys = new Set()
    edges = []
    const project = id => {
      if (visibleIds.has(id)) return { id, stub: false }
      let cursor = model.byId.get(id)
      while (cursor && cursor.parent && !visibleIds.has(cursor.parent)) {
        cursor = model.byId.get(cursor.parent)
      }
      if (cursor?.parent && visibleIds.has(cursor.parent)) {
        return { id: cursor.parent, stub: false }
      }
      const stubId = `stub:${id}`
      if (!stubMap.has(id)) {
        const real = model.byId.get(id)
        stubMap.set(id, {
          id: stubId,
          realId: id,
          label: real?.label || id,
          layer: '__external',
          status: real?.status || 'unknown',
          summary: real?.summary,
          isStub: true,
        })
      }
      return { id: stubId, stub: true }
    }
    const inScope = id => {
      if (visibleIds.has(id)) return true
      let cursor = model.byId.get(id)?.parent
      while (typeof cursor === 'string') {
        if (visibleIds.has(cursor)) return true
        cursor = model.byId.get(cursor)?.parent
      }
      return false
    }
    for (const edge of model.edges) {
      if (!inScope(edge.from) && !inScope(edge.to)) continue
      const from = project(edge.from)
      const to = project(edge.to)
      if (from.id === to.id) continue
      const key = `${from.id}->${to.id}:${edge.kind}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      edges.push({ ...edge, from: from.id, to: to.id, stub: from.stub || to.stub })
    }
    stubs = [...stubMap.values()]
    modules = [...visible, ...stubs]
  } else {
    const referenced = new Set(state.graph.mode === 'data' ? model.attributeModules.keys() : model.flowModules.keys())
    modules = model.modules.filter(module =>
      (model.children.get(module.id)?.length ?? 0) === 0 || referenced.has(module.id))
    const ids = new Set(modules.map(module => module.id))
    edges = model.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to))
  }
  const layers = layersFor(modules, model.layers)
  const layout = autoLayout(modules, layers)
  applyManual(layout)
  state.graph.visible = modules
  state.graph.visibleEdges = edges
  state.graph.stubs = stubs
  state.graph.visibleLayers = layers
  state.graph.layout = layout
}

function rebuildGraph({ fit = false } = {}) {
  const model = buildGraphModel(state.index)
  state.graph.model = model
  if (!model) {
    state.graph.layout = null
    state.graph.visible = []
    state.graph.visibleEdges = []
    state.graph.stubs = []
    syncModeUi()
    renderGraph()
    renderInspector()
    renderCrumbs()
    return
  }
  if (state.graph.subsystem !== null && !model.subsystemById.has(state.graph.subsystem)) {
    state.graph.subsystem = null
  }
  if (state.graph.mode === 'arch' && model.subsystems.length === 0) {
    state.graph.mode = 'deps'
  }
  if (state.graph.mode === 'arch') {
    if (state.graph.archSelected !== null && !model.subsystemById.has(state.graph.archSelected)) {
      state.graph.archSelected = null
    }
    syncModeUi()
    renderGraph()
    renderInspector()
    renderCrumbs()
    if (fit) requestAnimationFrame(() => fitArch())
    return
  }
  if (state.graph.scope !== null && !model.byId.has(state.graph.scope)) state.graph.scope = null
  syncModeUi()
  computeView()
  if (state.graph.selected !== null && !model.byId.has(state.graph.selected)) state.graph.selected = null
  renderGraph()
  renderInspector()
  renderCrumbs()
  if (fit) requestAnimationFrame(() => fitView())
}

function visibleNodes() {
  const layout = state.graph.layout
  if (!layout) return []
  return state.graph.visible.filter(module =>
    !state.graph.hiddenLayers.has(module.layer) &&
    !state.graph.hiddenStatuses.has(module.status || 'unknown') &&
    layout.positions.has(module.id),
  )
}

function currentTrace(model) {
  const id = state.graph.selectedAttribute
  const attribute = id ? model.attributes.get(id) : null
  if (!attribute) return null
  const source = attribute.sourceModule || (attribute.writtenBy || [])[0] || null
  const writers = new Set(attribute.writtenBy || [])
  const readers = new Set(attribute.readBy || [])
  const links = []
  const add = (from, to, kind) => {
    if (!from || !to || from === to) return
    if (!model.byId.has(from) || !model.byId.has(to)) return
    if (links.some(link => link.from === from && link.to === to)) return
    links.push({ from, to, kind })
  }
  if (source !== null) {
    for (const writer of writers) add(source, writer, 'write')
    if (writers.size === 0) for (const reader of readers) add(source, reader, 'read')
  }
  for (const writer of writers) {
    for (const reader of readers) if (reader !== writer) add(writer, reader, 'read')
  }
  return { attribute, source, writers, readers, links }
}

function currentFlow(model) {
  const id = state.graph.selectedFlow
  return model.flows.find(flow => flow.id === id) || null
}

function flowLinks(flow) {
  if (!flow) return []
  const steps = flow.steps || []
  const links = []
  for (let index = 0; index < steps.length - 1; index += 1) {
    if (steps[index].module !== steps[index + 1].module) {
      links.push({ from: steps[index].module, to: steps[index + 1].module, step: index + 1 })
    }
  }
  return links
}

function flowStepOf(flow, moduleId) {
  if (!flow) return -1
  return (flow.steps || []).findIndex(step => step.module === moduleId)
}

function edgeMidpoint(from, to) {
  const x1 = from.x + from.w / 2
  const y1 = from.y + from.h
  const x2 = to.x + to.w / 2
  const y2 = to.y
  if (Math.abs(from.y - to.y) < 1) {
    const leftToRight = to.x > from.x
    return { x: leftToRight ? from.x + from.w + 10 : from.x - 10, y: from.y + from.h / 2 - 4 }
  }
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
}

function renderGraph() {
  if (state.graph.mode === 'arch') {
    renderArch()
    return
  }
  cancelAnimationFrame(state.graph.frame)
  const canvas = $('canvas')
  const model = state.graph.model
  const layout = state.graph.layout
  const empty = $('canvas-empty')
  const visible = visibleNodes()

  if (!model || !layout || visible.length === 0) {
    clear(canvas)
    empty.hidden = false
    clear(empty)
    const mapError = state.index?.mapError
    const scopeName = state.graph.scope ? model?.byId.get(state.graph.scope)?.label : null
    empty.append(el('strong', { text: mapError ? '结构图数据有误' : scopeName ? `${scopeName} 还没有子模块` : '还没有结构图数据' }))
    empty.append(el('span', { text: mapError || (scopeName ? '在 project-map.json 里给这个模块添加 parent 子模块，或返回上级。' : `在仓库里创建 ${state.index?.paths?.mapPath || 'docs/board/project-map.json'}，并加入 modules。`) }))
    renderLegend(null)
    return
  }
  empty.hidden = true

  const mode = state.graph.mode
  const search = state.graph.search.trim().toLowerCase()
  const matched = new Set(visible
    .filter(module => search === '' || String(module.label || module.id).toLowerCase().includes(search))
    .map(module => module.id))
  const selected = state.graph.selected
  const selectedIsStub = state.graph.stubs.some(stub => stub.id === selected)
  const near = new Set()
  if (selected !== null && !selectedIsStub) {
    near.add(selected)
    for (const id of model.neighbors.get(selected) || []) near.add(id)
  }
  const trace = mode === 'data' ? currentTrace(model) : null
  const flow = mode === 'flow' ? currentFlow(model) : null
  const visibleSet = new Set(visible.map(module => module.id))

  clear(canvas)
  const defs = svg('defs')
  const markerKinds = {
    ...Object.fromEntries(Object.entries(EDGE_KINDS).map(([kind, def]) => [`arrow-${kind}`, def.color])),
    'arrow-write': '#d97706',
    'arrow-read': '#2ea121',
    'arrow-flow': '#3370ff',
    'arrow-accent': '#3370ff',
  }
  for (const [id, color] of Object.entries(markerKinds)) {
    const marker = svg('marker', {
      id, viewBox: '0 0 10 10', refX: 8, refY: 5,
      markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
    })
    marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }))
    defs.append(marker)
  }
  canvas.append(defs)

  const viewport = svg('g', { id: 'viewport' })
  canvas.append(viewport)
  const edgesLayer = svg('g', { class: 'edges' })
  const nodesLayer = svg('g', { class: 'nodes' })

  for (const band of layout.bands) {
    if (state.graph.hiddenLayers.has(band.id)) continue
    viewport.append(svg('rect', {
      class: 'layer-band', x: band.x, y: band.y, width: band.width, height: band.height, rx: 12,
    }))
    viewport.append(svg('text', { class: 'layer-label', x: band.x + 14, y: band.y + 18 }, band.label))
    const count = state.graph.visible.filter(module => module.layer === band.id).length
    viewport.append(svg('text', { class: 'layer-count', x: band.x + band.width - 14, y: band.y + 18, 'text-anchor': 'end' }, `${count} 个`))
  }
  viewport.append(edgesLayer, nodesLayer)

  // Edges by mode.
  if (mode === 'deps') {
    for (const edge of state.graph.visibleEdges) {
      if (!visibleSet.has(edge.from) || !visibleSet.has(edge.to)) continue
      if (!layout.positions.has(edge.from) || !layout.positions.has(edge.to)) continue
      const from = layout.positions.get(edge.from)
      const to = layout.positions.get(edge.to)
      const d = edgePath(from, to)
      const highlighted = selected !== null && !selectedIsStub && (edge.from === selected || edge.to === selected)
      const dimmed = (selected !== null && !selectedIsStub && !highlighted) || (search !== '' && !(matched.has(edge.from) && matched.has(edge.to)))
      const path = svg('path', {
        class: `edge kind-${edge.kind}${highlighted ? ' highlight' : ''}${dimmed ? ' dimmed' : ''}`,
        d,
        'marker-end': `url(#${highlighted ? 'arrow-accent' : `arrow-${edge.kind}`})`,
      })
      const title = svg('title')
      title.textContent = `${edgeLabel(model, edge.from)} → ${edgeLabel(model, edge.to)}${edge.label ? `（${edge.label}）` : ''}`
      path.append(title)
      edgesLayer.append(path)
    }
  } else if (mode === 'data' && trace !== null) {
    for (const link of trace.links) {
      if (!visibleSet.has(link.from) || !visibleSet.has(link.to)) continue
      const from = layout.positions.get(link.from)
      const to = layout.positions.get(link.to)
      if (!from || !to) continue
      const d = edgePath(from, to)
      const path = svg('path', {
        class: `edge flow-${link.kind}`,
        d,
        'marker-end': `url(#arrow-${link.kind})`,
      })
      const title = svg('title')
      title.textContent = `${edgeLabel(model, link.from)} → ${edgeLabel(model, link.to)}：${trace.attribute.label}（${link.kind === 'write' ? '写' : '读'}）`
      path.append(title)
      edgesLayer.append(path)
    }
  } else if (mode === 'flow' && flow !== null) {
    for (const link of flowLinks(flow)) {
      if (!visibleSet.has(link.from) || !visibleSet.has(link.to)) continue
      const from = layout.positions.get(link.from)
      const to = layout.positions.get(link.to)
      if (!from || !to) continue
      const d = edgePath(from, to)
      const path = svg('path', {
        class: 'edge flow-step',
        d,
        'marker-end': 'url(#arrow-flow)',
      })
      const edgeTitle = svg('title')
      edgeTitle.textContent = `第 ${link.step} → ${link.step + 1} 步`
      path.append(edgeTitle)
      edgesLayer.append(path)
      const mid = edgeMidpoint(from, to)
      edgesLayer.append(svg('text', { class: 'step-edge-label', x: mid.x, y: mid.y, 'text-anchor': 'middle' }, String(link.step + 1)))
    }
  }

  // Nodes.
  state.graph.nodeEls.clear()
  for (const module of visible) {
    const pos = layout.positions.get(module.id)
    const status = STATUS[module.status] || STATUS.unknown
    const classes = ['node', `status-${module.status || 'unknown'}`]
    if (module.isStub) classes.push('is-stub')
    if (module.id === selected) classes.push('selected')
    else if (selected !== null && near.has(module.id)) classes.push('near')

    let dimmed = false
    if (search !== '' && !matched.has(module.id)) dimmed = true
    if (mode === 'deps' && selected !== null && !selectedIsStub && !near.has(module.id)) dimmed = true

    let role = null
    if (mode === 'data' && trace !== null) {
      if (trace.source === module.id) role = 'source'
      else if (trace.writers.has(module.id)) role = 'writer'
      else if (trace.readers.has(module.id)) role = 'reader'
      if (role !== null) classes.push(`role-${role}`)
      else dimmed = true
    }
    const stepIndex = mode === 'flow' && flow !== null ? flowStepOf(flow, module.id) : -1
    if (stepIndex >= 0) {
      classes.push('in-flow')
      if (stepIndex === state.graph.flowStep) classes.push('current-step')
    } else if (mode === 'flow' && flow !== null) {
      dimmed = true
    }
    if (module.id === selected) dimmed = false
    if (dimmed) classes.push('dimmed')

    const group = svg('g', {
      class: classes.join(' '),
      transform: `translate(${pos.x} ${pos.y})`,
      'data-id': module.id,
      tabindex: 0,
      role: 'button',
      'aria-label': `${module.label}，${status.label}`,
      style: `--status:${status.color}`,
    })
    group.append(svg('rect', { class: 'card', x: 0, y: 0, width: pos.w, height: pos.h, rx: 9 }))
    group.append(svg('circle', { class: 'status-dot', cx: 14, cy: 15, r: 3.6 }))
    const label = String(module.label || module.id)
    group.append(svg('text', { class: 'label', x: 24, y: 20 }, label.length > 12 ? `${label.slice(0, 11)}…` : label))
    const layerLabel = model.layers.find(layer => layer.id === module.layer)?.label || ''
    const subBits = [status.label]
    if (model.focus.has(module.id)) subBits.push('重点')
    if (layerLabel && !module.isStub) subBits.push(layerLabel.split('·')[0].trim())
    group.append(svg('text', { class: 'sublabel', x: 24, y: 36 }, subBits.join(' · ')))

    const cornerBits = []
    const childCount = model.children.get(module.id)?.length ?? 0
    if (!module.isStub && childCount > 0) cornerBits.push(`子${childCount}`)
    const attrCount = model.attributeModules.get(module.id)?.length ?? 0
    if (attrCount > 0) cornerBits.push(`属${attrCount}`)
    const flowCount = model.flowModules.get(module.id)?.length ?? 0
    if (flowCount > 0) cornerBits.push(`流${flowCount}`)
    if (cornerBits.length > 0) {
      group.append(svg('text', { class: 'corner-badge', x: pos.w - 8, y: pos.h - 6, 'text-anchor': 'end' }, cornerBits.join(' ')))
    }

    if (role !== null) {
      const glyph = role === 'source' ? '定' : role === 'writer' ? '改' : '读'
      group.append(svg('text', { class: 'role-badge', x: 10, y: pos.h - 6 }, glyph))
    }
    if (stepIndex >= 0) {
      const number = stepIndex + 1
      group.append(svg('circle', { class: 'flow-number', cx: pos.w - 13, cy: 13, r: 8 }))
      group.append(svg('text', { class: 'flow-number-text', x: pos.w - 13, y: 16.5, 'text-anchor': 'middle' }, String(number)))
    }
    if (module.isStub) {
      group.append(svg('text', { class: 'corner-badge', x: 24, y: 47 }, '双击跳到所属模块'))
    }
    const title = svg('title')
    title.textContent = `${label} · ${status.label}${module.summary ? `\n${module.summary}` : ''}${module.isStub ? '\n外部依赖，双击跳转' : ''}`
    group.append(title)
    nodesLayer.append(group)
    state.graph.nodeEls.set(module.id, group)
  }

  renderLegend({ mode, trace, flow })
  applyView()
}

function renderLegend(context) {
  const legend = $('legend')
  clear(legend)
  if (!context) return
  const { mode, trace, flow } = context
  if (mode === 'data') {
    legend.append(el('span', {}, el('i', { style: 'background:var(--blue)' }), '定义处'))
    legend.append(el('span', {}, el('i', { style: 'background:var(--amber)' }), '修改处'))
    legend.append(el('span', {}, el('i', { style: 'background:var(--green)' }), '读取处'))
    if (trace !== null) {
      legend.append(el('span', {}, el('i', { class: 'line', style: 'border-top-color:var(--amber)' }), '写属性'))
      legend.append(el('span', {}, el('i', { class: 'line', style: 'border-top-color:var(--green)' }), '读属性'))
    }
  } else if (mode === 'flow') {
    legend.append(el('span', {}, el('i', { class: 'line', style: 'border-top-color:var(--accent)' }), '执行顺序'))
    if (flow !== null) legend.append(el('span', {}, flow.label))
  } else {
    for (const [kind, def] of Object.entries(EDGE_KINDS)) {
      if (!state.graph.visibleEdges.some(edge => edge.kind === kind)) continue
      legend.append(el('span', {}, el('i', { class: 'line', style: `border-top-color:${def.color}` }), def.label))
    }
  }
  const model = state.graph.model
  if (model) {
    for (const [key, status] of Object.entries(STATUS)) {
      if (!model.modules.some(module => (module.status || 'unknown') === key)) continue
      legend.append(el('span', {}, el('i', { style: `background:${status.color}` }), status.label))
    }
  }
}

function renderCrumbs() {
  const box = $('crumbs')
  clear(box)
  const model = state.graph.model
  if (state.graph.mode !== 'deps' || model === null) {
    box.hidden = true
    return
  }
  box.hidden = false
  if (state.graph.subsystem !== null) {
    const subsystem = model.subsystemById.get(state.graph.subsystem)
    box.append(el('button', { type: 'button', text: '架构总览', onclick: () => setMode('arch') }))
    box.append(el('span', { class: 'sep', text: '/' }))
    box.append(el('span', { class: 'current', text: subsystem?.label || state.graph.subsystem }))
    box.append(el('span', { class: 'sep', text: '/' }))
    box.append(el('button', {
      type: 'button',
      text: '全部模块',
      onclick: () => {
        state.graph.subsystem = null
        state.graph.scope = null
        state.graph.selected = null
        rebuildGraph({ fit: true })
      },
    }))
    return
  }
  const chain = []
  let cursor = state.graph.scope
  while (typeof cursor === 'string' && model.byId.has(cursor)) {
    const module = model.byId.get(cursor)
    chain.unshift(module)
    cursor = module.parent ?? null
  }
  const rootButton = el('button', { type: 'button', text: '全部模块', onclick: () => enterScope(null) })
  if (chain.length === 0) rootButton.classList.add('current')
  box.append(rootButton)
  for (const module of chain) {
    box.append(el('span', { class: 'sep', text: '/' }))
    const button = el('button', { type: 'button', text: module.label, onclick: () => enterScope(module.id) })
    if (module.id === state.graph.scope) {
      button.classList.remove('current')
      box.append(el('span', { class: 'current', text: module.label }))
    } else {
      box.append(button)
    }
  }
}

function enterScope(scope) {
  state.graph.scope = scope
  state.graph.subsystem = null
  state.graph.archSelected = null
  state.graph.selected = null
  state.graph.selectedAttribute = null
  state.graph.selectedFlow = null
  rebuildGraph({ fit: true })
}

function statusCountsFor(members) {
  const counts = { done: 0, partial: 0, todo: 0, unknown: 0, blocked: 0 }
  for (const module of members) counts[STATUS[module.status] ? module.status : 'unknown'] += 1
  return counts
}

function buildArch(model) {
  const cards = []
  const subsystems = state.graph.showLater
    ? model.subsystems
    : model.subsystems.filter(subsystem => subsystem.horizon !== 'later')
  for (const subsystem of subsystems) {
    const members = expandSubsystem(model, subsystem)
    const memberIds = new Set(members.map(module => module.id))
    const counts = statusCountsFor(members)
    const attributes = [...model.attributes.values()].filter(attribute => {
      const refs = [attribute.sourceModule, ...(attribute.writtenBy || []), ...(attribute.readBy || [])].filter(Boolean)
      return refs.some(id => memberIds.has(id))
    })
    const flows = model.flows.filter(flow => (flow.steps || []).some(step => memberIds.has(step.module)))
    cards.push({
      subsystem,
      members,
      counts,
      attributes: attributes.length,
      flows: flows.length,
    })
  }
  const cardIds = new Set(cards.map(card => card.subsystem.id))
  const pairCounts = new Map()
  for (const edge of model.edges) {
    const fromSubs = model.moduleSubsystems.get(edge.from) || []
    const toSubs = model.moduleSubsystems.get(edge.to) || []
    for (const from of fromSubs) {
      for (const to of toSubs) {
        if (from === to || !cardIds.has(from) || !cardIds.has(to)) continue
        const key = `${from}->${to}`
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1)
      }
    }
  }
  const edges = [...pairCounts.entries()].map(([key, count]) => {
    const [from, to] = key.split('->')
    return { from, to, count }
  })
  const cardW = 260
  const cardH = 116
  const gapX = 28
  const gapY = 34
  const cols = 4
  const rootW = 380
  const rootH = 78
  const positions = new Map()
  positions.set('__arch_root', { x: -rootW / 2, y: 0, w: rootW, h: rootH })
  const rows = []
  for (let index = 0; index < cards.length; index += cols) rows.push(cards.slice(index, index + cols))
  const rowWidths = rows.map(row => row.length * cardW + (row.length - 1) * gapX)
  const width = Math.max(rootW, ...rowWidths) + 90
  let top = 152
  rows.forEach((row, rowIndex) => {
    const rowWidth = rowWidths[rowIndex]
    let x = -rowWidth / 2
    for (const card of row) {
      positions.set(card.subsystem.id, { x, y: top, w: cardW, h: cardH })
      x += cardW + gapX
    }
    top += cardH + gapY
  })
  return { cards, edges, positions, width, height: top, rootW, rootH, cardW, cardH }
}

function splitSummary(text, limit = 22) {
  const value = String(text || '')
  if (value.length <= limit) return [value]
  return [value.slice(0, limit), value.length > limit * 2 ? `${value.slice(limit, limit * 2 - 1)}…` : value.slice(limit)]
}

function renderArch() {
  cancelAnimationFrame(state.graph.frame)
  const canvas = $('canvas')
  const model = state.graph.model
  const empty = $('canvas-empty')
  if (!model || model.subsystems.length === 0) {
    clear(canvas)
    empty.hidden = false
    clear(empty)
    empty.append(el('strong', { text: state.index?.mapError ? '结构图数据有误' : '还没有概念子系统' }))
    empty.append(el('span', { text: state.index?.mapError || '在 project-map.json 的 subsystems 里定义渲染、移动、卡牌等概念模块。' }))
    renderArchLegend(null)
    return
  }
  empty.hidden = true
  const arch = buildArch(model)
  state.graph.arch = arch
  state.graph.archLayout = arch
  if (state.graph.archSelected !== null && !arch.cards.some(card => card.subsystem.id === state.graph.archSelected)) {
    state.graph.archSelected = null
  }
  const query = state.graph.search.trim().toLowerCase()
  const selected = state.graph.archSelected
  clear(canvas)
  const defs = svg('defs')
  const marker = svg('marker', {
    id: 'arch-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5,
    markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
  })
  marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#9aa3af' }))
  defs.append(marker)
  canvas.append(defs)
  const viewport = svg('g', { id: 'viewport' })
  canvas.append(viewport)
  const rootPos = arch.positions.get('__arch_root')

  // Root → subsystem containment lines.
  for (const card of arch.cards) {
    const pos = arch.positions.get(card.subsystem.id)
    viewport.append(svg('path', {
      class: 'arch-link',
      d: `M ${rootPos.x + rootPos.w / 2} ${rootPos.y + rootPos.h} C ${rootPos.x + rootPos.w / 2} ${rootPos.y + rootPos.h + 36}, ${pos.x + pos.w / 2} ${pos.y - 36}, ${pos.x + pos.w / 2} ${pos.y}`,
    }))
  }

  // Subsystem → subsystem dependency summaries.
  for (const edge of arch.edges) {
    const from = arch.positions.get(edge.from)
    const to = arch.positions.get(edge.to)
    if (!from || !to) continue
    const sameRow = Math.abs(from.y - to.y) < 1
    let d
    if (sameRow) {
      const leftToRight = to.x > from.x
      const x1 = leftToRight ? from.x + from.w : from.x
      const x2 = leftToRight ? to.x : to.x + to.w
      const y = from.y + from.h / 2
      const mid = (x1 + x2) / 2
      d = `M ${x1} ${y} C ${mid} ${y}, ${mid} ${y}, ${x2} ${y}`
    } else {
      const x1 = from.x + from.w / 2
      const y1 = from.y + from.h
      const x2 = to.x + to.w / 2
      const y2 = to.y
      const bend = Math.max(24, Math.abs(y2 - y1) / 2)
      d = `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`
    }
    viewport.append(svg('path', { class: 'arch-dep', d, 'marker-end': 'url(#arch-arrow)' }))
    const midX = sameRow ? (Math.min(from.x + from.w, to.x + to.w) + Math.max(from.x, to.x)) / 2 : (from.x + from.w / 2 + to.x + to.w / 2) / 2
    const midY = sameRow ? from.y + from.h / 2 - 5 : (from.y + from.h + to.y) / 2
    viewport.append(svg('text', { class: 'arch-dep-label', x: midX, y: midY, 'text-anchor': 'middle' }, String(edge.count)))
  }

  // Root card.
  const root = svg('g', { class: 'arch-root', 'data-arch': '__arch_root' })
  root.append(svg('rect', { class: 'arch-card', x: rootPos.x, y: rootPos.y, width: rootPos.w, height: rootPos.h, rx: 12 }))
  root.append(svg('rect', { class: 'arch-stripe', x: rootPos.x, y: rootPos.y, width: 6, height: rootPos.h, rx: 3 }))
  root.append(svg('text', { class: 'arch-label', x: rootPos.x + 20, y: rootPos.y + 27 }, state.index?.projectName || '当前项目'))
  root.append(svg('text', { class: 'arch-meta', x: rootPos.x + 20, y: rootPos.y + 46 }, state.index?.phase || '自上而下的概念分解'))
  root.append(svg('text', { class: 'arch-meta', x: rootPos.x + 20, y: rootPos.y + 63 }, `${arch.cards.length} 个子系统 · ${model.modules.length} 个实现模块`))
  viewport.append(root)

  for (const card of arch.cards) {
    const pos = arch.positions.get(card.subsystem.id)
    const subsystem = card.subsystem
    const concern = CONCERNS[subsystem.concern] || CONCERNS.gameplay
    const dimmed = query !== '' && !(`${subsystem.label} ${subsystem.summary}`.toLowerCase().includes(query))
    const classes = ['arch-node']
    if (subsystem.id === selected) classes.push('selected')
    if (dimmed) classes.push('dimmed')
    const group = svg('g', {
      class: classes.join(' '),
      'data-arch': subsystem.id,
      tabindex: 0,
      role: 'button',
      'aria-label': `${subsystem.label}，${concern.label}，${card.members.length} 个模块`,
      style: `--concern:${concern.color}`,
      transform: `translate(${pos.x} ${pos.y})`,
    })
    group.append(svg('rect', { class: 'arch-card', x: 0, y: 0, width: pos.w, height: pos.h, rx: 11 }))
    group.append(svg('rect', { class: 'arch-stripe', x: 0, y: 0, width: 6, height: pos.h, rx: 3 }))
    group.append(svg('text', { class: 'arch-label', x: 18, y: 24 }, subsystem.label))
    group.append(svg('text', { class: 'arch-concern', x: pos.w - 12, y: 18, 'text-anchor': 'end' }, concern.label))
    const done = card.counts.done
    const total = Math.max(1, card.members.length)
    group.append(svg('text', { class: 'arch-meta', x: 18, y: 43 }, `${card.members.length} 个模块 · 完成 ${done}/${card.members.length}`))
    const lines = splitSummary(subsystem.summary)
    lines.forEach((line, index) => group.append(svg('text', { class: 'arch-summary', x: 18, y: 61 + index * 12 }, line)))
    group.append(svg('rect', { class: 'arch-progress-bg', x: 18, y: 88, width: pos.w - 36, height: 5, rx: 2.5 }))
    const trackWidth = pos.w - 36
    const doneWidth = (card.counts.done / total) * trackWidth
    const partialWidth = (card.counts.partial / total) * trackWidth
    if (doneWidth > 0) group.append(svg('rect', { class: 'arch-progress-done', x: 18, y: 88, width: doneWidth, height: 5, rx: 2.5 }))
    if (partialWidth > 0) group.append(svg('rect', { class: 'arch-progress-partial', x: 18 + doneWidth, y: 88, width: partialWidth, height: 5, rx: 2.5 }))
    group.append(svg('text', { class: 'arch-meta', x: 18, y: 107 }, `属 ${card.attributes} · 流 ${card.flows}`))
    const title = svg('title')
    title.textContent = `${subsystem.label}（${concern.label}）\n${subsystem.summary || ''}\n双击进入模块依赖`
    group.append(title)
    viewport.append(group)
  }
  renderArchLegend(arch)
  applyView()
}

function renderArchLegend(arch) {
  const legend = $('legend')
  clear(legend)
  if (!arch) return
  const used = new Set(arch.cards.map(card => card.subsystem.concern))
  for (const [key, concern] of Object.entries(CONCERNS)) {
    if (!used.has(key)) continue
    legend.append(el('span', {}, el('i', { style: `background:${concern.color}` }), concern.label))
  }
  legend.append(el('span', {}, '箭头 / 数字 = 子系统间模块依赖条数'))
}

function fitArch() {
  const arch = state.graph.arch
  const canvas = $('canvas')
  if (!arch) return
  const nodes = [...arch.positions.values()]
  if (nodes.length === 0) return
  const minX = Math.min(...nodes.map(node => node.x))
  const minY = Math.min(...nodes.map(node => node.y))
  const maxX = Math.max(...nodes.map(node => node.x + node.w))
  const maxY = Math.max(...nodes.map(node => node.y + node.h))
  const padding = 80
  const k = clamp(Math.min((canvas.clientWidth - padding * 2) / Math.max(1, maxX - minX), (canvas.clientHeight - padding * 2) / Math.max(1, maxY - minY)), 0.2, 1.2)
  state.graph.view = {
    k,
    x: canvas.clientWidth / 2 - ((minX + maxX) / 2) * k,
    y: canvas.clientHeight / 2 - ((minY + maxY) / 2) * k,
  }
  applyView()
  saveLayout()
}

function selectArch(id) {
  state.graph.archSelected = id
  for (const node of document.querySelectorAll('.arch-node')) {
    node.classList.toggle('selected', node.dataset.arch === id)
  }
  renderInspector()
}

function openSubsystem(id, moduleId = null) {
  state.graph.mode = 'deps'
  state.graph.subsystem = id
  state.graph.scope = null
  state.graph.selected = moduleId
  state.graph.archSelected = null
  state.graph.selectedAttribute = null
  state.graph.selectedFlow = null
  syncModeUi()
  rebuildGraph({ fit: true })
  renderInspector()
}

function edgeLabel(model, id) {
  const module = model.byId.get(id)
  if (module) return String(module.label || id)
  const stub = state.graph.stubs.find(item => item.id === id)
  return String(stub?.label || id.replace(/^stub:/, ''))
}

function edgePath(from, to) {
  if (Math.abs(from.y - to.y) < 1) {
    const leftToRight = to.x > from.x
    const x1 = leftToRight ? from.x + from.w : from.x
    const x2 = leftToRight ? to.x : to.x + to.w
    const y = from.y + from.h / 2
    const mid = (x1 + x2) / 2
    return `M ${x1} ${y} C ${mid} ${y}, ${mid} ${y}, ${x2} ${y}`
  }
  if (to.y < from.y) {
    const x1 = from.x + from.w
    const y1 = from.y + from.h / 2
    const x2 = to.x + to.w
    const y2 = to.y + to.h / 2
    const lane = Math.max(x1, x2) + 30
    return `M ${x1} ${y1} C ${lane} ${y1}, ${lane} ${y2}, ${x2} ${y2}`
  }
  const x1 = from.x + from.w / 2
  const y1 = from.y + from.h
  const x2 = to.x + to.w / 2
  const y2 = to.y
  const bend = Math.max(24, (y2 - y1) / 2)
  return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`
}

function applyView() {
  const viewport = document.querySelector('#viewport')
  if (!viewport) return
  const view = state.graph.view
  viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`)
  $('zoom-hud').textContent = `${Math.round(view.k * 100)}%`
}

function fitView(animate = false) {
  if (state.graph.mode === 'arch') {
    fitArch()
    return
  }
  const layout = state.graph.layout
  const canvas = $('canvas')
  if (!layout) return
  const nodes = visibleNodes().map(module => layout.positions.get(module.id)).filter(Boolean)
  if (nodes.length === 0) return
  const minX = Math.min(...nodes.map(node => node.x))
  const minY = Math.min(...nodes.map(node => node.y))
  const maxX = Math.max(...nodes.map(node => node.x + node.w))
  const maxY = Math.max(...nodes.map(node => node.y + node.h))
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const padding = 70
  const k = clamp(Math.min((width - padding * 2) / Math.max(1, maxX - minX), (height - padding * 2) / Math.max(1, maxY - minY)), 0.12, 1.3)
  state.graph.view = {
    k,
    x: width / 2 - ((minX + maxX) / 2) * k,
    y: height / 2 - ((minY + maxY) / 2) * k,
  }
  applyView()
  saveLayout()
}

function zoomAt(factor, clientX, clientY) {
  const canvas = $('canvas')
  const rect = canvas.getBoundingClientRect()
  const view = state.graph.view
  const mx = (clientX ?? rect.left + rect.width / 2) - rect.left
  const my = (clientY ?? rect.top + rect.height / 2) - rect.top
  const worldX = (mx - view.x) / view.k
  const worldY = (my - view.y) / view.k
  const next = clamp(view.k * factor, 0.12, 3)
  state.graph.view = { k: next, x: mx - worldX * next, y: my - worldY * next }
  applyView()
  saveLayout()
}

function centerNode(id, zoom) {
  const layout = state.graph.layout
  const node = layout?.positions.get(id)
  if (!node) return
  const canvas = $('canvas')
  const view = state.graph.view
  const k = zoom ?? view.k
  state.graph.view = {
    k,
    x: canvas.clientWidth / 2 - (node.x + node.w / 2) * k,
    y: canvas.clientHeight / 2 - (node.y + node.h / 2) * k,
  }
  applyView()
  saveLayout()
}

function saveLayout() {
  clearTimeout(state.graph.saveTimer)
  state.graph.saveTimer = setTimeout(writeLayout, 220)
}

function writeLayout() {
  const key = `dsh-project-board:layout:v1:${state.root}`
  try {
    localStorage.setItem(key, JSON.stringify({
      positions: state.graph.manual,
      view: state.graph.view,
    }))
  } catch {
    // Storage may be unavailable in private windows.
  }
}

function loadLayout() {
  const server = state.index?.layout?.positions
  state.graph.serverLayout = server !== null && typeof server === 'object' ? { ...server } : {}
  state.graph.manual = {}
  state.graph.view = { x: 0, y: 0, k: 1 }
  const key = `dsh-project-board:layout:v1:${state.root}`
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed.positions !== null && typeof parsed.positions === 'object') {
        state.graph.manual = { ...parsed.positions }
      }
      if (parsed.view && Number.isFinite(parsed.view.k) && Number.isFinite(parsed.view.x) && Number.isFinite(parsed.view.y)) {
        state.graph.view = { x: parsed.view.x, y: parsed.view.y, k: clamp(parsed.view.k, 0.12, 3) }
      }
    }
  } catch {
    // Ignore corrupt storage.
  }
}

function exportLayout() {
  download(`project-board-layout.json`, JSON.stringify({
    version: 1,
    root: state.root,
    exportedAt: new Date().toISOString(),
    positions: { ...state.graph.serverLayout, ...state.graph.manual },
  }, null, 2), 'application/json')
  toast('布局已导出')
}

function exportSvg() {
  const canvas = $('canvas')
  const layout = state.graph.layout
  if (!layout) return
  const nodes = visibleNodes().map(module => layout.positions.get(module.id)).filter(Boolean)
  if (nodes.length === 0) return
  const minX = Math.min(...nodes.map(node => node.x)) - 40
  const minY = Math.min(...nodes.map(node => node.y)) - 40
  const maxX = Math.max(...nodes.map(node => node.x + node.w)) + 40
  const maxY = Math.max(...nodes.map(node => node.y + node.h)) + 40
  const clone = canvas.cloneNode(true)
  clone.setAttribute('width', String(Math.ceil(maxX - minX)))
  clone.setAttribute('height', String(Math.ceil(maxY - minY)))
  clone.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`)
  clone.style.background = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#fff'
  const viewport = clone.querySelector('#viewport')
  if (viewport) viewport.removeAttribute('transform')
  const style = document.createElementNS(SVGNS, 'style')
  style.textContent = `
    .layer-band{fill:#eef0f3;opacity:.55}.layer-label{fill:#8f959e;font-size:10.5px;font-weight:600}
    .layer-count{fill:#8f959e;font-size:9.5px}.edge{fill:none;stroke:#9aa3af;stroke-width:1.35;opacity:.6}
    .edge.kind-contains{stroke:#3370ff}.edge.kind-uses{stroke:#d97706}.edge.kind-event{stroke:#2ea121}
    .node .card{fill:#fff;stroke-width:1.3}.node .label{fill:#1f2329;font-size:12px;font-weight:600}
    .node .sublabel{fill:#8f959e;font-size:9.5px}.node .status-dot{fill:#8f959e}
    .node.selected .card{stroke:#3370ff;stroke-width:2.6}.node.dimmed{opacity:.25}
    text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
  `
  clone.prepend(style)
  const xml = new XMLSerializer().serializeToString(clone)
  download('project-board.svg', `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`, 'image/svg+xml')
  toast('SVG 已导出')
}

function renderInspector() {
  const box = $('inspector')
  clear(box)
  const model = state.graph.model
  if (!model) {
    box.append(el('p', { class: 'empty', text: '没有结构图数据。创建 docs/board/project-map.json 后这里会显示模块关系。' }))
    return
  }
  if (state.graph.mode === 'arch') return renderArchInspector(box, model)
  if (state.graph.mode === 'data') return renderDataInspector(box, model)
  if (state.graph.mode === 'flow') return renderFlowInspector(box, model)
  return renderDepsInspector(box, model)
}

function renderArchInspector(box, model) {
  const selectedId = state.graph.archSelected
  if (selectedId === null) {
    box.append(el('h3', { text: '架构总览' }))
    box.append(el('div', { class: 'sub', text: '自上而下：项目 → 概念子系统 → 实现模块' }))
    box.append(el('div', { class: 'sub', text: `${model.subsystems.length} 个子系统 · ${model.modules.length} 个模块` }))
    if (model.subsystems.length === 0) {
      box.append(el('p', { class: 'empty', text: '还没有概念子系统。在 project-map.json 的 subsystems 里定义渲染、移动、卡牌等模块。' }))
      return
    }
    const visibleSubsystems = state.graph.arch?.cards.map(card => card.subsystem) || model.subsystems
    for (const subsystem of visibleSubsystems) {
      const members = expandSubsystem(model, subsystem)
      const counts = statusCountsFor(members)
      const concern = CONCERNS[subsystem.concern] || CONCERNS.gameplay
      box.append(el('button', {
        class: 'doc-item',
        title: subsystem.summary,
        onclick: () => selectArch(subsystem.id),
      },
        el('span', {}, subsystem.label, el('span', { class: 'muted', text: ` · ${concern.label}` })),
        el('small', {}, `${members.length} 个模块 · 完成 ${counts.done}`),
      ))
    }
    const laterCount = model.subsystems.filter(subsystem => subsystem.horizon === 'later').length
    if (laterCount > 0) {
      box.append(el('div', { class: 'actions' },
        el('button', {
          class: 'btn small',
          text: state.graph.showLater ? '只看当前 / 短期' : `显示长期子系统（${laterCount}）`,
          onclick: () => {
            state.graph.showLater = !state.graph.showLater
            renderArch()
            renderInspector()
          },
        }),
      ))
    }
    box.append(el('p', { class: 'empty', style: 'margin-top:12px' }, '双击画布上的子系统卡片进入模块依赖；切换「依赖」可看全部模块。'))
    return
  }
  const subsystem = model.subsystemById.get(selectedId)
  if (!subsystem) {
    state.graph.archSelected = null
    renderArch()
    renderInspector()
    return
  }
  const members = expandSubsystem(model, subsystem)
  const counts = statusCountsFor(members)
  const concern = CONCERNS[subsystem.concern] || CONCERNS.gameplay
  box.append(el('h3', { text: subsystem.label }))
  box.append(el('span', { class: 'badge', style: `--status:${concern.color}` }, el('i'), concern.label))
  box.append(el('p', { text: subsystem.summary || '暂无说明' }))
  const grid = el('div', { class: 'stat-grid' })
  for (const key of ['done', 'partial', 'todo', 'unknown', 'blocked']) {
    if (key === 'blocked' && counts.blocked === 0) continue
    grid.append(el('div', { class: 'stat' },
      el('b', { text: String(counts[key]), style: `color:${STATUS[key].color}` }),
      el('span', { text: STATUS[key].label }),
    ))
  }
  box.append(grid)
  box.append(el('div', { class: 'actions' },
    el('button', { class: 'btn small', text: '进入模块依赖', onclick: () => openSubsystem(subsystem.id) }),
    el('button', { class: 'btn small', text: '返回总览', onclick: () => { state.graph.archSelected = null; renderArch(); renderInspector() } }),
  ))
  const arch = state.graph.arch || buildArch(model)
  const outgoing = arch.edges.filter(edge => edge.from === subsystem.id)
  const incoming = arch.edges.filter(edge => edge.to === subsystem.id)
  const subsystemChip = edge => el('button', {
    class: 'chip',
    onclick: () => selectArch(edge.from === subsystem.id ? edge.to : edge.from),
  }, `${model.subsystemById.get(edge.from === subsystem.id ? edge.to : edge.from)?.label || ''} ×${edge.count}`)
  if (incoming.length > 0) {
    box.append(el('div', { class: 'section' }, el('h4', { text: '被依赖' }), el('div', { class: 'chips' }, incoming.map(subsystemChip))))
  }
  if (outgoing.length > 0) {
    box.append(el('div', { class: 'section' }, el('h4', { text: '依赖' }), el('div', { class: 'chips' }, outgoing.map(subsystemChip))))
  }
  box.append(el('div', { class: 'section' }, el('h4', { text: `包含模块（${members.length}）` }),
    el('div', { class: 'chips' }, members.map(module =>
      el('button', {
        class: 'chip',
        title: module.summary || module.id,
        onclick: () => openSubsystem(subsystem.id, module.id),
      }, module.label)))))
}

function renderDepsInspector(box, model) {
  const selected = state.graph.selected
  if (selected === null && state.graph.subsystem !== null) {
    const subsystem = model.subsystemById.get(state.graph.subsystem)
    if (subsystem) {
      const members = expandSubsystem(model, subsystem)
      const counts = statusCountsFor(members)
      const concern = CONCERNS[subsystem.concern] || CONCERNS.gameplay
      box.append(el('h3', { text: subsystem.label }))
      box.append(el('span', { class: 'badge', style: `--status:${concern.color}` }, el('i'), concern.label))
      box.append(el('p', { text: subsystem.summary || '暂无说明' }))
      const grid = el('div', { class: 'stat-grid' })
      for (const key of ['done', 'partial', 'todo', 'unknown', 'blocked']) {
        if (key === 'blocked' && counts.blocked === 0) continue
        grid.append(el('div', { class: 'stat' },
          el('b', { text: String(counts[key]), style: `color:${STATUS[key].color}` }),
          el('span', { text: STATUS[key].label }),
        ))
      }
      box.append(grid)
      box.append(el('div', { class: 'actions' },
        el('button', { class: 'btn small', text: '架构总览', onclick: () => setMode('arch') }),
        el('button', { class: 'btn small', text: '全部模块', onclick: () => { state.graph.subsystem = null; rebuildGraph({ fit: true }) } }),
      ))
      box.append(el('p', { class: 'empty', style: 'margin-top:10px' }, '双击有子模块的节点可继续下钻；点节点看模块详情。'))
      return
    }
  }
  if (selected === null) {
    const modules = model.modules
    const counts = { done: 0, partial: 0, todo: 0, unknown: 0, blocked: 0 }
    for (const module of modules) countKey(counts, module.status)
    box.append(el('h3', { text: '项目结构' }))
    box.append(el('div', { class: 'sub', text: `${modules.length} 个模块 · ${model.edges.length} 条依赖` }))
    const grid = el('div', { class: 'stat-grid' })
    for (const key of ['done', 'partial', 'todo', 'unknown', 'blocked']) {
      if (key === 'blocked' && counts.blocked === 0) continue
      grid.append(el('div', { class: 'stat' },
        el('b', { text: String(counts[key]), style: `color:${STATUS[key].color}` }),
        el('span', { text: STATUS[key].label }),
      ))
    }
    box.append(grid)
    const focus = state.index?.map?.focus || []
    if (focus.length > 0) {
      box.append(el('div', { class: 'section' }, el('h4', { text: '下一步建议' }),
        focus.map(item => {
          const moduleId = typeof item === 'string' ? item : item?.module
          const module = modules.find(entry => entry.id === moduleId)
          if (!module) return null
          return el('div', { class: 'focus-item' },
            el('b', { text: module.label }),
            el('span', { text: typeof item === 'string' ? '' : item.why || '' }),
          )
        }),
      ))
    }
    if (state.index?.layoutError) {
      box.append(el('div', { class: 'error-box', text: state.index.layoutError, style: 'margin-top:12px' }))
    }
    box.append(el('div', { class: 'section' }, el('p', { class: 'empty', text: '双击有子模块的节点进入下级；节点角标「子N / 属N / 流N」分别表示子模块、关键属性、执行流程。切到「数据流」或「流程」看跨系统链路。' })))
    return
  }

  const stub = state.graph.stubs.find(item => item.id === selected)
  const module = stub ? model.byId.get(stub.realId) : model.byId.get(selected)
  if (!module) return
  const isStub = Boolean(stub)
  const status = STATUS[module.status] || STATUS.unknown
  const layer = model.layers.find(entry => entry.id === module.layer)
  const childList = isStub ? [] : (model.children.get(module.id) || [])
  const dependsOn = model.edges.filter(edge => edge.from === module.id).map(edge => edge.to)
  const usedBy = model.edges.filter(edge => edge.to === module.id).map(edge => edge.from)
  const attributes = model.attributeModules.get(module.id) || []
  const flows = model.flowModules.get(module.id) || []

  box.append(el('h3', { text: module.label }))
  box.append(el('div', { class: 'sub', text: module.id }))
  box.append(el('span', { class: 'badge', style: `--status:${status.color}` }, el('i'), status.label))
  if (layer) box.append(el('div', { class: 'sub', text: layer.label, style: 'margin-top:6px' }))
  if (module.entry) box.append(el('div', { class: 'path', text: `入口：${module.entry}`, style: 'margin-top:6px' }))
  if (module.path) box.append(el('div', { class: 'path', text: module.path, style: 'margin-top:6px' }))
  box.append(el('p', { text: module.summary || '暂无说明' }))

  const actions = [
    el('button', { class: 'btn small', text: '居中', onclick: () => centerNode(module.id, Math.max(state.graph.view.k, 1)) }),
    el('button', { class: 'btn small', text: '复制 ID', onclick: () => copyText(module.id) }),
  ]
  if (isStub) {
    actions.unshift(el('button', { class: 'btn small', text: '跳到所属模块', onclick: () => jumpToModule(module.id) }))
  } else if (childList.length > 0) {
    actions.unshift(el('button', { class: 'btn small', text: `进入子模块（${childList.length}）`, onclick: () => enterScope(module.id) }))
  }
  box.append(el('div', { class: 'actions' }, actions))

  if (childList.length > 0) {
    box.append(el('div', { class: 'section' },
      el('h4', { text: `子模块（${childList.length}）` }),
      el('div', { class: 'chips' }, childList.map(child =>
        el('button', { class: 'chip', title: child.summary || child.id, onclick: () => jumpToModule(child.id) }, child.label),
      )),
    ))
    if (dependsOn.length === 0) {
      box.append(el('p', { class: 'empty', text: '子模块的依赖已汇总到父节点；双击进入可看内部连线。' }))
    }
  }
  if (attributes.length > 0) {
    box.append(el('div', { class: 'section' }, el('h4', { text: '关键属性' }),
      el('div', { class: 'chips' }, attributes.map(id => {
        const attribute = model.attributes.get(id)
        return el('button', { class: 'chip', title: attribute?.source || id, onclick: () => openAttribute(id) }, attribute?.label || id)
      }))))
  }
  if (flows.length > 0) {
    box.append(el('div', { class: 'section' }, el('h4', { text: '执行流程' }),
      el('div', { class: 'chips' }, flows.map(id => {
        const flow = model.flows.find(entry => entry.id === id)
        return el('button', { class: 'chip', onclick: () => openFlow(id) }, flow?.label || id)
      }))))
  }
  if (dependsOn.length > 0) {
    box.append(el('div', { class: 'section' }, el('h4', { text: '依赖' }),
      el('div', { class: 'chips' }, dependsOn.map(id => chipFor(model, id)))))
  }
  if (usedBy.length > 0) {
    box.append(el('div', { class: 'section' }, el('h4', { text: '被依赖' }),
      el('div', { class: 'chips' }, usedBy.map(id => chipFor(model, id)))))
  }
}

function renderDataInspector(box, model) {
  const selected = state.graph.selectedAttribute
  const attribute = selected ? model.attributes.get(selected) : null
  if (!attribute) {
    box.append(el('h3', { text: '关键属性' }))
    box.append(el('div', { class: 'sub', text: `${model.attributes.size} 个属性 · 只维护影响手感/规则的关键值` }))
    if (model.attributes.size === 0) {
      box.append(el('p', { class: 'empty', text: '还没有属性。在 project-map.json 的 attributes 里登记关键属性。' }))
      return
    }
    for (const item of model.attributes.values()) {
      box.append(el('button', {
        class: 'doc-item',
        title: item.source,
        onclick: () => openAttribute(item.id),
      },
        el('span', {}, item.label, el('span', { class: 'muted', text: ` · ${attributeKind(item.kind)}` })),
        el('small', {}, `${item.source}${item.status === 'confirmed' ? '' : ' · 待确认'}`),
      ))
    }
    box.append(el('p', { class: 'empty', style: 'margin-top:12px' }, '点击属性查看「在哪定义、谁修改、传给谁」。也可以在依赖视图点模块角标进入。'))
    return
  }
  const sourceId = attribute.sourceModule
  const moduleChip = (id, prefix) => el('button', {
    class: 'chip',
    title: id,
    onclick: () => focusModule(id),
  }, `${prefix}${model.byId.get(id)?.label || id}`)
  box.append(el('h3', { text: attribute.label }))
  box.append(el('div', { class: 'sub', text: `${attribute.id} · ${attributeKind(attribute.kind)}` }))
  box.append(el('span', { class: 'badge', style: `--status:${attribute.status === 'confirmed' ? 'var(--green)' : 'var(--amber)'}` },
    el('i'),
    attribute.status === 'confirmed' ? '已确认' : '待确认',
  ))
  box.append(el('div', { class: 'path', text: attribute.source, style: 'margin-top:8px' }))
  const meta = el('div', { class: 'stat-grid' })
  meta.append(el('div', { class: 'stat' }, el('b', { text: attribute.default === null || attribute.default === undefined ? '待定' : String(attribute.default) }), el('span', { text: '默认值（用户拍板）' })))
  meta.append(el('div', { class: 'stat' }, el('b', { text: attribute.tunable ? '可调' : '固定' }), el('span', { text: '运行时是否可调' })))
  box.append(meta)
  if (attribute.affects?.length > 0) {
    box.append(el('div', { class: 'section' }, el('h4', { text: '影响' }), el('div', { class: 'chips' }, attribute.affects.map(text => el('span', { class: 'chip' }, text)))))
  }
  const writers = attribute.writtenBy || []
  const readers = attribute.readBy || []
  box.append(el('div', { class: 'section' }, el('h4', { text: '定义 / 修改' }),
    el('div', { class: 'chips' },
      sourceId ? moduleChip(sourceId, '定：') : null,
      writers.filter(id => id !== sourceId).map(id => moduleChip(id, '改：')),
    )))
  if (readers.length > 0) {
    box.append(el('div', { class: 'section' }, el('h4', { text: '传递到（读取）' }),
      el('div', { class: 'chips' }, readers.map(id => moduleChip(id, '读：')))))
  }
  box.append(el('div', { class: 'actions' },
    el('button', { class: 'btn small', text: '看全部属性', onclick: () => { state.graph.selectedAttribute = null; renderGraph(); renderInspector() } }),
    sourceId ? el('button', { class: 'btn small', text: '定位来源', onclick: () => focusModule(sourceId) }) : null,
  ))
}

function renderFlowInspector(box, model) {
  const flow = currentFlow(model)
  if (!flow) {
    box.append(el('h3', { text: '执行流程' }))
    box.append(el('div', { class: 'sub', text: `${model.flows.length} 条流程` }))
    if (model.flows.length === 0) {
      box.append(el('p', { class: 'empty', text: '还没有流程。在 project-map.json 的 flows 里登记一次执行的步骤。' }))
      return
    }
    for (const item of model.flows) {
      box.append(el('button', { class: 'doc-item', onclick: () => openFlow(item.id) },
        el('span', {}, item.label),
        el('small', {}, `${item.trigger || '未标触发'} · ${(item.steps || []).length} 步`),
      ))
    }
    box.append(el('p', { class: 'empty', style: 'margin-top:12px' }, '选中一条流程：画布会按步骤编号高亮，下面逐帧看读写。'))
    return
  }
  const steps = flow.steps || []
  const current = clamp(state.graph.flowStep, 0, Math.max(0, steps.length - 1))
  box.append(el('h3', { text: flow.label }))
  box.append(el('div', { class: 'sub', text: `触发：${flow.trigger || '未标注'} · ${steps.length} 步 · ${flow.status === 'confirmed' ? '已确认' : '草稿'}` }))
  box.append(el('div', { class: 'actions' },
    el('button', { class: 'btn small', text: '上一步', disabled: current === 0, onclick: () => stepFlow(-1) }),
    el('button', { class: 'btn small', text: '下一步', disabled: current >= steps.length - 1, onclick: () => stepFlow(1) }),
    el('button', { class: 'btn small', text: '看全部流程', onclick: () => { state.graph.selectedFlow = null; syncModeUi(); renderGraph(); renderInspector() } }),
  ))
  steps.forEach((step, index) => {
    const module = model.byId.get(step.module)
    const row = el('button', {
      class: 'doc-item',
      style: index === current ? 'background:var(--accent-soft)' : '',
      onclick: () => {
        state.graph.flowStep = index
        state.graph.selected = step.module
        renderGraph()
        renderInspector()
        centerNode(step.module, Math.max(state.graph.view.k, 1))
      },
    },
      el('span', {}, `${index + 1}. ${module?.label || step.module}`),
      el('small', {}, step.action),
    )
    const io = []
    if (step.reads?.length) io.push(`读 ${step.reads.map(id => model.attributes.get(id)?.label || id).join(' / ')}`)
    if (step.writes?.length) io.push(`写 ${step.writes.map(id => model.attributes.get(id)?.label || id).join(' / ')}`)
    if (io.length > 0) row.append(el('small', { class: 'muted' }, io.join(' · ')))
    box.append(row)
  })
}

function attributeKind(kind) {
  return kind === 'config' ? '配置' : kind === 'state' ? '运行时状态' : kind === 'derived' ? '派生值' : kind
}

function countKey(counts, status) {
  const key = STATUS[status] ? status : 'unknown'
  counts[key] += 1
}

function chipFor(model, id) {
  const module = model.byId.get(id)
  return el('button', {
    class: 'chip',
    title: module?.summary || id,
    onclick: () => jumpToModule(id),
  }, module?.label || id)
}

function jumpToModule(id) {
  const model = state.graph.model
  const module = model?.byId.get(id)
  if (!module) return
  state.graph.mode = 'deps'
  state.graph.subsystem = null
  state.graph.scope = module.parent ?? null
  state.graph.archSelected = null
  state.graph.selected = id
  state.graph.selectedAttribute = null
  state.graph.selectedFlow = null
  syncModeUi()
  rebuildGraph({ fit: true })
  renderInspector()
}

function openAttribute(id) {
  state.graph.mode = 'data'
  state.graph.scope = null
  state.graph.selected = null
  state.graph.selectedAttribute = id
  state.graph.selectedFlow = null
  syncModeUi()
  rebuildGraph({ fit: true })
  renderInspector()
}

function openFlow(id) {
  state.graph.mode = 'flow'
  state.graph.scope = null
  state.graph.selected = null
  state.graph.selectedAttribute = null
  state.graph.selectedFlow = id
  state.graph.flowStep = 0
  syncModeUi()
  rebuildGraph({ fit: true })
  renderInspector()
}

function stepFlow(delta) {
  const model = state.graph.model
  const flow = currentFlow(model)
  if (!flow) return
  const steps = flow.steps || []
  const next = clamp(state.graph.flowStep + delta, 0, steps.length - 1)
  state.graph.flowStep = next
  state.graph.selected = steps[next]?.module ?? null
  renderGraph()
  renderInspector()
  const moduleId = steps[next]?.module
  if (moduleId) centerNode(moduleId, Math.max(state.graph.view.k, 1))
}

function focusModule(id) {
  const module = state.graph.model?.byId.get(id)
  if (!module) return
  state.graph.selected = id
  renderGraph()
  renderInspector()
  if (state.graph.layout?.positions.has(id)) centerNode(id, Math.max(state.graph.view.k, 1))
}

function activateNode(id) {
  const model = state.graph.model
  const stub = state.graph.stubs.find(item => item.id === id)
  if (stub) {
    jumpToModule(stub.realId)
    return
  }
  const module = model?.byId.get(id)
  if (!module) return
  if (state.graph.mode === 'deps' && state.graph.subsystem === null && (model.children.get(id)?.length ?? 0) > 0) {
    enterScope(id)
    return
  }
  if (state.graph.mode === 'flow') {
    const flow = currentFlow(model)
    const step = flowStepOf(flow, id)
    if (step >= 0) state.graph.flowStep = step
  }
  state.graph.selected = id
  renderGraph()
  renderInspector()
  if (state.graph.layout?.positions.has(id)) centerNode(id, clamp(Math.max(state.graph.view.k * 1.2, 1), 0.2, 2))
}

function setMode(mode) {
  state.graph.mode = mode
  state.graph.search = ''
  if ($('graph-search') !== null) $('graph-search').value = ''
  state.graph.selected = null
  if (mode !== 'data') state.graph.selectedAttribute = null
  if (mode !== 'flow') state.graph.selectedFlow = null
  if (mode === 'deps') {
    state.graph.subsystem = null
    state.graph.scope = null
    state.graph.archSelected = null
  }
  if (mode === 'arch') {
    state.graph.subsystem = null
    state.graph.scope = null
    state.graph.archSelected = null
  }
  const model = state.graph.model
  if (mode === 'data' && state.graph.selectedAttribute === null && model?.attributes.size > 0) {
    state.graph.selectedAttribute = [...model.attributes.keys()][0]
  }
  if (mode === 'flow' && state.graph.selectedFlow === null && model?.flows.length > 0) {
    state.graph.selectedFlow = model.flows[0].id
    state.graph.flowStep = 0
  }
  syncModeUi()
  rebuildGraph({ fit: true })
  renderInspector()
}

function syncModeUi() {
  const mode = state.graph.mode
  for (const button of document.querySelectorAll('#mode-switch button')) {
    button.classList.toggle('on', button.dataset.mode === mode)
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
  }
  const arch = mode === 'arch'
  $('status-filters').hidden = arch
  for (const id of ['toggle-layers', 'reset-layout', 'export-svg', 'export-layout']) {
    const button = $(id)
    if (button !== null) button.hidden = arch
  }
  $('layer-menu').hidden = true
  $('toggle-layers').setAttribute('aria-expanded', 'false')
  $('graph-search').placeholder = arch ? '搜索子系统…' : '搜索模块 / 按 Enter 定位…'
  const flowSelect = $('flow-select')
  const model = state.graph.model
  flowSelect.hidden = mode !== 'flow'
  clear(flowSelect)
  flowSelect.append(el('option', { value: '', text: '选择流程…' }))
  for (const flow of model?.flows || []) {
    flowSelect.append(el('option', { value: flow.id, text: `${flow.label}（${(flow.steps || []).length} 步）` }))
  }
  flowSelect.value = state.graph.selectedFlow ?? ''
}

function selectNode(id) {
  state.graph.selected = id
  renderGraph()
  renderInspector()
  const element = state.graph.nodeEls.get(id)
  element?.focus?.({ preventScroll: true })
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制')
  } catch {
    toast(text)
  }
}

// ---------------------------------------------------------------- interactions

function canvasPoint(event) {
  const rect = $('canvas').getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function worldPoint(event) {
  const point = canvasPoint(event)
  const view = state.graph.view
  return { x: (point.x - view.x) / view.k, y: (point.y - view.y) / view.k }
}

function wireCanvas() {
  const canvas = $('canvas')

  canvas.addEventListener('wheel', event => {
    event.preventDefault()
    zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY)
  }, { passive: false })

  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    if (state.graph.mode === 'arch' && event.target.closest?.('.arch-node')) return
    const node = event.target.closest?.('.node')
    canvas.setPointerCapture(event.pointerId)
    state.graph.moved = false
    if (node !== undefined && node !== null) {
      const id = node.dataset.id
      const point = worldPoint(event)
      const pos = state.graph.layout?.positions.get(id)
      if (!pos) return
      state.graph.dragging = { id, dx: point.x - pos.x, dy: point.y - pos.y, startX: event.clientX, startY: event.clientY }
      node.classList.add('dragging')
    } else {
      state.graph.panning = { x: event.clientX, y: event.clientY, viewX: state.graph.view.x, viewY: state.graph.view.y, startX: event.clientX, startY: event.clientY }
      canvas.classList.add('panning')
    }
    event.preventDefault()
  })

  canvas.addEventListener('pointermove', event => {
    const active = state.graph.dragging ?? state.graph.panning
    if (!state.graph.moved && active && Math.abs(event.clientX - active.startX) + Math.abs(event.clientY - active.startY) > 3) {
      state.graph.moved = true
    }
    if (state.graph.dragging !== null) {
      const point = worldPoint(event)
      const id = state.graph.dragging.id
      state.graph.manual[id] = {
        x: point.x - state.graph.dragging.dx,
        y: point.y - state.graph.dragging.dy,
      }
      const pos = state.graph.layout?.positions.get(id)
      if (pos) {
        pos.x = state.graph.manual[id].x
        pos.y = state.graph.manual[id].y
      }
      scheduleNodeFrame()
      return
    }
    if (state.graph.panning !== null) {
      const dx = event.clientX - state.graph.panning.x
      const dy = event.clientY - state.graph.panning.y
      state.graph.view = {
        ...state.graph.view,
        x: state.graph.panning.viewX + dx,
        y: state.graph.panning.viewY + dy,
      }
      applyView()
    }
  })

  const end = event => {
    if (state.graph.dragging !== null) {
      const id = state.graph.dragging.id
      state.graph.nodeEls.get(id)?.classList.remove('dragging')
      if (!state.graph.moved) selectNode(id)
      else {
        saveLayout()
        renderGraph()
        renderInspector()
      }
      state.graph.dragging = null
    }
    if (state.graph.panning !== null) {
      const wasClick = !state.graph.moved
      state.graph.panning = null
      canvas.classList.remove('panning')
      if (wasClick) {
        state.graph.selected = null
        renderGraph()
        renderInspector()
      } else {
        saveLayout()
      }
    }
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  }
  canvas.addEventListener('pointerup', end)
  canvas.addEventListener('pointercancel', end)

  canvas.addEventListener('click', event => {
    if (state.graph.mode !== 'arch') return
    const archNode = event.target.closest?.('.arch-node')
    if (archNode !== undefined && archNode !== null) {
      selectArch(archNode.dataset.arch)
    } else if (event.target.closest?.('.arch-root') === null || event.target.closest?.('.arch-root') === undefined) {
      state.graph.archSelected = null
      renderArch()
      renderInspector()
    }
  })

  canvas.addEventListener('dblclick', event => {
    if (state.graph.mode === 'arch') {
      const archNode = event.target.closest?.('.arch-node')
      if (archNode !== undefined && archNode !== null) openSubsystem(archNode.dataset.arch)
      else fitArch()
      return
    }
    const node = event.target.closest?.('.node')
    if (node === undefined || node === null) {
      fitView()
      return
    }
    activateNode(node.dataset.id)
  })

  canvas.addEventListener('keydown', event => {
    if (state.graph.mode === 'arch') {
      const archNode = event.target.closest?.('.arch-node')
      if (archNode === undefined || archNode === null) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        selectArch(archNode.dataset.arch)
      }
      return
    }
    const node = event.target.closest?.('.node')
    if (node === undefined || node === null) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      selectNode(node.dataset.id)
    }
  })

  window.addEventListener('resize', debounce(() => {
    if (state.view === 'structure') applyView()
  }, 120))
}

function scheduleNodeFrame() {
  cancelAnimationFrame(state.graph.frame)
  state.graph.frame = requestAnimationFrame(() => {
    for (const [id, element] of state.graph.nodeEls) {
      const pos = state.graph.layout?.positions.get(id)
      if (pos) element.setAttribute('transform', `translate(${pos.x} ${pos.y})`)
    }
    // Edges follow the moved node; rebuilding the edge layer is cheap for boards of this size.
    const model = state.graph.model
    const layout = state.graph.layout
    if (!model || !layout) return
    const paths = document.querySelectorAll('#canvas .edge, #canvas .step-edge-label')
    paths.forEach(path => path.remove())
    const edgeLayer = document.querySelector('#canvas .edges')
    if (!edgeLayer) return
    const visibleSet = new Set(visibleNodes().map(module => module.id))
    for (const edge of model.edges) {
      if (!visibleSet.has(edge.from) || !visibleSet.has(edge.to)) continue
      const from = layout.positions.get(edge.from)
      const to = layout.positions.get(edge.to)
      if (!from || !to) continue
      const d = edgePath(from, to)
      if (d === null) continue
      const selected = state.graph.selected
      const highlighted = selected !== null && (edge.from === selected || edge.to === selected)
      edgeLayer.append(svg('path', {
        class: `edge kind-${edge.kind}${highlighted ? ' highlight' : ''}`,
        d,
        'marker-end': `url(#${highlighted ? 'arrow-accent' : `arrow-${edge.kind}`})`,
      }))
    }
  })
}

// ------------------------------------------------------------------- views

function setView(view) {
  state.view = view
  for (const button of document.querySelectorAll('.tab')) {
    button.setAttribute('aria-selected', String(button.dataset.view === view))
  }
  for (const name of ['docs', 'structure', 'longterm', 'context', 'log']) {
    $(`view-${name}`).hidden = name !== view
  }
  if (view === 'structure') {
    syncModeUi()
    if (state.graph.mode === 'arch') {
      requestAnimationFrame(() => {
        if (state.graph.view.k === 1 && state.graph.view.x === 0 && state.graph.view.y === 0) fitArch()
        else applyView()
      })
    } else if (state.graph.layout) {
      requestAnimationFrame(() => {
        if (state.graph.view.k === 1 && state.graph.view.x === 0 && state.graph.view.y === 0) fitView()
        else applyView()
      })
    }
  }
  if (view === 'log') loadLog()
  if (view === 'longterm') renderLongterm()
  if (view === 'context') loadContext()
}

function renderAll() {
  renderHeader()
  renderDocList()
  renderDocPane()
  renderSourceBar()
  rebuildGraph()
  renderLongterm()
}

// -------------------------------------------------------------------- load

async function loadIndex({ silent = false } = {}) {
  if (!silent) {
    state.loading = true
    $('conn-text').textContent = '读取中'
  }
  try {
    const data = await api('index', { sessionId: state.sessionId, root: state.root })
    const rootChanged = data.root !== state.root
    state.index = data
    state.root = data.root
    state.error = null
    state.stale = false
    state.loading = false
    const fatalNode = $('fatal')
    if (fatalNode !== null) {
      fatalNode.hidden = true
      clear(fatalNode)
    }
    const needsLayout = state.layoutLoadedFor !== data.root
    if (needsLayout) {
      state.layoutLoadedFor = data.root
      loadLayout()
    } else {
      const server = data.layout?.positions
      state.graph.serverLayout = server !== null && typeof server === 'object' ? { ...server } : {}
    }
    if (rootChanged || needsLayout) {
      state.graph.selected = null
      state.docs.selected = null
      state.docs.content = null
      state.docs.lastPath = null
      state.docs.mtimeMs = 0
      state.docs.renderKey = null
      state.graph.selectedAttribute = null
      state.graph.selectedFlow = null
      state.graph.flowStep = 0
      state.log.loaded = false
      state.context.markdown = null
      state.context.error = null
      state.context.renderKey = null
    }
    const url = new URL(location.href)
    url.searchParams.set('root', state.root)
    history.replaceState(null, '', url)
    selectDefaultDoc()
    renderAll()
    if (state.view === 'log') loadLog()
    if (!state.docs.content && state.docs.selected) openDoc(state.docs.selected)
    const selectedMeta = data.docs.find(doc => doc.path === state.docs.selected)
    if (selectedMeta && state.docs.content !== null && selectedMeta.mtimeMs !== state.docs.mtimeMs) {
      openDoc(state.docs.selected, true)
    }
    if (state.view === 'structure') {
      requestAnimationFrame(() => {
        if (state.graph.view.k === 1 && state.graph.view.x === 0 && state.graph.view.y === 0) fitView()
      })
    }
  } catch (error) {
    state.loading = false
    state.error = error.message
    state.stale = true
    if (error.status === 403) {
      fatal('这个看板链接已失效。请回到 DSH，在「看板」里重新打开，或重新复制链接。')
      return
    }
    $('conn-text').textContent = '刷新失败'
    $('conn').classList.add('stale')
    if (state.index === null) fatal(error.message)
    else toast(`刷新失败：${error.message}`)
  }
}

async function switchProject(root) {
  if (root === state.root) return
  state.root = root
  state.graph.selected = null
  state.docs.selected = null
  state.docs.content = null
  state.log.loaded = false
  await loadIndex()
}

function wireUi() {
  for (const button of document.querySelectorAll('.tab')) {
    button.addEventListener('click', () => setView(button.dataset.view))
  }
  $('refresh').addEventListener('click', () => {
    loadIndex()
    if (state.docs.selected) openDoc(state.docs.selected, true)
    if (state.view === 'log') loadLog(true)
    if (state.view === 'context') loadContext(true)
    toast('已刷新')
  })
  $('doc-filter').addEventListener('input', event => {
    state.docFilter = event.target.value
    renderDocList()
  })
  $('project-select').addEventListener('change', event => switchProject(event.target.value))
  for (const button of document.querySelectorAll('#mode-switch button')) {
    button.addEventListener('click', () => setMode(button.dataset.mode))
  }
  $('flow-select').addEventListener('change', event => {
    state.graph.selectedFlow = event.target.value === '' ? null : event.target.value
    state.graph.flowStep = 0
    state.graph.selected = null
    renderGraph()
    renderInspector()
  })
  $('graph-search').addEventListener('input', event => {
    state.graph.search = event.target.value
    renderGraph()
  })
  $('graph-search').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    const query = state.graph.search.trim().toLowerCase()
    if (query === '') return
    if (state.graph.mode === 'arch') {
      const subsystem = state.graph.model?.subsystems.find(item =>
        `${item.label} ${item.summary}`.toLowerCase().includes(query))
      if (subsystem) selectArch(subsystem.id)
      return
    }
    const match = state.graph.model?.modules.find(module =>
      String(module.label || module.id).toLowerCase().includes(query) &&
      visibleNodes().some(visible => visible.id === module.id))
    if (match) {
      selectNode(match.id)
      centerNode(match.id, Math.max(state.graph.view.k, 1))
    }
  })
  $('zoom-in').addEventListener('click', () => zoomAt(1.2))
  $('zoom-out').addEventListener('click', () => zoomAt(1 / 1.2))
  $('fit').addEventListener('click', () => fitView())
  $('reset-layout').addEventListener('click', () => {
    state.graph.manual = {}
    localStorage.removeItem(`dsh-project-board:layout:v1:${state.root}`)
    rebuildGraph()
    fitView()
    toast(state.graph.serverLayout && Object.keys(state.graph.serverLayout).length > 0 ? '已恢复仓库布局' : '已恢复自动布局')
  })
  $('export-layout').addEventListener('click', exportLayout)
  $('export-svg').addEventListener('click', exportSvg)
  $('lt-prompt').addEventListener('click', copyGenerationPrompt)
  $('lt-export').addEventListener('click', exportReference)
  $('choose-workspace').addEventListener('click', openWorkspaceDialog)
  $('workspace-cancel').addEventListener('click', closeWorkspaceDialog)
  $('workspace-pick').addEventListener('click', pickWorkspaceFolder)
  $('workspace-apply').addEventListener('click', applyWorkspace)
  $('workspace-input').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); applyWorkspace() }
    if (event.key === 'Escape') closeWorkspaceDialog()
  })
  $('workspace-modal').addEventListener('click', event => {
    if (event.target === $('workspace-modal')) closeWorkspaceDialog()
  })
  $('pick-folder').addEventListener('click', pickFolder)
  $('reindex').addEventListener('click', reindexDocs)
  $('doc-source-input').addEventListener('change', event => {
    const value = event.target.value.trim()
    if (value === '') localStorage.removeItem(sourceStorageKey())
    else localStorage.setItem(sourceStorageKey(), value)
  })
  $('toggle-layers').addEventListener('click', () => {
    const menu = $('layer-menu')
    menu.hidden = !menu.hidden
    $('toggle-layers').setAttribute('aria-expanded', String(!menu.hidden))
    if (!menu.hidden) renderLayerMenu()
  })
  document.addEventListener('click', event => {
    const menu = $('layer-menu')
    if (menu.hidden) return
    if (menu.contains(event.target) || event.target.id === 'toggle-layers') return
    menu.hidden = true
    $('toggle-layers').setAttribute('aria-expanded', 'false')
  })
  document.addEventListener('keydown', event => {
    if (state.view !== 'structure') return
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (event.key === '0') fitView()
    if (event.key === '+' || event.key === '=') zoomAt(1.2)
    if (event.key === '-') zoomAt(1 / 1.2)
    if (state.graph.mode === 'flow' && event.key === ']') { event.preventDefault(); stepFlow(1) }
    if (state.graph.mode === 'flow' && event.key === '[') { event.preventDefault(); stepFlow(-1) }
    if (event.key === 'Escape') {
      if (state.graph.mode === 'arch') state.graph.archSelected = null
      else state.graph.selected = null
      renderGraph()
      renderInspector()
    }
  })
  wireCanvas()
  renderStatusFilters()
}

function renderStatusFilters() {
  const box = $('status-filters')
  clear(box)
  for (const [key, status] of Object.entries(STATUS)) {
    const hidden = state.graph.hiddenStatuses.has(key)
    box.append(el('button', {
      class: `chip${hidden ? ' off' : ' on'}`,
      style: `--chip-color:${status.color}`,
      title: hidden ? `显示${status.label}` : `隐藏${status.label}`,
      onclick: () => {
        if (hidden) state.graph.hiddenStatuses.delete(key)
        else state.graph.hiddenStatuses.add(key)
        renderStatusFilters()
        renderGraph()
        renderInspector()
      },
    }, el('i'), status.label))
  }
}

function renderLayerMenu() {
  const menu = $('layer-menu')
  clear(menu)
  const model = state.graph.model
  if (!model) return
  for (const layer of model.layers) {
    const hidden = state.graph.hiddenLayers.has(layer.id)
    menu.append(el('label', { class: 'row' },
      el('input', {
        type: 'checkbox',
        checked: !hidden,
        onchange: event => {
          if (event.target.checked) state.graph.hiddenLayers.delete(layer.id)
          else state.graph.hiddenLayers.add(layer.id)
          renderGraph()
          renderInspector()
        },
      }),
      el('span', { text: layer.label }),
      el('span', { text: String(model.modules.filter(module => module.layer === layer.id).length), style: 'margin-left:auto;color:var(--text-3);font-size:10px' }),
    ))
  }
}

// ------------------------------------------------------------------- boot

async function boot() {
  if (state.token === '') {
    fatal('缺少访问令牌。请回到 DSH，在右侧栏「看板」里点击「在浏览器打开」，或复制它给你的链接。')
    return
  }
  wireUi()
  setView('docs')
  await loadIndex()
  // Manual updates only: use the refresh button or the docs-folder reindex button.
}

boot()
