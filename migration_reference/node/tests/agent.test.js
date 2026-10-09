import test from 'node:test'
import assert from 'node:assert/strict'
import { runAgent } from '../agents/runAgent.js'
import { createReportTools } from '../agents/reportTools.js'
import { createToolRegistry } from '../agents/toolRegistry.js'
import { runInsightsAgent } from '../agents/insightsAgent.js'
import { validateInsightsResult } from '../agents/insightsResult.js'

const rows = [
  { id: 1, user_id: 7, content: '本周完成登录模块。下周计划开发权限模块。问题：权限设计不熟悉。', created_at: '2026-09-01', updated_at: '2026-09-01' },
  { id: 2, user_id: 7, content: '本周完成权限模块开发。问题：权限设计仍需完善。', created_at: '2026-09-08', updated_at: '2026-09-08' },
  { id: 3, user_id: 8, content: '其他用户的私密数据', created_at: '2026-09-09', updated_at: '2026-09-09' }
]

function fakeDb(data = rows) {
  const calls = []
  return {
    calls,
    async execute(sql, args) {
      calls.push({ sql, args })
      if (sql.includes('WHERE id = ? AND user_id = ?')) {
        return [data.filter((row) => row.id === args[0] && row.user_id === args[1])]
      }
      return [data.filter((row) => row.user_id === args[0] && (!args[1] || row.content.includes(args[1])))
        .sort((a, b) => b.id - a.id).slice(args[4], args[4] + args[3])]
    }
  }
}

function call(name, args, id = 'call-1') {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}
const toolResponse = (...calls) => ({ message: { role: 'assistant', content: null, tool_calls: calls }, finishReason: 'tool_calls', usage: { total_tokens: 100 } })
const finalResponse = (content) => ({ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) }, finishReason: 'stop', usage: { total_tokens: 100 } })
const validResult = () => ({
  workstreams: [{ text: '工作围绕登录与权限模块推进。', evidence: [
    { reportId: 1, quote: '本周完成登录模块。' }, { reportId: 2, quote: '本周完成权限模块开发。' }
  ] }], continuity: [], recurringProblems: [], suggestions: []
})
const context = () => ({ userId: 7, sources: new Map(), signal: new AbortController().signal })

test('report tools enforce schemas and bind all queries to authenticated user', async () => {
  const db = fakeDb()
  const registry = createReportTools(db)
  const ctx = context()
  assert.equal((await registry.execute(call('search_reports', {}), ctx)).reports.length, 2)
  assert.equal(db.calls[0].args[0], 7)
  assert.match(db.calls[0].sql, /user_id = \?/)
  assert.equal((await registry.execute(call('read_report', { reportId: 1 }), ctx)).id, 1)
  assert.deepEqual(db.calls[1].args, [1, 7])
  await assert.rejects(registry.execute(call('read_report', { reportId: 3 }), ctx), /无权访问/)
  const count = db.calls.length
  for (const invalid of [call('read_report', { reportId: 1, userId: 8 }),
    call('search_reports', { limit: 100 }), call('search_reports', { offset: -1 }),
    call('read_report', { reportId: '1' }), call('delete_report', { reportId: 1 }),
    { id: 'bad', type: 'function', function: { name: 'read_report', arguments: '{oops' } }]) {
    await assert.rejects(registry.execute(invalid, ctx), { name: 'AgentError' })
  }
  assert.equal(db.calls.length, count, 'invalid calls never reach the database')
})

test('report tools bound pagination, preserve literal keywords and mark truncation', async () => {
  const data = Array.from({ length: 10 }, (_, index) => ({ ...rows[0], id: index + 1, content: '%权限_'.repeat(2200) }))
  const db = fakeDb(data)
  const registry = createReportTools(db)
  const ctx = context()
  const page = await registry.execute(call('search_reports', { keyword: '%权限_', limit: 2, offset: 2 }), ctx)
  assert.equal(page.hasMore, true)
  assert.equal(page.nextOffset, 4)
  assert.equal(page.reports[0].summary.length, 300)
  assert.equal(db.calls[0].args[1], '%权限_')
  assert.match(db.calls[0].sql, /LOCATE/)
  const source = await registry.execute(call('read_report', { reportId: 1 }), ctx)
  assert.equal(source.content.length, 6000)
  assert.equal(source.truncated, true)
  await registry.execute(call('read_report', { reportId: 1 }), ctx)
  assert.equal(db.calls.length, 2, 'repeated reads use the same snapshot')
  for (let id = 2; id <= 8; id++) await registry.execute(call('read_report', { reportId: id }), ctx)
  await assert.rejects(registry.execute(call('read_report', { reportId: 9 }), ctx), /最多读取 8/)
})

