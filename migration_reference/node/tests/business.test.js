import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { runClarificationAgent, validateClarificationResult } from '../agents/clarificationAgent.js'
import { runPlanAgent, supportsPlanStatus } from '../agents/planAgent.js'
import { createReportTools } from '../agents/reportTools.js'
import { createPlanToolDefinitions } from '../agents/planTools.js'
import { createDraftStore } from '../services/draftStore.js'
import { continueDraft, validateGeneratedDraft } from '../services/draftGeneration.js'
import { createPrepareHandler, createWeeklyHandler, createConfirmHandler } from '../services/weeklyHandlers.js'
import { streamDeepSeekToClient } from '../utils/streamDeepSeek.js'
import { createAgentHandler } from '../agents/agentHandler.js'
import { createInsightsHandler } from '../agents/insightsHandler.js'
import { TestResponse, createMemoryDb, toolCall, toolResponse, finalResponse, quietLogger } from './helpers.js'

const input = { work: '这周做了权限模块，解决了一些问题。', problems: '', nextPlan: '补充权限测试', style: 'detailed', useHistory: false }
const question = { id: 'q1', field: 'work', kind: 'status', anchor: '做了权限模块', question: '权限模块目前是已完成、进行中还是阻塞？' }
const signal = () => new AbortController().signal
const request = (body, userId = 7) => ({ body, user: { userId } })
const records = [
  { id: 1, user_id: 7, next_plan: '完成权限模块', work_content: '本周完成登录模块。', content: '本周完成登录模块。', created_at: '2026-09-01', updated_at: '2026-09-01' },
  { id: 2, user_id: 7, next_plan: '', work_content: '权限模块开发完成并已进入联调。', content: '权限模块开发完成并已进入联调。', created_at: '2026-09-08', updated_at: '2026-09-08' },
  { id: 3, user_id: 8, next_plan: '上线秘密项目', work_content: '秘密项目已上线。', content: '秘密项目已上线。', created_at: '2026-09-09', updated_at: '2026-09-09' }
]

test('sufficient information accepts an empty question set without forcing a fixed interview', async () => {
  const db = createMemoryDb()
  const outcome = await runClarificationAgent({ db, complete: async ({ tools, messages }) => {
    assert.equal(tools.length, 0)
    assert.match(messages[0].content, /信息充分时 questions 必须为空/)
    return finalResponse({ questions: [] })
  }, input: { ...input, work: '权限模块已完成开发和自测，解决角色校验缺失，下一步进行联调。' }, userId: 7, signal: signal() })
  assert.deepEqual(outcome.result.questions, [])
  assert.equal(db.queries.length, 0)
})

test('insufficient input returns bounded structured questions anchored to the input, no HTML or invented answers', async () => {
  const outcome = await runClarificationAgent({ db: createMemoryDb(), input, userId: 7, signal: signal(), complete: async () => finalResponse({ questions: [question] }) })
  assert.equal(outcome.result.questions.length, 1)
  const context = { input, sources: new Map() }
  for (const invalid of [
    { questions: Array.from({ length: 4 }, () => question) },
    { questions: [{ ...question, question: '<b>完成了吗</b>' }] },
    { questions: [{ ...question, anchor: '不存在的成果' }] },
    { questions: [{ ...question, answer: '已完成' }] }
  ]) assert.equal(validateClarificationResult(JSON.stringify(invalid), context).ok, false)
})

test('history can be searched in clarification, but disabled history rejects tools without querying DB', async () => {
  const db = createMemoryDb(records)
  const responses = [toolResponse(toolCall('read_report', { reportId: 1 })), finalResponse({ questions: [] })]
  const outcome = await runClarificationAgent({ db, input: { ...input, useHistory: true }, userId: 7, signal: signal(),
    complete: async () => responses.shift() })
  assert.equal(outcome.result.historySources[0].id, 1)
  assert.deepEqual(db.queries[0].args, [1, 7])
  const disabledDb = createMemoryDb(records)
  let turn = 0
  await runClarificationAgent({ db: disabledDb, input, userId: 7, signal: signal(), complete: async ({ messages }) => {
    if (turn++ === 0) return toolResponse(toolCall('read_report', { reportId: 1 }))
    assert.match(messages.at(-1).content, /历史检索未开启/)
    return finalResponse({ questions: [] })
  } })
  assert.equal(disabledDb.queries.length, 0)
})

