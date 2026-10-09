import { Router } from 'express'
import authMiddleware from '../middleware/auth.js'
import { aiRateLimit } from '../middleware/aiRateLimit.js'

export function createAgentRunsRouter({ runStore, retryHandlers }) {
  const router = Router()
  router.use(authMiddleware)
  router.get('/runs', async (req, res) => {
    try { res.json({ data: await runStore.list(req.user.userId) }) }
    catch { res.status(503).json({ message: '执行记录暂时不可用，请检查数据库迁移' }) }
  })
  router.get('/runs/:id', async (req, res) => {
    try { res.json(await runStore.get(req.params.id, req.user.userId)) }
    catch (error) { res.status(error.code === 'RUN_NOT_FOUND' ? 404 : 503).json({ message: '任务不存在、无权查看或服务不可用' }) }
  })
  router.post('/runs/:id/retry', aiRateLimit, async (req, res) => {
    try {
      const saved = await runStore.get(req.params.id, req.user.userId)
      const handler = retryHandlers[saved.task]
      if (!handler) return res.status(400).json({ message: '该任务不支持重新执行' })
      req.body = { ...saved.input, requestKey: saved.requestKey, retry: true }
      await handler(req, res)
    } catch (error) {
      if (!res.headersSent) res.status(error.code === 'RUN_NOT_FOUND' ? 404 : 503).json({ message: '任务无法恢复，请稍后重试' })
    }
  })
  return router
}
