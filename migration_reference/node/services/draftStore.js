import { randomUUID } from 'node:crypto'
import { AgentError } from '../agents/errors.js'

export function createDraftStore({ ttlMs = 30 * 60 * 1000, now = Date.now, maxEntries = 500 } = {}) {
  const entries = new Map()
  const prune = () => { for (const [id, draft] of entries) if (draft.expiresAt <= now()) entries.delete(id) }
  return {
    create(userId, input, questions = [], historySources = []) {
      prune()
      const owned = [...entries.values()].filter(draft => draft.userId === userId)
      if (owned.length >= 5) {
        const candidate = owned.find(draft => !['generating', 'saving'].includes(draft.state))
        if (!candidate) throw new AgentError('DRAFT_BUSY', '已有过多进行中的草稿')
        entries.delete(candidate.id)
      }
      if (entries.size >= maxEntries) throw new AgentError('DRAFT_CAPACITY', '草稿服务繁忙，请稍后重试')
      const draft = { id: randomUUID(), userId, input: structuredClone(input), questions,
        historySources, state: 'prepared', content: '', expiresAt: now() + ttlMs }
      entries.set(draft.id, draft)
      return draft
    },
    get(id, userId) {
      prune()
      const draft = entries.get(id)
      if (!draft || draft.userId !== userId) throw new AgentError('DRAFT_NOT_FOUND', '草稿不存在、已过期或无权访问，请重新生成')
      return draft
    }
  }
}

export const draftStore = createDraftStore()