test('skip continues the same draft and leaves status unknown; numeric and completed hallucinations are blocked', () => {
  const store = createDraftStore()
  const draft = store.create(7, input, [question])
  const { input: continued, unanswered } = continueDraft(draft, { skipClarification: true })
  assert.equal(continued.work, input.work)
  assert.equal(unanswered[0].id, 'q1')
  const text = validateGeneratedDraft('## 本周工作总结\n推进权限模块，具体完成状态待确认。', draft)
  assert.match(text, /无法确认/)
  assert.throws(() => validateGeneratedDraft('权限模块已完成，提升效率50%。', draft), { code: 'DRAFT_FACT_INVALID' })
  assert.throws(() => validateGeneratedDraft('权限模块开发完成。', draft), { code: 'DRAFT_FACT_INVALID' })
  const answered = store.create(7, input, [question])
  continueDraft(answered, { answers: [{ questionId: 'q1', value: '进行中，角色校验仍在开发。' }] })
  assert.match(answered.generationInput.work, /进行中/)
  assert.equal(answered.unanswered.length, 0)
  assert.equal(answered.generationInput.work.includes('已完成'), false, 'question alternatives never become source facts')
  assert.throws(() => continueDraft(store.create(7, input, [question]), { answers: [{ questionId: 'unknown', value: '编造' }] }), { code: 'DRAFT_INPUT' })
})

test('drafts are owned, expire and cannot be continued after being generated', () => {
  let now = 100
  const store = createDraftStore({ now: () => now, ttlMs: 10 })
  const draft = store.create(7, input)
  assert.throws(() => store.get(draft.id, 8), { code: 'DRAFT_NOT_FOUND' })
  draft.state = 'ready'
  assert.throws(() => continueDraft(draft, {}), { code: 'DRAFT_STATE' })
  now = 111
  assert.throws(() => store.get(draft.id, 7), { code: 'DRAFT_NOT_FOUND' })
})

async function runPlanScenario(data, status, quote) {
  const db = createMemoryDb(data)
  const responses = [toolResponse(toolCall('get_recent_plans', { reportId: 1 })),
    toolResponse(toolCall('find_plan_evidence', { planId: '1:0' })),
    ...(quote ? [toolResponse(toolCall('read_report', { reportId: 2 }))] : []),
    finalResponse({ plans: [{ planId: '1:0', status, evidence: quote ? [{ reportId: 2, field: 'work_content', quote }] : [] }] })]
  return runPlanAgent({ db, complete: async () => responses.shift(), userId: 7, reportId: 1, signal: signal(), limits: { maxFinalRepairs: 0 } })
}

test('completed plan requires real subsequent evidence and carries the original plan quote', async () => {
  const outcome = await runPlanScenario(records, 'completed', records[1].work_content)
  assert.equal(outcome.result.plans[0].status, 'completed')
  assert.equal(outcome.result.plans[0].evidence[0].field, 'next_plan')
  assert.equal(outcome.result.plans[0].evidence[1].quote, records[1].work_content)
  assert.equal(outcome.result.sources.some(source => source.id === 3), false)
})

test('no subsequent record returns unconfirmed with plan-origin Evidence, not unfinished', async () => {
  const outcome = await runPlanScenario([records[0]], 'unconfirmed')
  assert.equal(outcome.result.plans[0].status, 'unconfirmed')
  assert.deepEqual(outcome.result.plans[0].reviewedReportIds, [])
  assert.match(outcome.result.plans[0].reason, /没有提到不代表未完成/)
  assert.equal(outcome.result.plans[0].evidence[0].quote, '完成权限模块')
  await assert.rejects(runPlanScenario([records[0]], 'completed'), { code: 'AGENT_EVIDENCE_INVALID' })
})

