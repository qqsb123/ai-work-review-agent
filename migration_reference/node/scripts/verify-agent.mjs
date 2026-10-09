import 'dotenv/config'
import assert from 'node:assert/strict'
import { createDeepSeekCompletion } from '../services/deepseek.js'
import { runInsightsAgent } from '../agents/insightsAgent.js'
import { runClarificationAgent } from '../agents/clarificationAgent.js'
import { runPlanAgent } from '../agents/planAgent.js'
import { createMemoryDb, TestResponse } from '../tests/helpers.js'
import { createDraftStore } from '../services/draftStore.js'
import { createWeeklyHandler } from '../services/weeklyHandlers.js'
import { streamDeepSeekToClient } from '../utils/streamDeepSeek.js'
import { buildRewritePrompt } from '../prompts/weeklyReport.js'

// Live model / synthetic database. Never reads or writes a real user's reports.
const rows = [
  { id: 101, user_id: 1, work_content: '本周完成登录模块开发。', next_plan: '完成权限模块；补充权限测试；修复支付接口；整理部署文档',
    content: '所属周期：2026-09-14 至 2026-09-20。本周完成登录模块开发。下周计划完成权限模块、补充权限测试、修复支付接口、整理部署文档。', created_at: '2026-09-20', updated_at: '2026-09-20' },
  { id: 102, user_id: 1, work_content: '权限模块开发完成并已进入联调。权限测试正在进行中。支付接口因上游问题而阻塞。', next_plan: '',
    content: '所属周期：2026-09-21 至 2026-09-27。权限模块开发完成并已进入联调。权限测试正在进行中。支付接口因上游问题而阻塞。', created_at: '2026-09-27', updated_at: '2026-09-27' }
]
const db = createMemoryDb(rows)
const signals = () => new AbortController().signal
const log = label => ({ stage }) => console.log(`${label}: ${stage}`)
const input = { work: '这周做了权限模块，解决了一些问题。', problems: '', nextPlan: '', style: 'detailed', useHistory: false }
try {
  if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY === 'your_deepseek_api_key') throw new Error('请配置 DEEPSEEK_API_KEY；验收会产生模型调用费用')
  const summary = []
  const adequate = await runClarificationAgent({ db, complete: createDeepSeekCompletion, userId: 1,
    input: { ...input, work: '权限模块本周已完成开发和自测，解决了角色校验缺失问题，当前没有阻塞。', problems: '角色校验缺失已修复。', nextPlan: '下周进行权限模块联调。' }, signal: signals(), onEvent: log('sufficient') })
  assert.equal(adequate.result.questions.length, 0, '信息充分不应强制追问')
  summary.push({ task: 'sufficient-input', verified: true, metrics: adequate.metrics })
  const clarification = await runClarificationAgent({ db, complete: createDeepSeekCompletion, userId: 1, input, signal: signals(), onEvent: log('clarification') })
  assert.ok(clarification.result.questions.length >= 1 && clarification.result.questions.length <= 3)
  summary.push({ task: 'insufficient-input', verified: true, questionCount: clarification.result.questions.length, metrics: clarification.metrics })
  const store = createDraftStore()
  const draft = store.create(1, input, clarification.result.questions, clarification.result.historySources)
  const response = new TestResponse()
  await createWeeklyHandler({ db, store, stream: streamDeepSeekToClient })({ user: { userId: 1 }, body: { sessionId: draft.id, skipClarification: true } }, response)
  assert.equal(draft.state, 'ready', '跳过后应生成可确认的草稿')
  assert.match(draft.content, /无法确认/)
  assert.equal(db.rows.length, 2, '生成不得自动保存')
  summary.push({ task: 'skip-and-stream-draft', verified: true })
  const plans = await runPlanAgent({ db, complete: createDeepSeekCompletion, userId: 1, reportId: 101, signal: signals(), onEvent: log('plans') })
  const expected = ['completed', 'in_progress', 'blocked', 'unconfirmed']
  expected.forEach((status, index) => assert.equal(plans.result.plans.find(plan => plan.planId === `101:${index}`)?.status, status))
  summary.push({ task: 'plan-statuses', verified: true, statuses: plans.result.plans.map(plan => plan.status), metrics: plans.metrics })
  const insights = await runInsightsAgent({ db, complete: createDeepSeekCompletion, userId: 1, signal: signals(), onEvent: log('insights') })
  assert.equal(insights.result.sections.length, 4)
  summary.push({ task: 'phase-1-insights', verified: true, metrics: insights.metrics })
  const rewriteResponse = new TestResponse()
  await streamDeepSeekToClient({ messages: [{ role: 'system', content: '你是严谨的中文周报编辑助手。' },
    { role: 'user', content: buildRewritePrompt({ content: '本周完成登录模块开发并修复角色校验缺失。', mode: 'concise' }) }], res: rewriteResponse, signal: signals() })
  assert.ok(rewriteResponse.output.includes('[DONE]'))
  summary.push({ task: 'rewrite-stream', verified: true })
  assert.equal(db.queries.some(query => !query.sql.trim().startsWith('SELECT')), false)
  console.log(JSON.stringify({ verified: true, tasks: summary }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ verified: false, code: error.code || 'VERIFICATION_FAILED', message: error.message }))
  process.exitCode = 1
}
