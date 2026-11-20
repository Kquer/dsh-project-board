/**
 * dsh-project-board — Host half.
 *
 * Serves a standalone, full-screen web board and the read-only data behind it:
 *
 *   GET /project-board/                     the board shell (public static files)
 *   GET /project-board/app.js / app.css     its assets
 *   GET /project-board/api/index            project scan, module map, log metadata
 *   GET /project-board/api/doc              one whitelisted Markdown file
 *   GET /project-board/api/asset            one image below the reference directory
 *   GET /project-board/api/projects         workspaces the page may switch between
 *
 * The browser-facing routes use a random per-process token carried in the page
 * URL. DSH itself uses two cookie-authenticated `/api` routes instead:
 *
 *   GET /api/project-board.index            compact launcher data
 *   GET /api/project-board.launch           the tokenized board URL
 *
 * The only writes are the curated long-term reference and the manual AI-context rebuild.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildContext, readContext } from './context.js'

/** Required Host services. */
export const inject = ['connection', 'webServer', 'sessions', 'workingDirectory']

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIR = path.join(PLUGIN_DIR, 'web')
const PREFIX = '/project-board'
const API_PREFIX = `${PREFIX}/api`
const MAX_FILE_BYTES = 1024 * 1024
const MAX_ASSET_BYTES = 8 * 1024 * 1024

const DEFAULTS = {
  root: '',
  referenceDir: 'docs/reference',
  mapPath: 'docs/board/project-map.json',
  devlogPath: 'docs/DEVLOG.md',
  projectPath: 'docs/PROJECT.md',
  layoutPath: 'docs/board/layout.json',
  roadmapPath: 'docs/board/roadmap.json',
  referencePath: 'docs/board/long-term-reference.json',
  contextDir: 'docs/board',
}

const MAP_STATUSES = new Set(['done', 'partial', 'todo', 'unknown', 'blocked'])
const ATTRIBUTE_KINDS = new Set(['config', 'state', 'derived'])
const ATTRIBUTE_STATUSES = new Set(['confirmed', 'pending', 'unknown'])
const FLOW_STATUSES = new Set(['draft', 'confirmed'])
const SUBSYSTEM_CONCERNS = new Set(['presentation', 'gameplay', 'services', 'data', 'core', 'tooling'])
const HORIZONS = new Set(['current', 'next', 'later'])
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.avif', 'image/avif'],
])
const STATIC_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.json', 'application/json; charset=utf-8'],
])

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function problem(message, status = 400) {
  return json({ ok: false, error: message }, status)
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function realDirectory(target) {
  try {
    if (typeof target !== 'string' || target === '') return undefined
    const resolved = path.resolve(target)
    if (!fs.statSync(resolved).isDirectory()) return undefined
    return fs.realpathSync(resolved)
  } catch {
    return undefined
  }
}

function toPosix(relative) {
  return relative.split(path.sep).join('/')
}

function relativeConfigPath(value, fallback) {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  const stripped = value.trim().replaceAll('\\', '/').replace(/^\/+/, '')
  if (stripped === '' || stripped.split('/').includes('..')) return fallback
  const normalized = path.posix.normalize(stripped).replace(/\/+$/, '')
  if (normalized === '' || normalized === '.' || normalized.startsWith('../')) return fallback
  return normalized
}

function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    root: typeof input.root === 'string' ? input.root.trim() : '',
    referenceDir: relativeConfigPath(input.referenceDir, DEFAULTS.referenceDir),
    mapPath: relativeConfigPath(input.mapPath, DEFAULTS.mapPath),
    devlogPath: relativeConfigPath(input.devlogPath, DEFAULTS.devlogPath),
    projectPath: relativeConfigPath(input.projectPath, DEFAULTS.projectPath),
    layoutPath: relativeConfigPath(input.layoutPath, DEFAULTS.layoutPath),
    roadmapPath: relativeConfigPath(input.roadmapPath, DEFAULTS.roadmapPath),
    referencePath: relativeConfigPath(input.referencePath, DEFAULTS.referencePath),
    contextDir: relativeConfigPath(input.contextDir, DEFAULTS.contextDir),
  }
}

function sessionRoot(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) return undefined
    try {
      const current = ctx.workingDirectory.get(session)
      const real = realDirectory(current)
      if (real !== undefined) return real
    } catch {
      // Fall back to the immutable header directory below.
    }
    const cwd = session.header?.cwd
    return realDirectory(cwd)
  } catch {
    return undefined
  }
}

