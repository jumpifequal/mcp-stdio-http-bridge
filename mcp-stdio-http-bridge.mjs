#!/usr/bin/env node
// stdio <-> MCP Streamable HTTP bridge, no OAuth, no external deps.
// Works for any MCP HTTP server (x64dbg, x32dbg, Malcat, ...): point it at the
// right URL/token via CLI args, nothing in this file is target-specific.
//
// Usage: node mcp-stdio-http-bridge.mjs <url> ["<HeaderName>: <HeaderValue>"]
//   node mcp-stdio-http-bridge.mjs http://127.0.0.1:9009/mcp
//   node mcp-stdio-http-bridge.mjs http://127.0.0.1:9094/ "Authorization: Bearer TOKEN"
//
// Optional env vars:
//   BRIDGE_PROBE_MS    reconnect probe interval while offline (default 5000, 0 = off)
//   BRIDGE_CONNECT_MS  timeout for a backend connect/initialize attempt (default 3000)
//   BRIDGE_STATUS_TOOL name of the local status tool (default "bridge_status", "" = none)
//   BRIDGE_TOOL_PREFIX prefix for <prefix>_call / <prefix>_list_tools (default: STATUS_TOOL minus "_status")
//   BRIDGE_CACHE_DIR   where the backend tool list is cached (default: .bridge-cache next to this script)
//
// v2.1: some clients (e.g. Cowork's device proxy) read tools/list only once and
// ignore notifications/tools/list_changed. Two mitigations:
//   * the last-known backend tool list is cached on disk and served while the
//     backend is offline, so the real tools are visible from session start;
//     calling one lazily connects to the backend once it is running;
//   * <prefix>_list_tools + <prefix>_call give a generic pass-through that works
//     even with a stale/empty tool list.
//
// OFFLINE-TOLERANT BEHAVIOUR (v2)
// If the backend is not running, the bridge no longer fails the MCP handshake.
// It answers `initialize` itself (advertising tools.listChanged), exposes only a
// local status tool, and probes the backend in the background. As soon as the
// backend is reachable it performs the real initialize against it and emits
// `notifications/tools/list_changed`, so the client can re-fetch the real tool
// list. If the backend goes away later, tool calls return a tool-level error
// (isError: true) instead of a JSON-RPC error, and the probe loop restarts.
// A backend restart (new Mcp-Session-Id, HTTP 404/400 on the old one) is handled
// with a transparent re-initialize and one retry.

import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [, , url, headerArg] = process.argv
if (!url) {
  process.stderr.write('Usage: node mcp-stdio-http-bridge.mjs <url> ["Header: Value"]\n')
  process.exit(1)
}

let headerName = null
let headerValue = null
if (headerArg) {
  const sepIdx = headerArg.indexOf(':')
  if (sepIdx === -1) {
    process.stderr.write('Header argument must be of the form "Name: Value"\n')
    process.exit(1)
  }
  headerName = headerArg.slice(0, sepIdx).trim()
  headerValue = headerArg.slice(sepIdx + 1).trim()
}

const PROBE_MS = numEnv('BRIDGE_PROBE_MS', 5000)
const CONNECT_MS = numEnv('BRIDGE_CONNECT_MS', 3000)
const STATUS_TOOL = process.env.BRIDGE_STATUS_TOOL ?? 'bridge_status'
// Prefix for the other local tools (<prefix>_call, <prefix>_list_tools).
const PREFIX = process.env.BRIDGE_TOOL_PREFIX || (STATUS_TOOL ? STATUS_TOOL.replace(/_status$/, '') : 'bridge')
const CALL_TOOL = `${PREFIX}_call`
const LIST_TOOL = `${PREFIX}_list_tools`
const LOCAL_TOOLS = new Set([STATUS_TOOL, CALL_TOOL, LIST_TOOL].filter(Boolean))
const CACHE_DIR = process.env.BRIDGE_CACHE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '.bridge-cache')
const CACHE_FILE = path.join(CACHE_DIR, url.replace(/[^a-z0-9]+/gi, '_') + '.tools.json')
const BRIDGE_VERSION = '2.1.0'

function numEnv(name, def) {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v >= 0 ? v : def
}

// ---------------------------------------------------------------- state
let sessionId = null
let backendReady = false
let backendInit = null // backend's initialize result
let connecting = null // shared in-flight connect promise
let clientInitParams = null // params of the client's initialize
let clientInitialized = false // client sent notifications/initialized
let lastError = null
let probeTimer = null
let internalId = 0

