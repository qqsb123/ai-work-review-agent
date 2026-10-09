import { Router } from 'express'
import pool from '../db/index.js'
import authMiddleware from '../middleware/auth.js'
import { aiRateLimit } from '../middleware/aiRateLimit.js'
import { createDeepSeekCompletion } from '../services/deepseek.js'
import { streamDeepSeekToClient } from '../utils/streamDeepSeek.js'
import { persistentDraftStore as draftStore, runStore } from '../services/agentInfrastructure.js'
import { createPrepareHandler, createWeeklyHandler, createConfirmHandler } from '../services/weeklyHandlers.js'

const router = Router()
router.use(authMiddleware)
router.post('/prepare', aiRateLimit, createPrepareHandler({ db: pool, complete: createDeepSeekCompletion, store: draftStore, runStore }))
router.post('/confirm', createConfirmHandler({ db: pool, store: draftStore }))
router.post('/', aiRateLimit, createWeeklyHandler({ db: pool, stream: streamDeepSeekToClient, store: draftStore }))
router.get('/drafts/:id', async (req, res) => {
  try {
    const draft = await draftStore.get(req.params.id, req.user.userId)
    res.json({ sessionId: draft.id, input: draft.input, questions: draft.questions, state: draft.state,
      content: draft.content, requiresConfirmation: draft.state === 'ready', expiresAt: draft.expiresAt })
  } catch { res.status(404).json({ message: '草稿不存在、已过期或无权查看' }) }
})
export default router
