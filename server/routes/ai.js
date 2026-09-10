import { Router } from 'express'
import pool from '../db/index.js'
import authMiddleware from '../middleware/auth.js'
import { buildInsightsPrompt, buildRewritePrompt } from '../prompts/weeklyReport.js'
import { setSseHeaders, streamDeepSeekToClient } from '../utils/streamDeepSeek.js'
import { aiRateLimit } from '../middleware/aiRateLimit.js'

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
    console.error('AI rewrite error:', error)
    if (!res.headersSent) {
      return res.status(500).json({ code: 500, message: error.message || 'AI 重写失败' })
    }
    if (!res.writableEnded) res.end()
  }
})

router.post('/insights', aiRateLimit, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT content, work_content, problems, next_plan, created_at
       FROM reports
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 6`,
      [req.user.userId]
    )

    if (rows.length < 2) {
      return res.status(400).json({ code: 400, message: '至少需要 2 份历史周报才能生成趋势洞察' })
    }

    const historyContext = rows
      .reverse()
      .map((item, index) => {
        const content = String(item.content || '').slice(0, 2200)
        return `### 周报 ${index + 1}（${new Date(item.created_at).toLocaleDateString('zh-CN')}）\n${content}`
      })
      .join('\n\n')

    setSseHeaders(res)
    const controller = new AbortController()
    res.on('close', () => controller.abort())

    await streamDeepSeekToClient({
      messages: [
        { role: 'system', content: '你是一个只基于证据做工作复盘的分析助手。' },
        { role: 'user', content: buildInsightsPrompt(historyContext) }
      ],
      res,
      signal: controller.signal
    })
  } catch (error) {
    console.error('AI insights error:', error)
    if (!res.headersSent) {
      return res.status(500).json({ code: 500, message: error.message || '生成工作洞察失败' })
    }
    if (!res.writableEnded) res.end()
  }
})

export default router
