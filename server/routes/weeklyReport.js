import { Router } from 'express'
import { buildWeeklyReportPrompt } from '../prompts/weeklyReport.js'
import pool from '../db/index.js'
import authMiddleware from '../middleware/auth.js'
import { setSseHeaders, streamDeepSeekToClient } from '../utils/streamDeepSeek.js'
import { aiRateLimit } from '../middleware/aiRateLimit.js'

const router = Router()
const VALID_STYLES = new Set(['concise', 'detailed', 'okr'])

router.post('/', authMiddleware, aiRateLimit, async (req, res) => {
  const { work, problems = '', nextPlan = '', style = 'detailed', useHistory = false } = req.body || {}
  const userId = req.user.userId

  if (!work || !String(work).trim()) {
    return res.status(400).json({ code: 400, message: '本周工作内容不能为空' })
  }

  if (!VALID_STYLES.has(style)) {
    return res.status(400).json({ code: 400, message: '无效的周报风格' })
  }

  if (String(work).length > 6000 || String(problems).length > 4000 || String(nextPlan).length > 4000) {
    return res.status(400).json({ code: 400, message: '输入内容过长，请适当精简后重试' })
  }

  setSseHeaders(res)

  const controller = new AbortController()
  let responseFinished = false

  res.on('close', () => {
    if (!responseFinished && !res.writableEnded) {
      controller.abort()
    }
  })

  try {
    let historyContext = ''

    if (useHistory) {
      const [historyRows] = await pool.execute(
        `SELECT work_content, problems, next_plan, content, created_at
         FROM reports
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 3`,
        [userId]
      )

      historyContext = historyRows
        .reverse()
        .map((item, index) => {
          const content = String(item.content || '').slice(0, 1800)
          return `### 历史周报 ${index + 1}（${new Date(item.created_at).toLocaleDateString('zh-CN')}）\n${content}`
        })
        .join('\n\n')
    }

    const prompt = buildWeeklyReportPrompt({
      work: String(work).trim(),
      problems: String(problems).trim(),
      nextPlan: String(nextPlan).trim(),
      style,
      historyContext
    })

    await streamDeepSeekToClient({
      messages: [
        { role: 'system', content: '你是一个严谨的中文工作周报整理助手。' },
        { role: 'user', content: prompt }
      ],
      res,
      signal: controller.signal,
      onComplete: async (fullContent) => {
        await pool.execute(
          `INSERT INTO reports
           (user_id, work_content, problems, next_plan, style, content)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            userId,
            String(work).trim(),
            String(problems).trim(),
            String(nextPlan).trim(),
            style,
            fullContent
          ]
        )
      }
    })

    responseFinished = true
  } catch (error) {
    responseFinished = true
    console.error('Weekly report error:', error)

    if (!res.headersSent) {
      return res.status(500).json({
        code: 500,
        message: error.response?.data?.error?.message || error.message || 'AI 服务调用失败'
      })
    }

    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message || 'AI 服务调用失败' })}\n\n`)
      res.end()
    }
  }
})

export default router
