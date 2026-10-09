import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const compile = async file => ts.transpileModule(await readFile(new URL(file, import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 } }).outputText
const dataModule = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
const streamModule = dataModule(await compile('../src/api/sse.ts'))
const api = await import(dataModule((await compile('../src/api/weeklyReport.ts')).replace("'./sse'", JSON.stringify(streamModule))))

test('prepare and resume preserve session identity and never send a confirmation implicitly', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.localStorage = { getItem: () => 'test-token' }
  const requests = []
  const sessionId = '11111111-1111-4111-8111-111111111111'
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body), authorization: options.headers.Authorization })
    const result = url.endsWith('/prepare') ? { sessionId, questions: [{ id: 'q1', question: '权限模块目前是什么状态？' }] }
      : { sessionId, content: '权限模块状态待确认。', requiresConfirmation: true }
    return new Response(`data: ${JSON.stringify({ type: 'result', result })}\n\ndata: [DONE]\n\n`)
  }
  let prepared
  await api.prepareWeeklyReport({ work: '做了权限模块', problems: '', nextPlan: '', style: 'detailed', useHistory: false },
    data => { prepared = data }, () => {}, message => assert.fail(message), new AbortController().signal)
  let generated
  await api.generatePreparedReport({ sessionId: prepared.sessionId, answers: [], skipClarification: true }, () => {},
    data => { generated = data }, message => assert.fail(message), new AbortController().signal)
  assert.equal(generated.sessionId, sessionId)
  assert.equal(requests[1].body.skipClarification, true)
  assert.deepEqual(requests.map(request => request.url), ['/api/weekly-report/prepare', '/api/weekly-report'])
  assert.ok(requests.every(request => request.authorization === 'Bearer test-token' && !('userId' in request.body)))
})

test('explicit confirmation reuses the same idempotency identity and content on retry', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.localStorage = { getItem: () => 'test-token' }
  const bodies = []
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/weekly-report/confirm')
    bodies.push(JSON.parse(options.body))
    return new Response(JSON.stringify({ reportId: 1, alreadySaved: bodies.length > 1 }), { headers: { 'Content-Type': 'application/json' } })
  }
  const draft = { sessionId: '11111111-1111-4111-8111-111111111111', content: '同一份确认草稿', requiresConfirmation: true }
  assert.equal((await api.confirmWeeklyReport(draft)).alreadySaved, false)
  assert.equal((await api.confirmWeeklyReport(draft)).alreadySaved, true)
  assert.deepEqual(bodies[0], bodies[1])
  assert.equal(bodies[0].confirm, true)
})