function registeredWorkspaces(ctx) {
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return []
    const list = registry.list()
    if (!Array.isArray(list)) return []
    return list
      .filter(workspace => typeof workspace?.path === 'string')
      .map(workspace => ({
        id: typeof workspace.id === 'string' ? workspace.id : workspace.path,
        title: typeof workspace.title === 'string' ? workspace.title : path.basename(workspace.path),
        path: realDirectory(workspace.path) ?? workspace.path,
      }))
  } catch {
    return []
  }
}

function collectProjects(ctx, config, currentRoot) {
  const seen = new Map()
  const add = (entry) => {
    if (typeof entry.path !== 'string' || entry.path === '') return
    const key = realDirectory(entry.path) ?? entry.path
    if (!seen.has(key)) {
      seen.set(key, {
        id: entry.id ?? key,
        title: entry.title || path.basename(key) || key,
        path: key,
      })
    }
  }
  for (const workspace of registeredWorkspaces(ctx)) add(workspace)
  add({ id: 'configured', title: 'Configured root', path: config.root })
  add({ id: 'session', title: 'Current project', path: currentRoot })
  const projects = [...seen.values()]
  if (currentRoot !== undefined) {
    projects.sort((left, right) => (left.path === currentRoot ? -1 : right.path === currentRoot ? 1 : 0))
  }
  return projects
}

function projectNameFrom(root, map) {
  const fromMap = map?.project?.name
  if (typeof fromMap === 'string' && fromMap !== '') return fromMap
  return path.basename(root) || root
}

function resolveRoot(ctx, config, query) {
  const sessionId = typeof query.sessionId === 'string' ? query.sessionId : ''
  const requested = typeof query.root === 'string' ? query.root : ''
  const fromSession = sessionRoot(ctx, sessionId)
  const configured = realDirectory(config.root)
  const registered = registeredWorkspaces(ctx).map(workspace => workspace.path)
  const allowed = new Set([fromSession, configured, ...registered].filter(Boolean))

  if (requested !== '') {
    const requestedReal = realDirectory(requested)
    if (requestedReal === undefined) throw new Error(`项目目录不存在：${requested}`)
    if (allowed.size > 0 && !allowed.has(requestedReal)) {
      throw new Error('该目录不是 DSH 已登记的 Workspace，无法打开')
    }
    return { root: requestedReal, sessionId, projects: collectProjects(ctx, config, requestedReal) }
  }

  const root = fromSession ?? configured ?? registered[0]
  if (root === undefined) {
    throw new Error('无法确定项目目录：请从 DSH 的「看板」按钮打开，或在插件配置里设置 root')
  }
  return { root, sessionId, projects: collectProjects(ctx, config, root) }
}

