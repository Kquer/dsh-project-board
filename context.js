/**
 * Parse a project documentation folder into one AI-readable context file.
 *
 * The board cannot hand raw .docx/.pos files to a model, so this module
 * normalizes them into:
 *   docs/board/AI-CONTEXT.md   one Markdown document
 *   docs/board/ai-context.json machine-readable copy
 *
 * It is intentionally dependency-free: DOCX is an OOXML zip, POS is JSON,
 * Markdown/text are plain files. Images are copied beside the context file
 * and referenced; PDFs and legacy .doc files are reported as warnings.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

const MAX_FILES = 500
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_CHARS = 4_000_000
const TEXT_EXT = new Set(['.md', '.markdown', '.txt'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif'])
const SKIP_DIRS = new Set(['.git', '.svn', 'node_modules', '__pycache__', '.DS_Store'])
const CONTEXT_JSON = 'ai-context.json'
const CONTEXT_MD = 'AI-CONTEXT.md'

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex')
}

function unescapeXml(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
}

function stripXmlTags(value) {
  return unescapeXml(value.replace(/<[^>]+>/g, ''))
}

/** Read the zip central directory without external dependencies. */
function zipEntries(buffer) {
  let eocd = -1
  const min = Math.max(0, buffer.length - 65557)
  for (let index = buffer.length - 22; index >= min; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('DOCX 不是有效的 zip')
  const count = buffer.readUInt16LE(eocd + 10)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  const entries = new Map()
  let cursor = cdOffset
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0 ? compressed : zlib.inflateRawSync(compressed)
    entries.set(name.replaceAll('\\', '/'), data)
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function docxRelations(entries) {
  const rels = entries.get('word/_rels/document.xml.rels')
  if (rels === undefined) return []
  const text = rels.toString('utf8')
  const found = []
  for (const match of text.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0]
    const id = /\bId="([^"]+)"/.exec(tag)?.[1]
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1]
    if (id && target && /image/i.test(tag)) found.push({ id, target })
  }
  return found
}

