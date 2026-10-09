import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/api/sse.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 } }).outputText
const { streamPost } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
const originalFetch = globalThis.fetch

function mockStream(t, text, { splitBytes = false } = {}) {
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode(text)
    if (splitBytes) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    else controller.enqueue(bytes)
    controller.close()
  } }))
}

function callbacks(requireResult = false) {
  const state = { content: '', done: 0, errors: [], progress: [], results: [] }
  return { state, handlers: {
    onContent: (content) => { state.content += content }, onDone: () => { state.done++ },
    onError: (message) => { state.errors.push(message) },
    onProgress: (event) => { state.progress.push(event) }, onResult: (result) => { state.results.push(result) }, requireResult
  } }
}

test('SSE handles split UTF-8 bytes, progress, result and DONE', async (t) => {
  mockStream(t, ': keepalive\n\ndata: {"type":"progress","stage":"tool","message":"正在读取原文"}\n\ndata: {"type":"result","result":{"sections":[]}}\n\ndata: [DONE]\n\n', { splitBytes: true })
  globalThis.localStorage = { getItem: () => 'test-token' }
  const { state, handlers } = callbacks(true)
  await streamPost('/api/ai/insights', {}, handlers, new AbortController().signal)
  assert.equal(state.progress[0].message, '正在读取原文')
  assert.equal(state.results.length, 1)
  assert.equal(state.done, 1)
  assert.deepEqual(state.errors, [])
})

test('trace events coexist with progress/result/DONE and cannot make a truncated task successful', async (t) => {
  globalThis.localStorage = { getItem: () => 'test-token' }
  const traces=[]
  mockStream(t, 'data: {"type":"trace","stage":"tool_end","runId":"run-test","meta":{"tool":"hybrid_search_reports"}}\n\ndata: {"type":"result","result":{"checked":true}}\n\ndata: [DONE]\n\n', {splitBytes:true})
  const {state,handlers}=callbacks(true)
  await streamPost('/api/ai/insights',{}, {...handlers,onTrace:event=>traces.push(event)},new AbortController().signal)
  assert.equal(traces[0].meta.tool,'hybrid_search_reports')
  assert.equal(state.results.length,1);assert.deepEqual(state.errors,[])
  mockStream(t,'data: {"type":"trace","stage":"validation_passed","runId":"run-test"}\n\n')
  const incomplete=callbacks(true)
  await streamPost('/api/ai/insights',{},incomplete.handlers,new AbortController().signal)
  assert.equal(incomplete.state.errors.length,1)
})

test('insights require both a validated result event and explicit completion', async (t) => {
  globalThis.localStorage = { getItem: () => 'test-token' }
  for (const text of ['data: [DONE]\n\n', 'data: {"type":"result","result":{}}\n\n', '']) {
    mockStream(t, text)
    const { state, handlers } = callbacks(true)
    await streamPost('/api/ai/insights', {}, handlers, new AbortController().signal)
    assert.equal(state.errors.length, 1)
    assert.equal(state.done, 1)
  }
})

test('SSE forwards agent errors once and keeps original content streaming compatible', async (t) => {
  globalThis.localStorage = { getItem: () => 'test-token' }
  mockStream(t, 'data: {"type":"error","message":"证据校验失败"}\n\n')
  const failed = callbacks(true)
  await streamPost('/api/ai/insights', {}, failed.handlers, new AbortController().signal)
  assert.deepEqual(failed.state.errors, ['证据校验失败'])
  assert.equal(failed.state.done, 1)
  mockStream(t, 'data: {"type":"content","content":"原有周报流"}\n\ndata: [DONE]\n\n')
  const original = callbacks()
  await streamPost('/api/weekly-report', {}, original.handlers, new AbortController().signal)
  assert.equal(original.state.content, '原有周报流')
  assert.equal(original.state.done, 1)
  assert.deepEqual(original.state.errors, [])
})

test('user abort completes quietly without reporting a service failure', async (t) => {
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.localStorage = { getItem: () => 'test-token' }
  globalThis.fetch = async () => { throw new DOMException('Stopped', 'AbortError') }
  const { state, handlers } = callbacks(true)
  await streamPost('/api/ai/insights', {}, handlers, new AbortController().signal)
  assert.equal(state.done, 1)
  assert.deepEqual(state.errors, [])
})