test('actual insights loop searches, reads, feeds tool results back and validates final evidence', async () => {
  const db = fakeDb()
  const requests = []
  const progress = []
  const responses = [toolResponse(call('search_reports', {}, 'search')),
    toolResponse(call('read_report', { reportId: 1 }, 'read-1'), call('read_report', { reportId: 2 }, 'read-2')),
    finalResponse(validResult())]
  responses[0].message.reasoning_content = 'provider metadata'
  const outcome = await runInsightsAgent({ db, userId: 7, signal: context().signal,
    onEvent: (event) => progress.push(event), complete: async (request) => {
      requests.push(structuredClone({ messages: request.messages, tools: request.tools }))
      return responses.shift()
    } })
  assert.equal(outcome.metrics.steps, 3)
  assert.equal(outcome.metrics.toolCalls, 3)
  assert.equal(outcome.metrics.totalTokens, 300)
  assert.equal(outcome.result.sources.length, 2)
  assert.equal(outcome.result.sections.length, 4)
  assert.match(outcome.result.limitations[0], /不代表周报所属周期/)
  assert.equal(requests[1].messages[2].reasoning_content, 'provider metadata')
  assert.equal(requests[1].messages[3].tool_call_id, 'search')
  assert.equal(requests[2].messages.filter((message) => message.role === 'tool').length, 3)
  assert.ok(progress.some((event) => event.stage === 'validating'))
})

test('invalid final evidence gets bounded repair feedback, not published output', async () => {
  let count = 0
  const invalid = validResult()
  invalid.workstreams[0].evidence[0].quote = '系统已经上线并提高效率百分之五十'
  const responses = [toolResponse(call('read_report', { reportId: 1 }, 'r1'), call('read_report', { reportId: 2 }, 'r2')),
    finalResponse(invalid), finalResponse(validResult())]
  const outcome = await runInsightsAgent({ db: fakeDb(), userId: 7, signal: context().signal,
    complete: async ({ messages }) => {
      if (count === 2) assert.match(messages.at(-1).content, /原文中的连续片段/)
      count++
      return responses.shift()
    } })
  assert.equal(outcome.metrics.repairs, 1)
  assert.equal(outcome.metrics.steps, 3)
})

test('citation validator rejects unread IDs, single-source continuity and malformed output', () => {
  const ctx = context()
  ctx.sources.set(1, { id: 1, content: rows[0].content })
  ctx.sources.set(2, { id: 2, content: rows[1].content })
  const unread = validResult()
  unread.workstreams[0].evidence[1].reportId = 3
  assert.equal(validateInsightsResult(JSON.stringify(unread), ctx).ok, false)
  const continuity = validResult()
  continuity.continuity = [{ text: '计划得到承接', evidence: [{ reportId: 1, quote: '下周计划开发权限模块。' }] }]
  assert.match(validateInsightsResult(JSON.stringify(continuity), ctx).error, /至少两份/)
  assert.equal(validateInsightsResult('```json\n{}\n```', ctx).ok, false)
  assert.equal(validateInsightsResult(JSON.stringify({ ...validResult(), injected: 'bad' }), ctx).ok, false)
  assert.equal(validateInsightsResult(JSON.stringify(validResult()), ctx).ok, true)
  const insufficient = validateInsightsResult(JSON.stringify({ workstreams: [], continuity: [], recurringProblems: [], suggestions: [] }), ctx)
  assert.equal(insufficient.ok, true)
  assert.equal(insufficient.value.sources.length, 2)
  assert.match(insufficient.value.limitations[1], /不生成推测性结论/)
})