function docxToMarkdown(buffer, filename, assetsDir, imagePrefix, warnings) {
  const entries = zipEntries(buffer)
  const document = entries.get('word/document.xml')
  if (document === undefined) throw new Error('DOCX 缺少 word/document.xml')
  const xml = document.toString('utf8')
  const paragraphs = []
  const paragraphRegex = /<w:p\b[\s\S]*?<\/w:p>/g
  const paragraphMatches = xml.match(paragraphRegex) ?? []
  for (const paragraph of paragraphMatches) {
    const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(paragraph)?.[1] ?? ''
    let text = ''
    const tokenRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g
    for (const token of paragraph.matchAll(tokenRegex)) {
      if (token[1] !== undefined) text += unescapeXml(token[1])
      else if (token[0].startsWith('<w:tab')) text += '\t'
      else text += '\n'
    }
    text = text.replace(/[ \t]+\n/g, '\n').trim()
    if (text === '') continue
    const heading = /^Heading(\d)$/i.exec(style) ?? /^标题(\d)$/.exec(style)
    const level = heading ? Math.min(6, Math.max(1, Number(heading[1]))) : (/^Title$/i.test(style) ? 1 : 0)
    paragraphs.push(level > 0 ? `${'#'.repeat(level)} ${text}` : text)
  }
  if (paragraphs.length === 0) {
    paragraphs.push(stripXmlTags(xml).replace(/\n{3,}/g, '\n\n').trim())
  }
  const images = []
  const rels = docxRelations(entries)
  for (const rel of rels) {
    const target = rel.target.replaceAll('\\', '/').replace(/^\.\//, '')
    const media = entries.get(`word/${target}`) ?? entries.get(target)
    if (media === undefined) { warnings.push(`${filename}: 图片 ${rel.target} 未找到`); continue }
    const extension = path.extname(target).toLowerCase()
    if (!IMAGE_EXT.has(extension)) continue
    if (media.length > MAX_FILE_BYTES) { warnings.push(`${filename}: 图片 ${target} 超过 8 MB，跳过`); continue }
    const assetName = `${sha1(media).slice(0, 12)}-${path.basename(target)}`
    fs.mkdirSync(assetsDir, { recursive: true })
    fs.writeFileSync(path.join(assetsDir, assetName), media)
    images.push({ path: `${imagePrefix}/${assetName}`, source: target })
    paragraphs.push(`![${path.basename(target)}](${imagePrefix}/${assetName})`)
  }
  const firstHeading = paragraphs.find(item => item.startsWith('#'))
  const title = firstHeading ? firstHeading.replace(/^#+\s*/, '') : path.basename(filename, path.extname(filename))
  return { title, markdown: paragraphs.join('\n\n') + '\n', images }
}

/** Extract the visible graph from a ProcessOn/WPS .pos JSON. */
function posToGraph(buffer, filename) {
  let data
  try { data = JSON.parse(buffer.toString('utf8')) } catch (error) {
    throw new Error(`.pos JSON 解析失败：${error.message}`)
  }
  const diagram = data?.diagram ?? {}
  const container = diagram.elements ?? {}
  const elements = container.elements
  if (elements === null || typeof elements !== 'object') {
    // Mind-map .pos: diagram.elements is the root topic.
    const root = container
    const nodes = []
    const walk = (node, parent = null) => {
      if (!node || typeof node !== 'object') return
      const id = String(node.id ?? `topic-${nodes.length + 1}`)
      nodes.push({ id, label: String(node.title ?? node.text ?? '').trim(), parent, children: [] })
      for (const child of node.children ?? []) walk(child, id)
    }
    walk(root)
    for (const node of nodes) {
      const parent = nodes.find(candidate => candidate.id === node.parent)
      if (parent) parent.children.push(node.id)
    }
    return { kind: 'mindmap', nodes, linkers: [], containers: [], groups: [], roots: nodes.filter(node => !node.parent).map(node => node.id), meta: data?.meta ?? null }
  }
  const nodes = []
  const linkers = []
  const details = []
  const byId = new Map()
  for (const [id, element] of Object.entries(elements)) {
    if (!element || typeof element !== 'object') continue
    const name = String(element.name ?? '')
    const from = element.from?.id
    const to = element.to?.id
    const isLinker = name === 'linker' || (from && to)
    if (isLinker) {
      linkers.push({ from, to, label: textOfPos(element), linkerType: element.linkerType ?? null })
      continue
    }
    if (name === 'uml2_5_class_text' && element.container) {
      details.push({ container: element.container, label: textOfPos(element) })
      continue
    }
    if (name === 'standardText' && textOfPos(element) === '') continue
    const node = {
      id,
      label: textOfPos(element) || name,
      type: element.category || name || 'node',
      parentId: element.container ?? null,
      group: element.group ?? null,
      groupName: element.groupName ?? null,
      x: element.props?.x ?? null,
      y: element.props?.y ?? null,
      w: element.props?.w ?? null,
      h: element.props?.h ?? null,
      children: [],
    }
    nodes.push(node)
    byId.set(id, node)
  }
  for (const node of nodes) {
    if (node.parentId && byId.has(node.parentId)) byId.get(node.parentId).children.push(node.id)
  }
  const detailsBy = new Map()
  for (const detail of details) {
    if (!detailsBy.has(detail.container)) detailsBy.set(detail.container, [])
    detailsBy.get(detail.container).push(detail.label)
  }
  for (const node of nodes) node.details = detailsBy.get(node.id) ?? []
  const containers = nodes.filter(node => node.children.length > 0).map(node => ({ id: node.id, label: node.label, children: node.children }))
  const groups = []
  for (const node of nodes) {
    if (!node.group) continue
    let group = groups.find(item => item.id === node.group)
    if (!group) { group = { id: node.group, name: node.groupName || node.group, nodes: [] }; groups.push(group) }
    group.nodes.push(node.id)
  }
  return {
    kind: 'flowchart',
    nodes,
    linkers,
    containers,
    groups,
    roots: nodes.filter(node => !node.parentId).map(node => node.id),
    meta: data?.meta ?? null,
    source: filename,
  }
}

function textOfPos(element) {
  const values = []
  for (const block of Array.isArray(element.textBlock) ? element.textBlock : []) {
    if (block && typeof block.text === 'string' && block.text.trim()) values.push(block.text.trim())
  }
  for (const key of ['text', 'label']) {
    if (typeof element[key] === 'string' && element[key].trim() && !values.includes(element[key].trim())) values.push(element[key].trim())
  }
  return values.join(' / ')
}

function flowToMarkdown(flow) {
  const byId = new Map(flow.nodes.map(node => [node.id, node]))
  const lines = []
  if (flow.containers.length > 0) {
    lines.push('容器：')
    for (const container of flow.containers) {
      lines.push(`- ${container.label}`)
      for (const child of container.children) lines.push(`  - ${byId.get(child)?.label ?? child}`)
    }
    lines.push('')
  }
  if (flow.linkers.length > 0) {
    lines.push('连线：')
    for (const link of flow.linkers) {
      const from = byId.get(link.from)?.label ?? link.from ?? '?'
      const to = byId.get(link.to)?.label ?? link.to ?? '?'
      lines.push(`- ${from} → ${to}${link.label ? `（${link.label}）` : ''}`)
    }
  }
  return lines.join('\n').trim()
}

function walkFiles(dir, relative, files, warnings, state) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (error) {
    warnings.push(`${relative || '.'}: 无法读取：${error.message}`)
    return
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'zh'))
  for (const entry of entries) {
    if (state.count >= MAX_FILES) { warnings.push(`文件超过 ${MAX_FILES} 个，后续文件跳过`); return }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name === 'generated') continue
      walkFiles(path.join(dir, entry.name), relative ? `${relative}/${entry.name}` : entry.name, files, warnings, state)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.startsWith('.~') || entry.name.endsWith('.tmp')) continue
    const file = path.join(dir, entry.name)
    const rel = relative ? `${relative}/${entry.name}` : entry.name
    let stat
    try { stat = fs.statSync(file) } catch (error) { warnings.push(`${rel}: ${error.message}`); continue }
    if (stat.size > MAX_FILE_BYTES) { warnings.push(`${rel}: 超过 8 MB，跳过`); continue }
    state.count += 1
    files.push({ file, rel, size: stat.size, extension: path.extname(entry.name).toLowerCase() })
  }
}