function log(...args) {
  process.stderr.write('[mcp-stdio-http-bridge] ' + args.join(' ') + '\n')
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function isRequest(m) {
  return m && typeof m.method === 'string' && Object.prototype.hasOwnProperty.call(m, 'id')
}

function reply(m, result) {
  send({ jsonrpc: '2.0', id: m.id, result })
}

function replyError(m, code, text) {
  if (m && Object.prototype.hasOwnProperty.call(m, 'id')) {
    send({ jsonrpc: '2.0', id: m.id, error: { code, message: text } })
  }
}

function notifyToolsChanged() {
  if (clientInitialized) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
}

function describeFetchError(err) {
  const code = err?.cause?.code || err?.code || err?.name
  if (code === 'ECONNREFUSED') return `backend not running or not listening at ${url} (connection refused)`
  if (code === 'TimeoutError' || code === 'AbortError') return `backend at ${url} did not answer in time`
  return `backend at ${url} unreachable: ${err?.message || code}`
}

// ---------------------------------------------------------------- HTTP helpers
async function post(message, { timeoutMs } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  if (headerName) headers[headerName] = headerValue
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  })
  const newSession = res.headers.get('mcp-session-id')
  if (newSession) sessionId = newSession
  return res
}

// Calls onMessage(obj) for every JSON-RPC message in the response body.
async function readMessages(res, onMessage) {
  const contentType = res.headers.get('content-type') || ''
  const emit = (text) => {
    if (!text.trim()) return
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      log('non-JSON payload from backend:', text.slice(0, 200))
      return
    }
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) onMessage(m)
  }

  if (contentType.includes('text/event-stream')) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let data = []
    const flushEvent = () => {
      if (data.length) emit(data.join('\n'))
      data = []
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (line === '') flushEvent()
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
    }
    if (buf.startsWith('data:')) data.push(buf.slice(5).trimStart())
    flushEvent()
  } else {
    emit(await res.text())
  }
}

// ---------------------------------------------------------------- backend lifecycle
function defaultInitParams() {
  return {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-stdio-http-bridge', version: BRIDGE_VERSION },
  }
}

function ensureBackend() {
  if (backendReady) return Promise.resolve(true)
  if (connecting) return connecting
  connecting = (async () => {
    sessionId = null
    const id = `bridge-init-${++internalId}`
    try {
      const res = await post(
        { jsonrpc: '2.0', id, method: 'initialize', params: clientInitParams || defaultInitParams() },
        { timeoutMs: CONNECT_MS }
      )
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status} on initialize: ${text.slice(0, 200)}`)
      }
      let result = null
      let error = null
      await readMessages(res, (m) => {
        if (m.id === id) {
          result = m.result ?? null
          error = m.error ?? null
        }
      })
      if (error) throw new Error(`initialize rejected: ${error.message || JSON.stringify(error)}`)
      if (!result) throw new Error('initialize returned no result')
      backendInit = result
      const ack = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { timeoutMs: CONNECT_MS })
      await ack.text().catch(() => '')
      backendReady = true
      lastError = null
      stopProbe()
      warmCache() // fire-and-forget: keeps the on-disk tool list current
      log(`backend online at ${url}` + (result.serverInfo?.name ? ` (${result.serverInfo.name})` : ''))
      return true
    } catch (err) {
      lastError = err instanceof Error && !err.cause ? err.message : describeFetchError(err)
      return false
    } finally {
      connecting = null
    }
  })()
  return connecting
}

function markOffline(reason) {
  const wasReady = backendReady
  backendReady = false
  sessionId = null
  lastError = reason
  if (wasReady) {
    log('backend went offline:', reason)
    notifyToolsChanged()
  }
  startProbe()
}

function startProbe() {
  if (probeTimer || !PROBE_MS || !clientInitParams) return
  probeTimer = setInterval(async () => {
    if (backendReady) return stopProbe()
    if (await ensureBackend()) notifyToolsChanged()
  }, PROBE_MS)
}

function stopProbe() {
  if (probeTimer) clearInterval(probeTimer)
  probeTimer = null
}

// ---------------------------------------------------------------- local (offline) answers
function statusText() {
  return backendReady
    ? `ONLINE: ${url}` + (backendInit?.serverInfo?.name ? ` (${backendInit.serverInfo.name} ${backendInit.serverInfo.version ?? ''})`.trimEnd() : '')
    : `OFFLINE: ${url} — ${lastError || 'not connected yet'}. Start the target application / its MCP server; ` +
        `the bridge reconnects automatically${PROBE_MS ? ` (probe every ${PROBE_MS} ms)` : ''}. ` +
        `If the client does not refresh its tool list, call this tool again or start a new session.`
}

function localToolDefs() {
  const defs = []
  if (STATUS_TOOL)
    defs.push({
      name: STATUS_TOOL,
      description:
        `Local tool of the stdio<->HTTP bridge. Reports whether the MCP backend at ${url} is reachable ` +
        `and forces an immediate reconnect attempt.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    })
  defs.push({
    name: LIST_TOOL,
    description:
      `Lists the tools currently exposed by the MCP backend at ${url} (name, description, input schema). ` +
      `Use it when the backend tools are not visible in this session, then invoke them via ${CALL_TOOL}.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  })
  defs.push({
    name: CALL_TOOL,
    description:
      `Generic pass-through: invokes any tool of the MCP backend at ${url} by name. Works even when the ` +
      `client's tool list is stale (e.g. the backend was started after the session). Get names/schemas from ${LIST_TOOL}.`,
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Backend tool name' },
        arguments: { type: 'object', description: 'Arguments object for the backend tool', additionalProperties: true },
      },
      required: ['tool'],
      additionalProperties: false,
    },
  })
  return defs
}