test('unrelated, future, negated or fabricated evidence cannot establish plan completion', async () => {
  for (const quote of ['登录模块已完成并上线。', '下周计划完成权限模块。', '权限模块尚未完成开发。']) {
    await assert.rejects(runPlanScenario([records[0], { ...records[1], work_content: quote, content: quote }], 'completed', quote), { code: 'AGENT_EVIDENCE_INVALID' })
  }
  await assert.rejects(runPlanScenario(records, 'completed', '权限模块已上线并提升效率80%。'), { code: 'AGENT_EVIDENCE_INVALID' })
  assert.equal(supportsPlanStatus('完成权限模块', '权限模块正在开发中。', 'in_progress'), true)
  assert.equal(supportsPlanStatus('完成权限模块', '权限模块因接口问题而阻塞。', 'blocked'), true)
})

test('plan tools enforce user scope, arguments and whitelist before database access', async () => {
  const db = createMemoryDb(records)
  const registry = createReportTools(db, createPlanToolDefinitions(db))
  const context = { userId: 7, plans: new Map(), planSources: new Map(), sources: new Map(), planSearches: new Map(), signal: signal() }
  assert.deepEqual((await registry.execute(toolCall('get_recent_plans', { reportId: 3 }), context)).plans, [])
  assert.equal(context.planSources.size, 0)
  const previousQueries = db.queries.length
  for (const invalid of [toolCall('get_recent_plans', { userId: 8 }), toolCall('get_recent_plans', { reportId: '1' }),
    toolCall('find_plan_evidence', { planId: 'unknown' }), toolCall('execute_sql', { sql: 'DELETE FROM reports' }),
    toolCall('confirm_report', { sessionId: 'fake' })]) await assert.rejects(registry.execute(invalid, context))
  assert.equal(db.queries.length, previousQueries)
})

test('prepare and generation do not write; explicit confirmation is required and retry is idempotent', async () => {
  const store = createDraftStore()
  const db = createMemoryDb()
  const preparedResponse = new TestResponse()
  await createPrepareHandler({ db, store, logger: quietLogger, complete: async () => finalResponse({ questions: [question] }) })(request(input), preparedResponse)
  const sessionId = preparedResponse.events().find(event => event.type === 'result').result.sessionId
  const generated = new TestResponse()
  const handler = createWeeklyHandler({ db, store, logger: quietLogger, stream: async ({ res, onComplete }) => {
    res.write('data: {"type":"content","content":"推进权限模块，状态待确认。"}\n\n')
    await onComplete('推进权限模块，状态待确认。')
    res.write('data: [DONE]\n\n'); res.end()
  } })
  await handler(request({ sessionId, skipClarification: true }), generated)
  assert.equal(db.rows.length, 0)
  const content = store.get(sessionId, 7).content
  const confirm = createConfirmHandler({ db, store, logger: quietLogger })
  const rejected = new TestResponse()
  await confirm(request({ sessionId, content, confirm: false }), rejected)
  assert.equal(rejected.statusCode, 400)
  assert.equal(db.queries.length, 0)
  const wrongUser = new TestResponse()
  await confirm(request({ sessionId, content, confirm: true }, 8), wrongUser)
  assert.equal(wrongUser.statusCode, 404)
  const altered = new TestResponse()
  await confirm(request({ sessionId, content: '未经校验的内容', confirm: true }), altered)
  assert.equal(altered.statusCode, 400)
  const first = new TestResponse(); const second = new TestResponse()
  await Promise.all([confirm(request({ sessionId, content, confirm: true }), first), confirm(request({ sessionId, content, confirm: true }), second)])
  assert.equal(first.statusCode, 200); assert.equal(second.statusCode, 200)
  assert.equal(db.rows.length, 1)
  assert.equal(first.body.reportId, second.body.reportId)
  assert.equal(db.rows[0].user_id, 7)
  assert.match(db.rows[0].content, /无法确认/)
  const retry = new TestResponse()
  await confirm(request({ sessionId, content, confirm: true }), retry)
  assert.equal(retry.body.alreadySaved, true)
})

