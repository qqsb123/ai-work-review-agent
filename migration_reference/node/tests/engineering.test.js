import test from 'node:test'
import assert from 'node:assert/strict'
import { createHybridRetrieval, fuseRanks, cosine } from '../services/hybridRetrieval.js'
import { createEmbeddingProvider } from '../services/embeddings.js'
import { createReportTools } from '../agents/reportTools.js'
import { validateInsightsResult } from '../agents/insightsResult.js'
import { createAgentHandler } from '../agents/agentHandler.js'
import { runInsightsAgent } from '../agents/insightsAgent.js'
import { createMemoryDb, toolCall, toolResponse, finalResponse, TestResponse, quietLogger } from './helpers.js'

const records = [
  { id: 1, user_id: 7, content: '登录模块开发完成并通过自测。', created_at: '2026-09-01' },
  { id: 2, user_id: 7, content: '权限模块正在进行联调。', created_at: '2026-09-08' },
  { id: 3, user_id: 8, content: '秘密登录模块已上线。', created_at: '2026-09-10' }
]
const context = () => ({ userId: 7, sources: new Map(), signal: new AbortController().signal })
const vectorProvider = () => ({ enabled: true, modelKey: 'fixture-model', async embed(texts, signal) {
  signal.throwIfAborted()
  return { tokens: 12, vectors: texts.map(text => text.includes('权限') ? [0, 1] : [1, 0]) }
} })

test('hybrid recall fuses keyword and semantic ranks, enforces owner scope, caches vectors, and never creates Evidence', async () => {
  const db = createMemoryDb(records), ctx = context()
  let calls = []
  const provider = vectorProvider(), original = provider.embed
  provider.embed = async (...args) => { calls.push(args[0]); return original(...args) }
  const retrieval = createHybridRetrieval(db, provider)
  const registry = createReportTools(db, [], retrieval)
  const first = await registry.execute(toolCall('hybrid_search_reports', { query: '身份验证', limit: 2 }), ctx)
  assert.equal(first.retrieval.mode, 'hybrid')
  assert.equal(first.reports[0].id, 1, 'synonym query with no keyword overlap is recalled by semantic channel')
  assert.deepEqual(first.reports[0].channels, ['semantic'])
  assert.equal(first.reports.some(row => row.id === 3), false)
  assert.equal(ctx.sources.size, 0)
  const forged = { workstreams: [{ text: '登录有进展', evidence: [{ reportId: 1, quote: records[0].content }] }], continuity: [], recurringProblems: [], suggestions: [] }
  assert.equal(validateInsightsResult(JSON.stringify(forged), ctx).ok, false)
  await registry.execute(toolCall('read_report', { reportId: 1 }), ctx)
  await registry.execute(toolCall('read_report', { reportId: 2 }), ctx)
  const second = await retrieval.search({ query: '登录模块' }, ctx)
  assert.deepEqual(second.reports[0].channels, ['keyword', 'semantic'])
  assert.equal(calls[1].length, 1, 'unchanged documents use cached embeddings')
  db.rows[0].content = '登录模块新增恢复会话能力。'
  await retrieval.search({ query: '登录模块' }, ctx)
  assert.equal(calls[2].length, 2, 'edited content invalidates old vector')
  await assert.rejects(registry.execute(toolCall('hybrid_search_reports', { query: '登录', userId: 8 }), ctx), { code: 'TOOL_INPUT_INVALID' })
  await assert.rejects(registry.execute(toolCall('read_report', { reportId: 3 }), ctx), { code: 'TOOL_INPUT_INVALID' })
})

test('keyword degradation is labelled, malformed vectors rejected, abort cannot silently degrade', async () => {
  const db = createMemoryDb(records)
  const disabled = await createHybridRetrieval(db, { enabled: false, modelKey: 'disabled' }).search({ query: '登录' }, context())
  assert.equal(disabled.retrieval.degraded, 'EMBEDDING_NOT_CONFIGURED')
  const broken = await createHybridRetrieval(db, { enabled: true, modelKey: 'broken', embed: async () => { throw new Error('secret credential') } }).search({ query: '登录' }, context())
  assert.equal(broken.retrieval.degraded, 'EMBEDDING_UNAVAILABLE')
  assert.equal(JSON.stringify(broken).includes('secret credential'), false)
  assert.throws(() => cosine([0,0], [1,0]))
  assert.throws(() => cosine([1], [1,0]))
  const controller = new AbortController()
  const retrieval = createHybridRetrieval(db, { enabled: true, modelKey: 'abort', embed: async () => { controller.abort(); throw new Error('aborted') } })
  await assert.rejects(retrieval.search({ query: '登录' }, { ...context(), signal: controller.signal }), { name: 'AbortError' })
})

test('embedding adapter validates indexed responses and sends only configured server endpoint payload', async () => {
  let payload
  const adapter = createEmbeddingProvider({ url: 'http://localhost:11434/v1/embeddings', model: 'fixture', fetchImpl: async (_url, options) => {
    payload = JSON.parse(options.body)
    return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0,1] }, { index: 0, embedding: [1,0] }], usage: { total_tokens: 3 } }))
  } })
  assert.deepEqual((await adapter.embed(['身份验证','权限'], context().signal)).vectors, [[1,0],[0,1]])
  assert.deepEqual(payload, { model: 'fixture', input: ['身份验证','权限'] })
  const bad = createEmbeddingProvider({ url: 'http://localhost/v1/embeddings', model: 'fixture', fetchImpl: async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [1,0] }, { index: 0, embedding: [1,0] }] })) })
  await assert.rejects(bad.embed(['a','b'], context().signal), /EMBEDDING_RESPONSE_INVALID/)
  assert.equal(fuseRanks([{id:1},{id:2}], [{id:2},{id:3}])[0].id, 2)
})