function loadCachedTools() {
  try {
    const t = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    return Array.isArray(t) ? t : []
  } catch {
    return []
  }
}

function saveCachedTools(tools) {
  try {
    const clean = tools.filter((t) => !LOCAL_TOOLS.has(t.name))
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(clean, null, 1))
  } catch (err) {
    log('cannot write tool cache:', err.message)
  }
}

function mergeTools(backendTools) {
  const out = backendTools.filter((t) => !LOCAL_TOOLS.has(t.name))
  return out.concat(localToolDefs())
}

// POST an internal request and return the JSON-RPC response with the same id.
async function request(method, params) {
  const id = `bridge-${++internalId}`
  const res = await post({ jsonrpc: '2.0', id, method, params })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const e = new Error(`HTTP ${res.status} from backend: ${text.slice(0, 300)}`)
    e.status = res.status
    throw e
  }
  let out = null
  await readMessages(res, (m) => {
    if (m.id === id) out = m
  })
  if (!out) throw new Error(`no response to ${method}`)
  return out
}

// Online-only helper with offline/session-loss handling. Returns response or null.
async function backendRequest(method, params) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await ensureBackend())) return null
    try {
      return await request(method, params)
    } catch (err) {
      if ((err.status === 404 || err.status === 400) && attempt === 0) {
        backendReady = false
        continue
      }
      if (err.status) throw err
      markOffline(describeFetchError(err))
      return null
    }
  }
  return null
}

async function warmCache() {
  try {
    const r = await request('tools/list', {})
    if (Array.isArray(r.result?.tools)) {
      saveCachedTools(r.result.tools)
      log(`cached ${r.result.tools.length} backend tools -> ${CACHE_FILE}`)
    }
  } catch (err) {
    log('warmCache failed:', err.message)
  }
}

function offlineToolError(m) {
  reply(m, { content: [{ type: 'text', text: statusText() }], isError: true })
}

function answerOffline(m) {
  switch (m.method) {
    case 'ping':
      return reply(m, {})
    case 'tools/list':
      return reply(m, { tools: mergeTools(loadCachedTools()) })
    case 'tools/call':
      return offlineToolError(m)
    case 'resources/list':
      return reply(m, { resources: [] })
    case 'resources/templates/list':
      return reply(m, { resourceTemplates: [] })
    case 'prompts/list':
      return reply(m, { prompts: [] })
    default:
      return replyError(m, -32001, statusText())
  }
}

// ---------------------------------------------------------------- message handling
async function handleInitialize(m) {
  clientInitParams = m.params || defaultInitParams()
  const online = await ensureBackend()
  const base = online
    ? structuredClone(backendInit)
    : {
        protocolVersion: clientInitParams.protocolVersion || '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'mcp-stdio-http-bridge', version: BRIDGE_VERSION },
        instructions: `MCP backend ${url} is currently offline; its tools will appear once it is started.`,
      }
  base.capabilities = base.capabilities || {}
  base.capabilities.tools = { ...(base.capabilities.tools || {}), listChanged: true }
  reply(m, base)
  if (!online) {
    log('initialize answered locally —', lastError)
    startProbe()
  }
}