test('generation abort discards late output and never writes or exposes a confirmable draft', async () => {
  const store = createDraftStore()
  const draft = store.create(7, input)
  const db = createMemoryDb()
  let started
  const ready = new Promise(resolve => { started = resolve })
  const response = new TestResponse()
  const pending = createWeeklyHandler({ db, store, logger: quietLogger, stream: async () => { started(); return new Promise(() => {}) } })(request({ sessionId: draft.id }), response)
  await ready
  response.emit('close')
  await pending
  assert.equal(draft.state, 'prepared')
  assert.equal(db.rows.length, 0)
  assert.equal(response.output.includes('"type":"result"'), false)
})

test('a failed factual check falls back to original facts without another model call or write', async () => {
  const store = createDraftStore()
  const draft = store.create(7, input, [question])
  const db = createMemoryDb()
  const response = new TestResponse()
  let calls = 0
  await createWeeklyHandler({ db, store, logger: quietLogger, stream: async ({ res, onComplete }) => {
    calls++
    await onComplete('权限模块已完成，提高效率80%。')
    res.write('data: [DONE]\n\n'); res.end()
  } })(request({ sessionId: draft.id, skipClarification: true }), response)
  assert.equal(calls, 1)
  assert.equal(draft.state, 'ready')
  assert.equal(draft.content.includes('80%'), false)
  assert.match(draft.content, /无法确认/)
  assert.equal(db.rows.length, 0)
  assert.equal(response.events().find(event => event.type === 'result').result.factCheckFallback, true)
})

test('clarification and plan tasks safely time out through the shared runtime', async () => {
  for (const run of [runClarificationAgent, runPlanAgent]) {
    await assert.rejects(run({ db: createMemoryDb(), input, userId: 7, signal: signal(),
      complete: async () => new Promise(() => {}), limits: { timeoutMs: 10 } }), { code: 'AGENT_TIMEOUT' })
  }
})

test('shared concurrency prevents a second Agent task from running for the same user', async () => {
  let started
  const ready = new Promise(resolve => { started = resolve })
  const first = new TestResponse()
  const pending = createAgentHandler({ logger: quietLogger, validateInput: body => body, run: async ({ signal }) => {
    started(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })(request({}), first)
  await ready
  const second = new TestResponse()
  await createInsightsHandler({ db: createMemoryDb(records), complete: async () => { throw new Error('must not run') }, logger: quietLogger })(request({}), second)
  assert.equal(second.statusCode, 409)
  first.emit('close'); await pending
})

test('stream proxy preserves split Chinese UTF-8 and requires upstream stop and DONE', async () => {
  const text = '权限模块正在开发。'
  const contentEvent = `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`
  const ending = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  for (const [suffix, valid] of [[ending, true], ['', false], ['data: [DONE]\n\n', false]]) {
    const upstream = new PassThrough()
    const response = new TestResponse()
    let saved = false
    const pending = streamDeepSeekToClient({ messages: [], res: response, signal: signal(),
      createStream: async () => ({ data: upstream }), onComplete: async () => { saved = true } })
    await new Promise(resolve => setImmediate(resolve))
    const wire = valid ? (contentEvent + suffix).replace(/\n/gu, '\r\n') : contentEvent + suffix
    for (const byte of Buffer.from(wire)) upstream.write(Buffer.from([byte]))
    upstream.end()
    if (valid) {
      assert.equal(await pending, text)
      assert.equal(response.events().filter(event => event.type === 'content').map(event => event.content).join(''), text)
    } else await assert.rejects(pending, /未完整结束/)
    assert.equal(saved, valid)
  }
})