function basicLoop(overrides = {}) {
  return { messages: [{ role: 'system', content: 'test' }], context: {}, registry: createToolRegistry([]),
    signal: context().signal, complete: async () => finalResponse('{}'),
    validateFinal: () => ({ ok: true, value: {} }), ...overrides }
}

test('unknown tools return repairable errors and never execute arbitrary code', async () => {
  let turn = 0
  const result = await runAgent(basicLoop({ complete: async ({ messages }) => {
    if (turn++ === 0) return toolResponse(call('execute_sql', { sql: 'DELETE FROM reports' }))
    assert.equal(JSON.parse(messages.at(-1).content).error.code, 'TOOL_INPUT_INVALID')
    return finalResponse('{}')
  } }))
  assert.equal(result.metrics.toolCalls, 1)
})

test('step, tool, context, token and repair budgets terminate the loop', async () => {
  await assert.rejects(runAgent(basicLoop({ validateFinal: () => ({ ok: false, error: 'bad evidence' }),
    limits: { maxSteps: 1 } })), { code: 'AGENT_STEP_LIMIT' })
  await assert.rejects(runAgent(basicLoop({ complete: async () => toolResponse(call('unknown', {})),
    limits: { maxToolCalls: 0 } })), { code: 'AGENT_TOOL_LIMIT' })
  await assert.rejects(runAgent(basicLoop({ limits: { maxContextChars: 1 } })), { code: 'AGENT_CONTEXT_LIMIT' })
  await assert.rejects(runAgent(basicLoop({ limits: { maxTotalTokens: 1 } })), { code: 'AGENT_TOKEN_LIMIT' })
  await assert.rejects(runAgent(basicLoop({ validateFinal: () => ({ ok: false, error: 'bad evidence' }),
    limits: { maxFinalRepairs: 0 } })), { code: 'AGENT_EVIDENCE_INVALID' })
})

test('missing usage is conservatively charged; incomplete responses cannot be accepted', async () => {
  const outcome = await runAgent(basicLoop({ complete: async () => ({ ...finalResponse('{}'), usage: undefined }) }))
  assert.equal(outcome.metrics.usageEstimated, true)
  assert.ok(outcome.metrics.totalTokens >= 3000)
  await assert.rejects(runAgent(basicLoop({ complete: async () => ({ ...finalResponse('{}'), finishReason: 'length' }) })),
    { code: 'AGENT_RESPONSE_INCOMPLETE' })
})

test('malformed tool calls and duplicate call IDs are rejected before executing tools', async () => {
  for (const calls of [[null], [call('unknown', {}, 'same'), call('unknown', {}, 'same')]]) {
    await assert.rejects(runAgent(basicLoop({ complete: async () => toolResponse(...calls) })), { code: 'AGENT_RESPONSE_INVALID' })
  }
  await assert.rejects(runAgent(basicLoop({ complete: async () => ({ ...finalResponse('{}'), finishReason: 'tool_calls' }) })),
    { code: 'AGENT_RESPONSE_INVALID' })
})

test('client abort and deadline stop pending model calls even if the adapter does not cooperate', async () => {
  const controller = new AbortController()
  let entered
  const ready = new Promise((resolve) => { entered = resolve })
  const pending = runAgent(basicLoop({ signal: controller.signal, complete: async () => {
    entered()
    return new Promise(() => {})
  } }))
  await ready
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  await assert.rejects(runAgent(basicLoop({ complete: async () => new Promise(() => {}), limits: { timeoutMs: 10 } })),
    { code: 'AGENT_TIMEOUT' })
})

test('abort during a DB read prevents late results, further model calls and final validation', async () => {
  const controller = new AbortController()
  let releaseDb
  let startedDb
  const ready = new Promise((resolve) => { startedDb = resolve })
  const db = { execute: async () => { startedDb(); return new Promise((resolve) => { releaseDb = resolve }) } }
  let modelCalls = 0
  const pending = runInsightsAgent({ db, userId: 7, signal: controller.signal, complete: async () => {
    modelCalls++
    return toolResponse(call('read_report', { reportId: 1 }))
  } })
  await ready
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  releaseDb([[rows[0]]])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(modelCalls, 1)
})