/**
 * Parse a docs folder and write AI-CONTEXT.md / ai-context.json under root/docs/board.
 * @returns summary object
 */
export function buildContext(root, sourceDir, outputDir = 'docs/board') {
  const absoluteSource = path.resolve(sourceDir)
  if (!fs.existsSync(absoluteSource) || !fs.statSync(absoluteSource).isDirectory()) {
    throw new Error(`文档文件夹不可用：${sourceDir}`)
  }
  const output = path.join(root, outputDir)
  const assetsDir = path.join(output, 'generated', 'assets')
  const imagePrefix = 'generated/assets'
  const warnings = []
  const state = { count: 0 }
  const sources = []
  const entries = []
  walkFiles(absoluteSource, '', sources, warnings, state)

  let totalChars = 0
  const flows = []
  for (const entry of sources) {
    if (entry.extension === '.docx') {
      try {
        const buffer = fs.readFileSync(entry.file)
        const parsed = docxToMarkdown(buffer, entry.rel, assetsDir, imagePrefix, warnings)
        entries.push({ path: entry.rel, type: 'docx', title: parsed.title, markdown: parsed.markdown, images: parsed.images })
        totalChars += parsed.markdown.length
      } catch (error) {
        warnings.push(`${entry.rel}: DOCX 解析失败：${error.message}`)
      }
    } else if (entry.extension === '.pos') {
      try {
        const parsed = posToGraph(fs.readFileSync(entry.file), entry.rel)
        const flow = { path: entry.rel, kind: parsed.kind, nodes: parsed.nodes, linkers: parsed.linkers, containers: parsed.containers, groups: parsed.groups, roots: parsed.roots, markdown: flowToMarkdown(parsed) }
        flows.push(flow)
        entries.push({ path: entry.rel, type: 'pos', title: path.basename(entry.rel, '.pos'), markdown: flow.markdown, flows: [flow] })
        totalChars += flow.markdown.length
      } catch (error) {
        warnings.push(`${entry.rel}: .pos 解析失败：${error.message}`)
      }
    } else if (TEXT_EXT.has(entry.extension)) {
      try {
        const markdown = fs.readFileSync(entry.file, 'utf8')
        entries.push({ path: entry.rel, type: 'markdown', title: path.basename(entry.rel, entry.extension), markdown })
        totalChars += markdown.length
      } catch (error) {
        warnings.push(`${entry.rel}: ${error.message}`)
      }
    } else if (IMAGE_EXT.has(entry.extension)) {
      try {
        const buffer = fs.readFileSync(entry.file)
        if (buffer.length > MAX_FILE_BYTES) { warnings.push(`${entry.rel}: 图片超过 8 MB，跳过`); continue }
        const assetName = `${sha1(buffer).slice(0, 12)}-${path.basename(entry.rel)}`
        fs.mkdirSync(assetsDir, { recursive: true })
        fs.writeFileSync(path.join(assetsDir, assetName), buffer)
        entries.push({ path: entry.rel, type: 'image', title: path.basename(entry.rel), image: `${imagePrefix}/${assetName}` })
      } catch (error) {
        warnings.push(`${entry.rel}: ${error.message}`)
      }
    } else {
      warnings.push(`${entry.rel}: 未支持格式 ${entry.extension || '(无扩展名)'}`)
    }
    if (totalChars > MAX_TOTAL_CHARS) {
      warnings.push('文档文本超过 4M 字符，后续内容截断')
      break
    }
  }

  const documents = entries.filter(entry => entry.markdown !== undefined)
  const images = [
    ...entries.filter(entry => entry.image !== undefined).map(entry => ({ path: entry.path, image: entry.image })),
    ...documents.flatMap(entry => (entry.images ?? []).map(image => ({ path: `${entry.path} :: ${image.source}`, image: image.path }))),
  ]
  const flowReference = flows[0] ?? null
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceDir: absoluteSource,
    fileCount: entries.length,
    documentCount: documents.length,
    imageCount: images.length,
    flowCount: flows.length,
    warnings,
    documents: documents.map(item => ({ path: item.path, type: item.type, title: item.title, chars: item.markdown.length })),
    images: images.map(item => ({ path: item.path, url: item.image })),
  }

  const markdown = [
    '# AI 项目上下文',
    '',
    `> 生成时间：${summary.generatedAt}`,
    `> 来源：${absoluteSource}`,
    `> 已解析：${documents.length} 个文档 / ${images.length} 张图片 / ${flows.length} 个流程`,
    '',
    '## 文档',
    '',
    ...documents.map(document => `### ${document.path}\n\n${document.markdown}`),
    ...(images.length > 0 ? ['## 图片', '', ...images.map(image => `- ${image.path}: ${image.image}`)] : []),
    ...(warnings.length > 0 ? ['## 警告', '', ...warnings.map(warning => `- ${warning}`)] : []),
  ].join('\n') + '\n'

  fs.mkdirSync(output, { recursive: true })
  const write = (file, content) => {
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(temporary, content, 'utf8')
    fs.renameSync(temporary, file)
  }
  write(path.join(output, CONTEXT_MD), markdown)
  write(path.join(output, CONTEXT_JSON), JSON.stringify({ ...summary, files: documents, flows, imageFiles: images }, null, 2) + '\n')
  if (flowReference !== null) {
    write(path.join(output, 'flow-reference.json'), JSON.stringify({
      schemaVersion: 1,
      source: flowReference.path,
      generatedAt: summary.generatedAt,
      nodes: flowReference.nodes,
      linkers: flowReference.linkers,
      containers: flowReference.containers,
      groups: flowReference.groups,
      roots: flowReference.roots,
      warnings,
    }, null, 2) + '\n')
  }
  return { ...summary, markdownPath: `${outputDir}/${CONTEXT_MD}`, jsonPath: `${outputDir}/${CONTEXT_JSON}` }
}

export function readContext(root, outputDir = 'docs/board') {
  const jsonPath = path.join(root, outputDir, CONTEXT_JSON)
  const mdPath = path.join(root, outputDir, CONTEXT_MD)
  let summary = null
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    summary = {
      generatedAt: parsed.generatedAt,
      sourceDir: parsed.sourceDir,
      fileCount: parsed.fileCount,
      documentCount: parsed.documentCount,
      imageCount: parsed.imageCount,
      flowCount: parsed.flowCount,
      warnings: parsed.warnings ?? [],
      paths: { json: `${outputDir}/${CONTEXT_JSON}`, markdown: `${outputDir}/${CONTEXT_MD}` },
    }
  } catch { /* no generated context yet */ }
  let markdown = ''
  try { markdown = fs.readFileSync(mdPath, 'utf8') } catch { /* absent */ }
  return { summary, markdown }
}
