import assert from 'node:assert/strict'
import pool from '../db/index.js'
import { createReportTools } from '../agents/reportTools.js'
import { createPlanToolDefinitions } from '../agents/planTools.js'
import { createConfirmationTool } from '../tools/confirmReport.js'
import { createDraftStore } from '../services/draftStore.js'

let connection
try {
  connection = await pool.getConnection()
  const db = { execute: (sql, args) => connection.execute(sql, args) }
  const context = { userId: 0, signal: new AbortController().signal, sources: new Map(), plans: new Map(), planSources: new Map(), planSearches: new Map() }
  const call = (name, args) => ({ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  const tools = createReportTools(db, createPlanToolDefinitions(db))
  await tools.execute(call('search_reports', { limit: 2 }), context)
  await tools.execute(call('get_recent_plans', {}), context)
  context.plans.set('0:0', { planId: '0:0', reportId: 0, createdAt: '2000-01-01' })
  await tools.execute(call('find_plan_evidence', { planId: '0:0' }), context)
  // A connection-local temporary table shadows the name used by the write tool.
  // Its name is never shared across connections; the real reports table is not written.
  await connection.execute(`CREATE TEMPORARY TABLE reports (
    id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT, user_id BIGINT UNSIGNED NOT NULL,
    work_content TEXT, problems TEXT, next_plan TEXT, style VARCHAR(16), content MEDIUMTEXT,
    request_key VARCHAR(36), UNIQUE KEY idx_reports_user_request_key (user_id, request_key))`)
  const store = createDraftStore()
  const draft = store.create(0, { work: '合成测试', problems: '', nextPlan: '', style: 'detailed', useHistory: false })
  draft.content = '合成测试草稿'; draft.state = 'ready'
  const confirm = createConfirmationTool(db, store)
  const result = await confirm.execute(call('confirm_report', { sessionId: draft.id, content: draft.content }), { ...context, confirmed: true })
  // Simulate loss of the in-memory saved state after a response was lost.
  draft.state = 'ready'
  const retried = await confirm.execute(call('confirm_report', { sessionId: draft.id, content: draft.content }), { ...context, confirmed: true })
  const [count] = await connection.execute('SELECT COUNT(*) AS count FROM reports')
  assert.equal(Number(count[0].count), 1)
  assert.equal(result.reportId, retried.reportId)
  console.log(JSON.stringify({ verified: true, realQueries: ['search_reports', 'get_recent_plans', 'find_plan_evidence'], temporaryConfirmationRows: 1, realUserDataWritten: false }))
} catch (error) { console.error(JSON.stringify({ verified: false, code: error.code, message: error.message })); process.exitCode = 1 }
finally {
  if (connection) { connection.destroy() }
  await pool.end()
}