function fileMeta(root, relative) {
  const absolute = path.join(root, relative)
  try {
    const stat = fs.statSync(absolute)
    if (!stat.isFile()) return undefined
    return { path: toPosix(relative), mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return undefined
  }
}

function firstHeading(text) {
  for (const line of text.split('\n')) {
    const match = /^#\s+(.+?)\s*$/.exec(line)
    if (match !== null) return match[1].replace(/[`*_]/g, '').trim()
  }
  return undefined
}

function collectMarkdown(root, relativeDir, group, out) {
  const absoluteDir = path.join(root, relativeDir)
  let entries
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const relative = path.join(relativeDir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'assets') continue
      collectMarkdown(root, relative, group === '' ? entry.name : `${group}/${entry.name}`, out)
      continue
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    const absolute = path.join(root, relative)
    let stat
    let title
    try {
      stat = fs.statSync(absolute)
      if (stat.size > MAX_FILE_BYTES) continue
      title = firstHeading(fs.readFileSync(absolute, 'utf8'))
    } catch {
      continue
    }
    out.push({
      path: toPosix(relative),
      title: title ?? entry.name.replace(/\.md$/i, ''),
      group,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    })
  }
}

function validateMap(data) {
  if (data === null || typeof data !== 'object') throw new Error('根节点必须是对象')
  if (!Array.isArray(data.layers) || data.layers.length === 0) throw new Error('缺少 layers 数组')
  if (!Array.isArray(data.modules)) throw new Error('缺少 modules 数组')
  if (!Array.isArray(data.edges)) throw new Error('缺少 edges 数组')
  const layerIds = new Set()
  for (const layer of data.layers) {
    if (typeof layer?.id !== 'string' || layer.id === '') throw new Error('layers[].id 必须是非空字符串')
    if (layerIds.has(layer.id)) throw new Error(`layers 里重复的 id：${layer.id}`)
    if (layer.label !== undefined && typeof layer.label !== 'string') throw new Error(`层 ${layer.id} 的 label 必须是字符串`)
    if (layer.order !== undefined && typeof layer.order !== 'number') throw new Error(`层 ${layer.id} 的 order 必须是数字`)
    layerIds.add(layer.id)
  }
  const moduleIds = new Set()
  for (const module of data.modules) {
    if (typeof module?.id !== 'string' || module.id === '') throw new Error('modules[].id 必须是非空字符串')
    if (moduleIds.has(module.id)) throw new Error(`modules 里重复的 id：${module.id}`)
    if (typeof module.label !== 'string' || module.label === '') throw new Error(`模块 ${module.id} 缺少 label`)
    if (!layerIds.has(module.layer)) throw new Error(`模块 ${module.id} 的 layer 不存在：${module.layer}`)
    if (!MAP_STATUSES.has(module.status)) throw new Error(`模块 ${module.id} 的 status 非法：${module.status}`)
    if (module.summary !== undefined && typeof module.summary !== 'string') throw new Error(`模块 ${module.id} 的 summary 必须是字符串`)
    if (module.path !== undefined && typeof module.path !== 'string') throw new Error(`模块 ${module.id} 的 path 必须是字符串`)
    if (module.entry !== undefined && typeof module.entry !== 'string') throw new Error(`模块 ${module.id} 的 entry 必须是字符串`)
    if (module.focus !== undefined && typeof module.focus !== 'boolean') throw new Error(`模块 ${module.id} 的 focus 必须是布尔值`)
    moduleIds.add(module.id)
  }
  // Parent references and cycles are part of the v2 hierarchy.
  for (const module of data.modules) {
    if (module.parent === undefined || module.parent === null) continue
    if (typeof module.parent !== 'string' || !moduleIds.has(module.parent)) {
      throw new Error(`模块 ${module.id} 的 parent 不存在：${module.parent}`)
    }
    if (module.parent === module.id) throw new Error(`模块 ${module.id} 不能以自己为 parent`)
  }
  const byId = new Map(data.modules.map(module => [module.id, module]))
  for (const module of data.modules) {
    const seen = new Set([module.id])
    let cursor = module.parent
    while (typeof cursor === 'string') {
      if (seen.has(cursor)) throw new Error(`模块 ${module.id} 的 parent 链出现循环`)
      seen.add(cursor)
      cursor = byId.get(cursor)?.parent
    }
  }

  // v2 key attributes: where they live, who writes and reads them.
  const attributeIds = new Set()
  if (data.attributes !== undefined) {
    if (!Array.isArray(data.attributes)) throw new Error('attributes 必须是数组')
    for (const attribute of data.attributes) {
      if (typeof attribute?.id !== 'string' || attribute.id === '') throw new Error('attributes[].id 必须是非空字符串')
      if (attributeIds.has(attribute.id)) throw new Error(`属性 id 重复：${attribute.id}`)
      if (typeof attribute.label !== 'string' || attribute.label === '') throw new Error(`属性 ${attribute.id} 缺少 label`)
      if (!ATTRIBUTE_KINDS.has(attribute.kind)) throw new Error(`属性 ${attribute.id} 的 kind 非法：${attribute.kind}`)
      if (typeof attribute.source !== 'string' || attribute.source === '') throw new Error(`属性 ${attribute.id} 缺少 source`)
      if (attribute.sourceModule !== undefined && !moduleIds.has(attribute.sourceModule)) {
        throw new Error(`属性 ${attribute.id} 的 sourceModule 不存在：${attribute.sourceModule}`)
      }
      if (attribute.default !== undefined && attribute.default !== null
        && !['string', 'number', 'boolean'].includes(typeof attribute.default)) {
        throw new Error(`属性 ${attribute.id} 的 default 必须是标量或 null`)
      }
      for (const field of ['writtenBy', 'readBy']) {
        if (attribute[field] === undefined) continue
        if (!Array.isArray(attribute[field])) throw new Error(`属性 ${attribute.id} 的 ${field} 必须是数组`)
        for (const moduleId of attribute[field]) {
          if (!moduleIds.has(moduleId)) throw new Error(`属性 ${attribute.id} 的 ${field} 引用了不存在的模块：${moduleId}`)
        }
      }
      if (attribute.affects !== undefined) {
        if (!Array.isArray(attribute.affects) || attribute.affects.some(item => typeof item !== 'string')) {
          throw new Error(`属性 ${attribute.id} 的 affects 必须是字符串数组`)
        }
      }
      if (attribute.tunable !== undefined && typeof attribute.tunable !== 'boolean') {
        throw new Error(`属性 ${attribute.id} 的 tunable 必须是布尔值`)
      }
      if (attribute.status !== undefined && !ATTRIBUTE_STATUSES.has(attribute.status)) {
        throw new Error(`属性 ${attribute.id} 的 status 非法：${attribute.status}`)
      }
      attributeIds.add(attribute.id)
    }
  }

  // v2 conceptual subsystems: top-down capability decomposition over the modules.
  if (data.subsystems !== undefined) {
    if (!Array.isArray(data.subsystems)) throw new Error('subsystems 必须是数组')
    const subsystemIds = new Set()
    for (const subsystem of data.subsystems) {
      if (typeof subsystem?.id !== 'string' || subsystem.id === '') throw new Error('subsystems[].id 必须是非空字符串')
      if (subsystemIds.has(subsystem.id)) throw new Error(`子系统 id 重复：${subsystem.id}`)
      if (typeof subsystem.label !== 'string' || subsystem.label === '') throw new Error(`子系统 ${subsystem.id} 缺少 label`)
      if (subsystem.concern !== undefined && !SUBSYSTEM_CONCERNS.has(subsystem.concern)) {
        throw new Error(`子系统 ${subsystem.id} 的 concern 非法：${subsystem.concern}`)
      }
      if (subsystem.horizon !== undefined && !HORIZONS.has(subsystem.horizon)) {
        throw new Error(`子系统 ${subsystem.id} 的 horizon 非法：${subsystem.horizon}`)
      }
      if (subsystem.order !== undefined && typeof subsystem.order !== 'number') throw new Error(`子系统 ${subsystem.id} 的 order 必须是数字`)
      if (subsystem.summary !== undefined && typeof subsystem.summary !== 'string') throw new Error(`子系统 ${subsystem.id} 的 summary 必须是字符串`)
      if (!Array.isArray(subsystem.modules) || subsystem.modules.length === 0) throw new Error(`子系统 ${subsystem.id} 缺少 modules`)
      const seen = new Set()
      for (const moduleId of subsystem.modules) {
        if (typeof moduleId !== 'string' || !moduleIds.has(moduleId)) {
          throw new Error(`子系统 ${subsystem.id} 引用了不存在的模块：${String(moduleId)}`)
        }
        if (seen.has(moduleId)) throw new Error(`子系统 ${subsystem.id} 里重复的模块：${moduleId}`)
        seen.add(moduleId)
      }
      subsystemIds.add(subsystem.id)
    }
  }

  // v2 execution flows: named step sequences that reference modules and attributes.
  if (data.flows !== undefined) {
    if (!Array.isArray(data.flows)) throw new Error('flows 必须是数组')
    const flowIds = new Set()
    for (const flow of data.flows) {
      if (typeof flow?.id !== 'string' || flow.id === '') throw new Error('flows[].id 必须是非空字符串')
      if (flowIds.has(flow.id)) throw new Error(`流程 id 重复：${flow.id}`)
      if (typeof flow.label !== 'string' || flow.label === '') throw new Error(`流程 ${flow.id} 缺少 label`)
      if (flow.status !== undefined && !FLOW_STATUSES.has(flow.status)) {
        throw new Error(`流程 ${flow.id} 的 status 非法：${flow.status}`)
      }
      if (!Array.isArray(flow.steps) || flow.steps.length === 0) throw new Error(`流程 ${flow.id} 缺少 steps`)
      for (const step of flow.steps) {
        if (typeof step?.module !== 'string' || !moduleIds.has(step.module)) {
          throw new Error(`流程 ${flow.id} 的步骤引用了不存在的模块：${step?.module}`)
        }
        if (typeof step.action !== 'string' || step.action === '') throw new Error(`流程 ${flow.id} 的步骤缺少 action`)
        for (const field of ['reads', 'writes']) {
          if (step[field] === undefined) continue
          if (!Array.isArray(step[field])) throw new Error(`流程 ${flow.id} 的 ${field} 必须是数组`)
          for (const attributeId of step[field]) {
            if (!attributeIds.has(attributeId)) {
              throw new Error(`流程 ${flow.id} 的 ${field} 引用了不存在的属性：${attributeId}`)
            }
          }
        }
      }
      flowIds.add(flow.id)
    }
  }
  for (const edge of data.edges) {
    if (!moduleIds.has(edge?.from) || !moduleIds.has(edge?.to)) {
      throw new Error(`依赖边引用了不存在的模块：${edge?.from} → ${edge?.to}`)
    }
  }
  if (data.focus !== undefined) {
    if (!Array.isArray(data.focus)) throw new Error('focus 必须是数组')
    for (const item of data.focus) {
      const moduleId = typeof item === 'string' ? item : item?.module
      if (typeof moduleId !== 'string' || !moduleIds.has(moduleId)) {
        throw new Error(`focus 引用了不存在的模块：${String(moduleId)}`)
      }
    }
  }
}

function readMap(root, mapPath) {
  try {
    const raw = fs.readFileSync(path.join(root, mapPath), 'utf8')
    if (raw.length > MAX_FILE_BYTES) throw new Error('地图文件超过 1 MB')
    const data = JSON.parse(raw)
    validateMap(data)
    return { map: data, error: undefined }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { map: undefined, error: `无法读取 ${mapPath}：${reason}` }
  }
}

function readLayout(root, layoutPath) {
  try {
    const raw = fs.readFileSync(path.join(root, layoutPath), 'utf8')
    if (raw.length > MAX_FILE_BYTES) throw new Error('布局文件超过 1 MB')
    const data = JSON.parse(raw)
    if (data === null || typeof data !== 'object' || typeof data.positions !== 'object' || data.positions === null) {
      throw new Error('缺少 positions 对象')
    }
    return { layout: { positions: data.positions }, error: undefined }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return { layout: null, error: undefined }
    const reason = error instanceof Error ? error.message : String(error)
    return { layout: null, error: `无法读取 ${layoutPath}：${reason}` }
  }
}

function validateRoadmap(data) {
  if (data === null || typeof data !== 'object') throw new Error('根节点必须是对象')
  if (!Array.isArray(data.horizons) || data.horizons.length === 0) throw new Error('缺少 horizons 数组')
  const horizonIds = new Set()
  for (const horizon of data.horizons) {
    if (typeof horizon?.id !== 'string' || horizon.id === '') throw new Error('horizons[].id 必须是非空字符串')
    if (horizonIds.has(horizon.id)) throw new Error('horizons 里重复的 id：' + horizon.id)
    if (typeof horizon.label !== 'string' || horizon.label === '') throw new Error('horizon ' + horizon.id + ' 缺少 label')
    if (horizon.order !== undefined && typeof horizon.order !== 'number') throw new Error('horizon ' + horizon.id + ' 的 order 必须是数字')
    horizonIds.add(horizon.id)
  }
  if (!Array.isArray(data.directions)) throw new Error('缺少 directions 数组')
  const ids = new Set()
  for (const direction of data.directions) {
    if (typeof direction?.id !== 'string' || direction.id === '') throw new Error('directions[].id 必须是非空字符串')
    if (ids.has(direction.id)) throw new Error('directions 里重复的 id：' + direction.id)
    if (typeof direction.label !== 'string' || direction.label === '') throw new Error('方向 ' + direction.id + ' 缺少 label')
    if (!horizonIds.has(direction.horizon)) throw new Error('方向 ' + direction.id + ' 的 horizon 不存在：' + direction.horizon)
    for (const field of ['summary', 'rationale']) {
      if (direction[field] !== undefined && typeof direction[field] !== 'string') throw new Error('方向 ' + direction.id + ' 的 ' + field + ' 必须是字符串')
    }
    if (direction.relatedModules !== undefined) {
      if (!Array.isArray(direction.relatedModules) || direction.relatedModules.some(id => typeof id !== 'string')) {
        throw new Error('方向 ' + direction.id + ' 的 relatedModules 必须是字符串数组')
      }
    }
    if (direction.sourceDocs !== undefined) {
      if (!Array.isArray(direction.sourceDocs) || direction.sourceDocs.some(doc => typeof doc !== 'string')) {
        throw new Error('方向 ' + direction.id + ' 的 sourceDocs 必须是字符串数组')
      }
    }
    ids.add(direction.id)
  }
}

function readRoadmap(root, roadmapPath) {
  try {
    const raw = fs.readFileSync(path.join(root, roadmapPath), 'utf8')
    if (raw.length > MAX_FILE_BYTES) throw new Error('路线图文件超过 1 MB')
    const data = JSON.parse(raw)
    validateRoadmap(data)
    return { roadmap: data, error: undefined }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return { roadmap: null, error: undefined }
    const reason = error instanceof Error ? error.message : String(error)
    return { roadmap: null, error: '无法读取 ' + roadmapPath + '：' + reason }
  }
}

function readReference(root, referencePath) {
  try {
    const raw = fs.readFileSync(path.join(root, referencePath), 'utf8')
    if (raw.length > MAX_FILE_BYTES) throw new Error('长期参考文件超过 1 MB')
    const data = JSON.parse(raw)
    if (data === null || typeof data !== 'object' || !Array.isArray(data.items)) throw new Error('缺少 items 数组')
    const items = data.items.filter(id => typeof id === 'string')
    return { reference: { items }, error: undefined }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return { reference: { items: [] }, error: undefined }
    const reason = error instanceof Error ? error.message : String(error)
    return { reference: { items: [] }, error: '无法读取 ' + referencePath + '：' + reason }
  }
}

function writeReference(root, referencePath, items) {
  const absolute = path.join(root, referencePath)
  const directory = path.dirname(absolute)
  fs.mkdirSync(directory, { recursive: true })
  const payload = JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), items }, null, 2) + '\n'
  const temporary = absolute + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(temporary, payload, 'utf8')
  fs.renameSync(temporary, absolute)
}

function buildIndex(ctx, config, query) {
  const { root, sessionId, projects } = resolveRoot(ctx, config, query)
  if (!isDirectory(root)) throw new Error(`项目目录不可用：${root}`)

  const docs = []
  collectMarkdown(root, config.referenceDir, '', docs)
  docs.sort((left, right) => {
    const leftIndex = left.path.endsWith('/INDEX.md') || left.path === `${config.referenceDir}/INDEX.md`
    const rightIndex = right.path.endsWith('/INDEX.md') || right.path === `${config.referenceDir}/INDEX.md`
    if (leftIndex !== rightIndex) return leftIndex ? -1 : 1
    if (left.group !== right.group) return left.group.localeCompare(right.group, 'zh')
    return left.title.localeCompare(right.title, 'zh')
  })

  const mapRead = readMap(root, config.mapPath)
  const layoutRead = readLayout(root, config.layoutPath)
  const roadmapRead = readRoadmap(root, config.roadmapPath)
  const referenceRead = readReference(root, config.referencePath)
  const contextRead = readContext(root, config.contextDir)
  const map = mapRead.map
  return {
    ok: true,
    root,
    sessionId,
    projects,
    projectName: projectNameFrom(root, map),
    phase: typeof map?.project?.phase === 'string' ? map.project.phase : '',
    paths: {
      referenceDir: config.referenceDir,
      mapPath: config.mapPath,
      devlogPath: config.devlogPath,
      projectPath: config.projectPath,
      layoutPath: config.layoutPath,
      roadmapPath: config.roadmapPath,
      referencePath: config.referencePath,
      contextDir: config.contextDir,
    },
    docs,
    devlog: fileMeta(root, config.devlogPath),
    projectFile: fileMeta(root, config.projectPath),
    mapPath: config.mapPath,
    map: map ?? null,
    mapError: mapRead.error ?? null,
    layout: layoutRead.layout,
    layoutError: layoutRead.error ?? null,
    roadmap: roadmapRead.roadmap,
    roadmapError: roadmapRead.error ?? null,
    longTermReference: referenceRead.reference,
    context: contextRead.summary,
    referenceError: referenceRead.error ?? null,
    generatedAt: new Date().toISOString(),
  }
}

function resolveInside(root, relative) {
  if (typeof relative !== 'string' || relative === '') return undefined
  const normalized = relative.replaceAll('\\', '/')
  if (normalized.startsWith('/') || normalized.split('/').includes('..') || normalized.includes('\0')) return undefined
  try {
    const realRoot = fs.realpathSync(root)
    const absolute = path.resolve(root, normalized)
    if (!fs.existsSync(absolute)) return undefined
    const realFile = fs.realpathSync(absolute)
    if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) return undefined
    const stat = fs.statSync(realFile)
    return stat.isFile() ? { absolute: realFile, stat } : undefined
  } catch {
    return undefined
  }
}

function docAllowed(relative, config) {
  const normalized = relative.replaceAll('\\', '/')
  if (!normalized.toLowerCase().endsWith('.md')) return false
  return normalized === config.devlogPath
    || normalized === config.projectPath
    || normalized.startsWith(`${config.referenceDir}/`)
}

function buildDoc(root, config, relative) {
  if (typeof relative !== 'string' || !docAllowed(relative, config)) {
    return problem('不允许读取该文件', 403)
  }
  const found = resolveInside(root, relative)
  if (found === undefined || found.stat.size > MAX_FILE_BYTES) return problem('文件不存在或超过 1 MB', 404)
  return json({
    ok: true,
    path: toPosix(relative),
    mtimeMs: found.stat.mtimeMs,
    size: found.stat.size,
    content: fs.readFileSync(found.absolute, 'utf8'),
  })
}

function buildAsset(root, config, relative) {
  const normalized = typeof relative === 'string' ? relative.replaceAll('\\', '/') : ''
  if (!normalized.startsWith(`${config.referenceDir}/`)) return problem('不允许读取该资源', 403)
  const extension = path.extname(normalized).toLowerCase()
  const type = IMAGE_TYPES.get(extension)
  if (type === undefined) return problem('不支持的图片格式', 403)
  const found = resolveInside(root, normalized)
  if (found === undefined || found.stat.size > MAX_ASSET_BYTES) return problem('图片不存在或超过 8 MB', 404)
  return new Response(fs.readFileSync(found.absolute), {
    headers: { 'content-type': type, 'cache-control': 'no-store' },
  })
}

function serveStatic(pathname) {
  const relative = pathname.slice(PREFIX.length).replace(/^\/+/, '')
  const file = relative === '' ? 'index.html' : relative
  if (!/^[A-Za-z0-9._-]+$/.test(file)) return problem('not found', 404)
  const absolute = path.join(WEB_DIR, file)
  try {
    const stat = fs.statSync(absolute)
    if (!stat.isFile()) return problem('not found', 404)
    const type = STATIC_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream'
    return new Response(fs.readFileSync(absolute), {
      headers: { 'content-type': type, 'cache-control': 'no-store' },
    })
  } catch {
    return problem('not found', 404)
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('请求体超过 64 KB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function tokenMatches(expected, supplied) {
  if (typeof supplied !== 'string') return false
  const left = Buffer.from(expected)
  const right = Buffer.from(supplied)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {Record<string, unknown>} [rawConfig] - bundle config.
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const accessToken = crypto.randomBytes(24).toString('base64url')

  const launchUrl = (root, sessionId) => {
    let origin
    try {
      origin = ctx.webServer.getOrigin()
    } catch {
      origin = `http://127.0.0.1:${ctx.webServer.port}`
    }
    const query = new URLSearchParams({ token: accessToken })
    if (sessionId) query.set('sessionId', sessionId)
    if (root) query.set('root', root)
    return `${origin}${PREFIX}/?${query.toString()}`
  }

  // --- DSH launcher routes (browser cookie authentication) -----------------
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/project-board.index',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => {
      try {
        const url = new URL(request.url)
        const payload = buildIndex(ctx, config, url.searchParams)
        return json(payload)
      } catch (error) {
        return problem(error instanceof Error ? error.message : String(error))
      }
    },
  }))

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/project-board.launch',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => {
      try {
        const url = new URL(request.url)
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const { root } = resolveRoot(ctx, config, url.searchParams)
        return json({ ok: true, root, url: launchUrl(root, sessionId) })
      } catch (error) {
        return problem(error instanceof Error ? error.message : String(error))
      }
    },
  }))

  // --- Manual document-context rebuild --------------------------------------
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/pick-folder`,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      if (!tokenMatches(accessToken, url.searchParams.get('token') ?? '')) {
        sendJson(res, 403, { ok: false, error: '链接已失效，请从 DSH 重新打开项目看板' }); return
      }
      try {
        const picker = ctx.get?.('directoryPicker') ?? ctx.directoryPicker
        const capability = picker?.capability?.()
        if (capability?.kind === 'native') {
          const selected = await capability.pick(new AbortController().signal)
          sendJson(res, 200, { ok: true, path: selected ?? null })
          return
        }
        if (capability?.kind === 'browse') {
          sendJson(res, 409, { ok: false, code: 'browse-only', error: '当前 DSH 没有原生文件夹选择器；请直接输入绝对路径。' })
          return
        }
        sendJson(res, 501, { ok: false, error: 'DSH 没有可用的文件夹选择器；请直接输入绝对路径。' })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/reindex`,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      if (!tokenMatches(accessToken, url.searchParams.get('token') ?? '')) {
        sendJson(res, 403, { ok: false, error: '链接已失效，请从 DSH 重新打开项目看板' }); return
      }
      try {
        const { root } = resolveRoot(ctx, config, url.searchParams)
        const body = await readBody(req, 64 * 1024)
        const parsed = JSON.parse(body)
        if (typeof parsed.sourceDir !== 'string' || parsed.sourceDir.trim() === '') {
          throw new Error('缺少 sourceDir')
        }
        const sourceDir = path.isAbsolute(parsed.sourceDir) ? parsed.sourceDir : path.resolve(root, parsed.sourceDir)
        const summary = buildContext(root, sourceDir, config.contextDir)
        sendJson(res, 200, { ok: true, ...summary })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/context-asset`,
    handler: (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      if (!tokenMatches(accessToken, url.searchParams.get('token') ?? '')) {
        sendJson(res, 403, { ok: false, error: '链接已失效，请从 DSH 重新打开项目看板' }); return
      }
      try {
        const { root } = resolveRoot(ctx, config, url.searchParams)
        const relative = url.searchParams.get('path') ?? ''
        if (!relative.startsWith(`${config.contextDir}/generated/`)) { sendJson(res, 403, { ok: false, error: '不允许读取该上下文资源' }); return }
        const found = resolveInside(root, relative)
        if (found === undefined || found.stat.size > MAX_ASSET_BYTES) { sendJson(res, 404, { ok: false, error: '资源不存在或过大' }); return }
        const type = IMAGE_TYPES.get(path.extname(relative).toLowerCase()) ?? 'application/octet-stream'
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': found.stat.size })
        res.end(fs.readFileSync(found.absolute))
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/context`,
    handler: (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
      if (!tokenMatches(accessToken, url.searchParams.get('token') ?? '')) {
        sendJson(res, 403, { ok: false, error: '链接已失效，请从 DSH 重新打开项目看板' }); return
      }
      try {
        const { root } = resolveRoot(ctx, config, url.searchParams)
        const context = readContext(root, config.contextDir)
        if (context.summary === null) { sendJson(res, 404, { ok: false, error: '还没有生成 AI 上下文' }); return }
        sendJson(res, 200, { ok: true, summary: context.summary, markdown: context.markdown })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  // --- One narrow write: the user's curated long-term reference -------------
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/reference`,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost')
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!tokenMatches(accessToken, url.searchParams.get('token') ?? '')) {
        sendJson(res, 403, { ok: false, error: '链接已失效，请从 DSH 重新打开项目看板' })
        return
      }
      try {
        const { root } = resolveRoot(ctx, config, url.searchParams)
        const roadmapRead = readRoadmap(root, config.roadmapPath)
        if (roadmapRead.roadmap === null) throw new Error(roadmapRead.error ?? '没有 roadmap.json，无法写入长期参考')
        const allowed = new Set(roadmapRead.roadmap.directions.map(direction => direction.id))
        const body = await readBody(req, 64 * 1024)
        const parsed = JSON.parse(body)
        if (!Array.isArray(parsed.items)) throw new Error('items 必须是数组')
        const items = [...new Set(parsed.items)]
        if (items.some(id => typeof id !== 'string' || !allowed.has(id))) throw new Error('items 里有未知的长期方向 id')
        writeReference(root, config.referencePath, items)
        sendJson(res, 200, { ok: true, items })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }))

  // --- Public board: static shell + tokenized read-only JSON ----------------
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    resource: async request => {
      const url = new URL(request.url)
      try {
        if (url.pathname === PREFIX) {
          return new Response(null, { status: 302, headers: { location: `${PREFIX}/${url.search}` } })
        }
        if (url.pathname === `${PREFIX}/`) {
          return serveStatic('/')
        }
        if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
          return serveStatic(url.pathname)
        }
        if (!tokenMatches(accessToken, url.searchParams.get('token') ?? '')) {
          return problem('链接已失效，请从 DSH 重新打开项目看板', 403)
        }
        const endpoint = url.pathname.slice(API_PREFIX.length + 1)
        if (endpoint === 'index') return json(buildIndex(ctx, config, url.searchParams))
        if (endpoint === 'projects') {
          const { root, projects } = resolveRoot(ctx, config, url.searchParams)
          return json({ ok: true, root, projects })
        }
        if (endpoint === 'doc') {
          const { root } = resolveRoot(ctx, config, url.searchParams)
          return buildDoc(root, config, url.searchParams.get('path') ?? '')
        }
        if (endpoint === 'asset') {
          const { root } = resolveRoot(ctx, config, url.searchParams)
          return buildAsset(root, config, url.searchParams.get('path') ?? '')
        }
        return problem('not found', 404)
      } catch (error) {
        return problem(error instanceof Error ? error.message : String(error), 400)
      }
    },
  }))
}