test('Runtime emits ordered safe trace of RAG/read/validation without reasoning or raw arguments', async () => {
  const db = createMemoryDb(records), trace = []
  const responses = [toolResponse(toolCall('hybrid_search_reports', { query: '身份验证' }, 'rag')),
    { ...toolResponse(toolCall('read_report', { reportId: 1 }, 'read1'), toolCall('read_report', { reportId: 2 }, 'read2')),
      message: { ...toolResponse(toolCall('read_report', { reportId: 1 }, 'read1'), toolCall('read_report', { reportId: 2 }, 'read2')).message,
        reasoning_content: 'PRIVATE_REASONING' } },
    finalResponse({ workstreams: [{ text: '登录和权限模块存在推进记录。', evidence: records.slice(0,2).map(row => ({ reportId: row.id, quote: row.content })) }], continuity: [], recurringProblems: [], suggestions: [] })]
  const result = await runInsightsAgent({ db, retrieval: createHybridRetrieval(db, vectorProvider()), userId: 7,
    complete: async () => responses.shift(), signal: context().signal, onEvent: async event => { trace.push(event) } })
  assert.equal(result.metrics.toolCalls, 3)
  assert.equal(result.metrics.embeddingTokens, 12)
  const ends = trace.filter(e => e.stage === 'tool_end')
  assert.deepEqual(ends.map(e => e.meta.tool), ['hybrid_search_reports','read_report','read_report'])
  assert.equal(trace.at(-1).stage, 'validation_passed')
  const publicTrace = JSON.stringify(trace)
  for (const secret of ['PRIVATE_REASONING','身份验证',records[0].content]) assert.equal(publicTrace.includes(secret), false)
})

function memoryRuns() {
  const rows = new Map()
  return { rows, async begin({ requestKey, input, retry }) {
    const row = rows.get(requestKey)
    if (row?.status === 'succeeded') return { runId: row.runId, replay: row.result }
    if (row && !retry) throw Object.assign(new Error('explicit retry required'), { code: 'RUN_CONFLICT' })
    const run = row || { runId: requestKey, events: [] }
    run.status = 'running'; run.input = input; rows.set(requestKey, run); return run
  }, async record(run, event) { run.events.push(event); return { ...event, runId: run.runId } },
  async finish(run, status, result) { Object.assign(run, { status, result }) } }
}

test('persistent HTTP lifecycle saves before DONE, replays without model calls, and safely reruns failures', async () => {
  const store = memoryRuns(); let calls = 0, fail = false
  const handler = createAgentHandler({ runStore: store, task: 'insights', logger: quietLogger, validateInput: body => ({ question: body.question }),
    run: async ({ onEvent }) => { calls++; await onEvent({ type:'trace',stage:'model_start',meta:{} }); if (fail) throw new Error('private')
      return { result:{ checked:true },metrics:{ steps:1 } } } })
  const req = (key, retry = false) => ({ user:{userId:7}, body:{ question:'test', requestKey:key, retry } })
  const first = new TestResponse(); await handler(req('request_a'), first)
  assert.ok(first.output.endsWith('data: [DONE]\n\n'))
  assert.equal(store.rows.get('request_a').status,'succeeded')
  const replay = new TestResponse(); await handler(req('request_a'), replay)
  assert.equal(calls,1); assert.deepEqual(replay.events().find(e => e.type==='result').result, first.events().find(e => e.type==='result').result)
  fail = true; const failed = new TestResponse(); await handler(req('request_b'),failed)
  assert.equal(store.rows.get('request_b').status,'failed'); assert.equal(failed.output.includes('[DONE]'),false)
  fail = false; const retried = new TestResponse(); await handler(req('request_b',true),retried)
  assert.equal(store.rows.get('request_b').status,'succeeded'); assert.equal(calls,3)
})

test('disconnect records aborted run and publishes neither result nor DONE', async () => {
  const store = memoryRuns(); let started
  const ready = new Promise(resolve => { started = resolve })
  const handler = createAgentHandler({ runStore: store, logger: quietLogger, validateInput: () => ({}),
    run: async ({ signal }) => { started(); return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once:true })) } })
  const response = new TestResponse()
  const pending = handler({user:{userId:7},body:{requestKey:'abort_run'}},response)
  await ready; response.emit('close'); await pending
  assert.equal(store.rows.get('abort_run').status,'aborted')
  assert.equal(response.output.includes('[DONE]'),false)
  assert.equal(response.output.includes('"type":"result"'),false)
})

test('HTTP deadline persists timeout and ends SSE with error rather than leaving an open stream', async () => {
  const store=memoryRuns()
  const handler=createAgentHandler({runStore:store,logger:quietLogger,timeoutMs:10,validateInput:()=>({}),
    run:async()=>new Promise(()=>{})})
  const response=new TestResponse()
  await handler({user:{userId:7},body:{requestKey:'deadline_run'}},response)
  assert.equal(store.rows.get('deadline_run').status,'timed_out')
  assert.equal(response.writableEnded,true)
  assert.equal(response.events().at(-1).code,'AGENT_TIMEOUT')
  assert.equal(response.output.includes('[DONE]'),false)
})
