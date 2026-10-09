import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createInsightsHandler } from '../agents/insightsHandler.js'

const data = [
  { id: 1, content: '本周完成登录模块开发。', created_at: '2026-09-01', updated_at: '2026-09-01' },
  { id: 2, content: '本周完成权限模块开发。', created_at: '2026-09-08', updated_at: '2026-09-08' }
]
const logger = { info() {} }
const request = (question = '') => ({ user: { userId: 7 }, body: { question } })

class Response extends EventEmitter {
  statusCode = 200
  headers = {}
  headersSent = false
  writableEnded = false
  output = ''
  status(code) { this.statusCode = code; return this }
  setHeader(name, value) { this.headers[name] = value }
  flushHeaders() { this.headersSent = true }
  write(content) { this.headersSent = true; this.output += content }
  end() { this.writableEnded = true; this.emit('close') }
  json(value) { this.body = value; this.headersSent = true; this.end(); return this }
}

function db() {
  return { async execute(sql, args) {
    assert.equal(sql.includes('WHERE id') ? args[1] : args[0], 7)
    if (sql.includes('LIMIT 2')) return [[{ id: 1 }, { id: 2 }]]
    if (sql.includes('WHERE id')) return [data.filter((row) => row.id === args[0])]
    throw new Error('unexpected query')
  } }
}

function provider() {
  let turn = 0
  return async () => {
    if (turn++ === 0) return { finishReason: 'tool_calls', usage: { total_tokens: 100 },
      message: { role: 'assistant', content: null, tool_calls: [1, 2].map((id) => ({
        id: `read-${id}`, type: 'function', function: { name: 'read_report', arguments: JSON.stringify({ reportId: id }) }
      })) } }
    return { finishReason: 'stop', usage: { total_tokens: 100 }, message: { role: 'assistant', content: JSON.stringify({
      workstreams: [{ text: '登录与权限模块均有推进记录。', evidence: data.map((row) => ({ reportId: row.id, quote: row.content })) }],
      continuity: [], recurringProblems: [], suggestions: []
    }) } }
  }
}

test('insights handler emits progress, validated result and DONE in order with no DB writes', async () => {
  const response = new Response()
  await createInsightsHandler({ db: db(), complete: provider(), logger })(request(), response)
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Content-Type'], 'text/event-stream; charset=utf-8')
  const events = response.output.split('\n\n').filter(Boolean).map((event) => event.slice(6))
  assert.equal(JSON.parse(events[0]).type, 'progress')
  const result = JSON.parse(events.at(-2))
  assert.equal(result.type, 'result')
  assert.equal(result.result.sources.length, 2)
  assert.equal(result.result.metrics.steps, 2)
  assert.ok(result.result.runId)
  assert.equal(events.at(-1), '[DONE]')
  assert.equal(response.listenerCount('close'), 0)
})

test('input and minimum-history checks happen before starting SSE or model calls', async () => {
  let modelCalled = false
  const handler = createInsightsHandler({ db: { execute: async () => [[]] }, complete: async () => { modelCalled = true }, logger })
  const invalid = new Response()
  await handler(request({ injected: true }), invalid)
  assert.equal(invalid.statusCode, 400)
  const empty = new Response()
  await handler(request(), empty)
  assert.equal(empty.statusCode, 400)
  assert.match(empty.body.message, /至少需要 2/)
  assert.equal(modelCalled, false)
})

test('concurrent runs are rejected and disconnect releases the per-user lock', async () => {
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const handler = createInsightsHandler({ db: db(), logger, complete: async () => {
    started()
    return new Promise(() => {})
  } })
  const first = new Response()
  const pending = handler(request(), first)
  await ready
  const second = new Response()
  await handler(request(), second)
  assert.equal(second.statusCode, 409)
  first.emit('close')
  await pending
  assert.equal(first.output.includes('"type":"result"'), false)
  const third = new Response()
  await handler(request(42), third)
  assert.equal(third.statusCode, 400)
  // A fresh valid request can enter the provider again after the cancelled run.
  const fourth = new Response()
  const next = handler(request(), fourth)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fourth.statusCode, 200)
  fourth.emit('close')
  await next
})

test('upstream errors are sanitized and failed runs do not emit result or DONE', async () => {
  const response = new Response()
  await createInsightsHandler({ db: db(), logger, complete: async () => {
    throw new Error('private header and provider details')
  } })(request(), response)
  assert.match(response.output, /AGENT_FAILED/)
  assert.equal(response.output.includes('private header'), false)
  assert.equal(response.output.includes('"type":"result"'), false)
  assert.equal(response.output.includes('[DONE]'), false)
  assert.equal(response.writableEnded, true)
})

test('disconnect cancels a pending preflight query and permits the next run', async () => {
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const handler = createInsightsHandler({ logger, db: { execute: async () => {
    started()
    return new Promise(() => {})
  } }, complete: async () => { throw new Error('must not call') } })
  const response = new Response()
  const pending = handler(request(), response)
  await ready
  response.emit('close')
  await pending
  assert.equal(response.output, '')
})
