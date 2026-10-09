import { Router } from 'express'
import pool from '../db/index.js'
import authMiddleware from '../middleware/auth.js'
import { buildRewritePrompt } from '../prompts/weeklyReport.js'
import { setSseHeaders, streamDeepSeekToClient } from '../utils/streamDeepSeek.js'
import { aiRateLimit } from '../middleware/aiRateLimit.js'
import { createDeepSeekCompletion } from '../services/deepseek.js'
import { createInsightsHandler } from '../agents/insightsHandler.js'
import { createAgentHandler } from '../agents/agentHandler.js'
import { runPlanAgent } from '../agents/planAgent.js'
import { runStore, persistentDraftStore } from '../services/agentInfrastructure.js'
import { createPrepareHandler } from '../services/weeklyHandlers.js'
import { createAgentRunsRouter } from './agentRuns.js'

const router = Router()
const VALID_REWRITE_MODES = new Set(['professional', 'concise', 'okr'])

router.use(authMiddleware)

router.post('/rewrite/:id', aiRateLimit, async (req, res) => {
  const mode = req.body?.mode || 'professional'

  if (!VALID_REWRITE_MODES.has(mode)) {
    return res.status(400).json({ code: 400, message: '无效的 AI 重写模式' })
  }

  try {
    const [rows] = await pool.execute(
      `SELECT id, content
       FROM reports
       WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.userId]
    )

    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: '周报不存在或无权访问' })
    }

    const sourceContent = String(req.body?.content || rows[0].content || '').trim()
    if (!sourceContent) {
      return res.status(400).json({ code: 400, message: '周报内容不能为空' })
    }

    if (sourceContent.length > 12000) {
      return res.status(400).json({ code: 400, message: '周报内容过长，暂不支持 AI 重写' })
    }

    setSseHeaders(res)
    const controller = new AbortController()
    res.on('close', () => controller.abort())

    await streamDeepSeekToClient({
      messages: [
        { role: 'system', content: '你是一个严格遵守事实边界的中文周报编辑助手。' },
        { role: 'user', content: buildRewritePrompt({ content: sourceContent, mode }) }
      ],
      res,
      signal: controller.signal
    })
  } catch (error) {
    console.info('AI rewrite failed', { userId: req.user.userId, code: error.code || 'REWRITE_FAILED' })
    if (!res.headersSent) {
      return res.status(500).json({ code: 500, message: 'AI 重写失败，请重试' })
    }
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'AI 重写未完整结束，请重试' })}\n\n`)
      res.end()
    }
  }
})

const insightsHandler = createInsightsHandler({ db: pool, complete: createDeepSeekCompletion, runStore })
const plansHandler = createAgentHandler({ runStore, task: 'plans',
  validateInput(body) {
    if (body.reportId !== undefined && (!Number.isSafeInteger(body.reportId) || body.reportId < 1)) throw new Error('计划来源 ID 必须是正整数')
    return { reportId: body.reportId }
  },
  run: ({ userId, input, signal, onEvent }) => runPlanAgent({ db: pool, complete: createDeepSeekCompletion, userId, reportId: input.reportId, signal, onEvent })
})
router.post('/insights', aiRateLimit, insightsHandler)
router.post('/plans', aiRateLimit, plansHandler)
const retryHandlers = { insights: insightsHandler, plans: plansHandler,
  clarification: createPrepareHandler({ db: pool, complete: createDeepSeekCompletion, store: persistentDraftStore, runStore }) }
router.use(createAgentRunsRouter({ runStore, retryHandlers }))

export default router
