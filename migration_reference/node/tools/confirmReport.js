import { createToolRegistry } from '../agents/toolRegistry.js'
import { AgentError } from '../agents/errors.js'

// This write tool is only reachable from an explicit HTTP confirmation, never
// included in any model's tools array.
export function createConfirmationTool(db, store) {
  return createToolRegistry([{
    name: 'confirm_report', maxArgumentsChars: 100000,
    description: '仅由用户明确确认保存时调用，Agent 不得调用此工具。',
    parameters: { type: 'object', additionalProperties: false, required: ['sessionId', 'content'], properties: {
      sessionId: { type: 'string', maxLength: 36 }, content: { type: 'string', maxLength: 24000 }
    } },
    async execute({ sessionId, content }, { userId, confirmed, signal }) {
      if (confirmed !== true) throw new AgentError('CONFIRMATION_REQUIRED', '必须明确确认后才能保存')
      const draft = await store.get(sessionId, userId)
      if (!['ready', 'saving', 'saved'].includes(draft.state) || !draft.content) throw new AgentError('DRAFT_NOT_READY', '完整草稿尚未生成，不能保存')
      if (!content.trim() || content !== draft.content) throw new AgentError('DRAFT_MISMATCH', '确认内容必须与本次校验后的草稿一致；保存后可在历史中编辑')
      if (draft.state === 'saved') return { reportId: draft.reportId, alreadySaved: true }
      signal.throwIfAborted()
      const input = draft.generationInput || draft.input
      draft.state = 'saving'
      try {
      await db.execute(
        `INSERT INTO reports (user_id, work_content, problems, next_plan, style, content, request_key)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [userId, input.work, input.problems, input.nextPlan, input.style, content, draft.id])
      // Unique (user_id, request_key) is the durable concurrency/idempotency boundary.
      const [rows] = await db.execute('SELECT id, content FROM reports WHERE user_id = ? AND request_key = ?', [userId, draft.id])
      if (!rows.length || rows[0].content !== content) throw new AgentError('CONFIRMATION_CONFLICT', '该保存请求已提交不同内容，请刷新历史')
      draft.state = 'saved'
      draft.reportId = Number(rows[0].id)
      await store.save?.(draft)
      return { reportId: draft.reportId, alreadySaved: false }
      } catch (error) { if (draft.state === 'saving') draft.state = 'ready'; throw error }
    }
  }])
}
