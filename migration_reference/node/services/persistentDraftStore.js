import { randomUUID } from 'node:crypto'
import { AgentError } from '../agents/errors.js'
import { jsonValue } from './agentRunStore.js'

export function createPersistentDraftStore(db, { ttlMs = 7 * 86400000 } = {}) {
  return {
    async create(userId, input, questions = [], historySources = []) {
      const draft = { id: randomUUID(), userId, input: structuredClone(input), questions, historySources,
        state: 'prepared', content: '', expiresAt: Date.now() + ttlMs }
      await db.execute('INSERT INTO agent_drafts (session_id,user_id,draft_json,expires_at) VALUES (?,?,?,?)',
        [draft.id, userId, JSON.stringify(draft), new Date(draft.expiresAt)])
      return draft
    },
    async get(id, userId) {
      const [rows] = await db.execute(`SELECT draft_json FROM agent_drafts WHERE session_id=? AND user_id=? AND expires_at > CURRENT_TIMESTAMP(3)`, [id, userId])
      if (!rows.length) throw new AgentError('DRAFT_NOT_FOUND', '草稿不存在、已过期或无权访问')
      const draft = jsonValue(rows[0].draft_json)
      if (draft.state === 'generating' && draft.generationStartedAt < Date.now() - 240000) draft.state = 'prepared'
      return draft
    },
    async save(draft) {
      const [result] = await db.execute(`UPDATE agent_drafts SET draft_json=? WHERE session_id=? AND user_id=? AND expires_at > CURRENT_TIMESTAMP(3)
        AND JSON_UNQUOTE(JSON_EXTRACT(draft_json,'$.generationToken')) <=> ?`,
        [JSON.stringify(draft), draft.id, draft.userId, draft.generationToken || null])
      if (result.affectedRows !== 1) throw new AgentError('DRAFT_NOT_FOUND', '草稿已过期或无法保存')
    },
    async claim(draft) {
      const [result] = await db.execute(`UPDATE agent_drafts SET draft_json=? WHERE session_id=? AND user_id=?
        AND (JSON_UNQUOTE(JSON_EXTRACT(draft_json,'$.state'))='prepared' OR
          (JSON_UNQUOTE(JSON_EXTRACT(draft_json,'$.state'))='generating' AND
           CAST(JSON_EXTRACT(draft_json,'$.generationStartedAt') AS UNSIGNED) < ?)) AND expires_at > CURRENT_TIMESTAMP(3)`,
      [JSON.stringify(draft), draft.id, draft.userId, Date.now() - 240000])
      if (result.affectedRows !== 1) throw new AgentError('DRAFT_STATE', '草稿正在生成或已完成')
    }
  }
}