async function forwardOnce(m) {
  const res = await post(m)
  if (res.status === 202) {
    await res.text().catch(() => '')
    return { ok: true }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, status: res.status, text }
  }
  const isToolsList = m.method === 'tools/list'
  await readMessages(res, (out) => {
    if (isToolsList && out.id === m.id && Array.isArray(out.result?.tools)) {
      saveCachedTools(out.result.tools)
      out.result.tools = mergeTools(out.result.tools)
    }
    send(out)
  })
  return { ok: true }
}

async function forward(m) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let r
    try {
      r = await forwardOnce(m)
    } catch (err) {
      markOffline(describeFetchError(err))
      return isRequest(m) ? answerOffline(m) : undefined
    }
    if (r.ok) return
    // Session lost (backend restarted): re-initialize once and retry.
    if ((r.status === 404 || r.status === 400) && attempt === 0) {
      log(`HTTP ${r.status}, re-initializing backend session`)
      backendReady = false
      if (await ensureBackend()) {
        notifyToolsChanged()
        continue
      }
      markOffline(lastError)
      return isRequest(m) ? answerOffline(m) : undefined
    }
    log(`HTTP ${r.status} from backend:`, r.text.slice(0, 500))
    if (m.method === 'tools/call') {
      return reply(m, { content: [{ type: 'text', text: `HTTP ${r.status} from backend: ${r.text.slice(0, 300)}` }], isError: true })
    }
    return replyError(m, -32000, `HTTP ${r.status} from backend: ${r.text.slice(0, 300)}`)
  }
}

async function handle(m) {
  if (m.method === 'initialize') return handleInitialize(m)

  if (m.method === 'notifications/initialized') {
    clientInitialized = true // bridge already sent its own initialized to the backend
    return
  }

  if (m.method === 'tools/call' && LOCAL_TOOLS.has(m.params?.name)) return handleLocalTool(m)

  if (!backendReady) {
    // Lazy reconnect on demand (the backend may have just started).
    const wasReady = backendReady
    if (await ensureBackend()) {
      if (!wasReady && m.method !== 'tools/list') notifyToolsChanged()
    } else {
      if (isRequest(m)) answerOffline(m)
      return // drop notifications / client responses while offline
    }
  }

  return forward(m)
}

async function handleLocalTool(m) {
  const name = m.params.name
  const args = m.params.arguments || {}
  const wasReady = backendReady
  try {
    if (name === STATUS_TOOL) {
      const online = await ensureBackend()
      reply(m, { content: [{ type: 'text', text: statusText() }], isError: !online })
    } else if (name === LIST_TOOL) {
      const r = await backendRequest('tools/list', {})
      if (!r) {
        const cached = loadCachedTools()
        return reply(m, {
          content: [{ type: 'text', text: statusText() + (cached.length ? `\nCached tool list (${cached.length}):\n` + JSON.stringify(cached.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))) : '') }],
          isError: true,
        })
      }
      if (r.error) return reply(m, { content: [{ type: 'text', text: `tools/list error: ${r.error.message}` }], isError: true })
      const tools = (r.result?.tools || []).filter((t) => !LOCAL_TOOLS.has(t.name))
      saveCachedTools(tools)
      reply(m, { content: [{ type: 'text', text: JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))) }] })
    } else if (name === CALL_TOOL) {
      if (!args.tool || typeof args.tool !== 'string')
        return reply(m, { content: [{ type: 'text', text: `"tool" (string) is required. Use ${LIST_TOOL} to see available tools.` }], isError: true })
      const r = await backendRequest('tools/call', { name: args.tool, arguments: args.arguments || {} })
      if (!r) return offlineToolError(m)
      if (r.error) return reply(m, { content: [{ type: 'text', text: `backend error ${r.error.code}: ${r.error.message}` }], isError: true })
      reply(m, r.result)
    }
  } catch (err) {
    reply(m, { content: [{ type: 'text', text: `bridge error: ${err.message}` }], isError: true })
  }
  if (backendReady && !wasReady) notifyToolsChanged()
}

// ---------------------------------------------------------------- main loop
const rl = readline.createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch (err) {
    log('failed to parse stdin line as JSON:', err.message)
    return
  }
  handle(msg).catch((err) => {
    log('handler error:', err.message)
    if (isRequest(msg)) replyError(msg, -32603, `bridge internal error: ${err.message}`)
  })
})

rl.on('close', () => process.exit(0))

log(`bridging stdio <-> ${url}${headerName ? ` with header "${headerName}"` : ' (no auth header)'} [offline-tolerant v${BRIDGE_VERSION}]`)
