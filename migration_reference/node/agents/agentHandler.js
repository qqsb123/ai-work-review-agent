import { randomUUID } from 'node:crypto'
import { AgentError } from './errors.js'
import { waitForAbort } from './runAgent.js'
import { setSseHeaders } from '../utils/streamDeepSeek.js'

const activeUsers = new Set()
export function acquireUserRun(userId) {
  if (activeUsers.has(userId)) throw new AgentError('AGENT_BUSY', '已有生成或分析正在进行，请先停止或等待完成')
  activeUsers.add(userId)
  return () => activeUsers.delete(userId)
}

// HTTP lifecycle only; reasoning uses the existing runAgent runtime.
export function createAgentHandler({ validateInput, preflight, run, mapResult = result => result, logger = console, runStore, task = 'agent', timeoutMs = 180000 }) {
  return async (req, res) => {
    let input
    let release
    try { input = validateInput(req.body || {}); release = acquireUserRun(req.user.userId) }
    catch (error) { return res.status(error.code === 'AGENT_BUSY' ? 409 : 400).json({ message: error.message }) }
    const userId = req.user.userId
    let runId = randomUUID()
    let persisted
    const controller = new AbortController()
    const close = () => { if (!res.writableEnded) controller.abort() }
    res.on('close', close)
    let heartbeat
    const timer = setTimeout(() => controller.abort(new AgentError('AGENT_TIMEOUT', '任务超时，请重试')), timeoutMs)
    const send = event => {
      if (!controller.signal.aborted && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    const record = async event => {
      const { checkpoint, ...safe } = event
      const publicEvent = runStore && persisted && !persisted.replay
        ? await waitForAbort(runStore.record(persisted, safe, checkpoint), controller.signal)
        : { ...safe, runId, timestamp: new Date().toISOString() }
      send(publicEvent)
    }
    try {
      if (runStore) {
        if (req.body?.retry !== undefined && typeof req.body.retry !== 'boolean') throw new AgentError('RUN_INPUT', 'retry 必须是布尔值')
        persisted = await waitForAbort(runStore.begin({ userId, task, input,
          requestKey: req.body?.requestKey, retry: req.body?.retry === true }), controller.signal)
        runId = persisted.runId
        if (persisted.replay) {
          controller.signal.throwIfAborted()
          setSseHeaders(res); res.flushHeaders?.()
          send({ type: 'progress', stage: 'replayed', message: '已恢复保存的任务结果', runId })
          send({ type: 'result', result: persisted.replay })
          res.write('data: [DONE]\n\n'); res.end()
          return
        }
      }
      if (preflight) await waitForAbort(preflight(userId, input), AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]))
      controller.signal.throwIfAborted()
      setSseHeaders(res)
      res.flushHeaders?.()
      await record({ type: 'progress', stage: 'started', message: '任务已开始' })
      heartbeat = setInterval(() => {
        if (!res.writableEnded && !controller.signal.aborted) res.write(': keepalive\n\n')
      }, 15000)
      const { result, metrics } = await waitForAbort(run({ userId, input, signal: controller.signal, onEvent: record }), controller.signal)
      controller.signal.throwIfAborted()
      const mapped = await waitForAbort(Promise.resolve(mapResult(result, userId, input)), controller.signal)
      const finalResult = { ...mapped, metrics, runId }
      await record({ type: 'trace', stage: 'run_completed', meta: { metrics } })
      if (persisted) await waitForAbort(runStore.finish(persisted, 'succeeded', finalResult), controller.signal)
      controller.signal.throwIfAborted()
      send({ type: 'result', result: finalResult })
      res.write('data: [DONE]\n\n')
      res.end()
      logger.info('Agent completed', { runId, userId, ...metrics })
    } catch (error) {
      const failure = controller.signal.reason instanceof AgentError ? controller.signal.reason
        : error.name === 'TimeoutError' ? new AgentError('AGENT_PREFLIGHT_TIMEOUT', '数据库预检超时，请稍后重试') : error
      const code = controller.signal.aborted && !(controller.signal.reason instanceof AgentError) ? 'CLIENT_ABORTED' : failure.code || 'AGENT_FAILED'
      if (persisted && !persisted.replay) {
        try {
          await waitForAbort((async () => {
            await runStore.record(persisted, { type: 'trace', stage: 'run_stopped', meta: { code } })
            await runStore.finish(persisted, code === 'CLIENT_ABORTED' ? 'aborted' : /TIMEOUT/.test(code) ? 'timed_out' : /EVIDENCE|VALIDATION/.test(code) ? 'validation_error' : 'failed', null, code)
          })(), AbortSignal.timeout(5000))
        } catch { logger.info('Run persistence stopped', { runId, code: 'PERSISTENCE_FAILED' }) }
      }
      logger.info('Agent stopped', { runId, userId, code })
      if (code === 'CLIENT_ABORTED' || res.writableEnded) return
      const message = failure instanceof AgentError ? failure.message : '服务暂时不可用，请稍后重试'
      if (!res.headersSent) return res.status(code === 'HISTORY_REQUIRED' || code === 'RUN_INPUT' ? 400 : code === 'RUN_CONFLICT' ? 409 : 500).json({ message, runId })
      if (!res.destroyed) res.write(`data: ${JSON.stringify({ type: 'error', code, message, runId })}\n\n`)
      res.end()
    } finally {
      clearInterval(heartbeat)
      clearTimeout(timer)
      res.off('close', close)
      release()
    }
  }
}
