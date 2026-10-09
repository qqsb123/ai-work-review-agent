import { AgentError } from './errors.js'
import { createAgentHandler } from './agentHandler.js'
import { runInsightsAgent } from './insightsAgent.js'

export function createInsightsHandler({ db, complete, logger = console, limits, runStore, retrieval }) {
  return createAgentHandler({
    logger, runStore, task: 'insights',
    validateInput(body) {
      const question = body.question ?? ''
      if (typeof question !== 'string' || question.length > 1000) throw new Error('复盘重点必须是长度不超过 1000 字的文字')
      return { question: question.trim() }
    },
    async preflight(userId) {
      const [rows] = await db.execute('SELECT id FROM reports WHERE user_id = ? LIMIT 2', [userId])
      if (rows.length < 2) throw new AgentError('HISTORY_REQUIRED', '至少需要 2 份历史周报才能生成趋势洞察')
    },
    run: ({ userId, input, signal, onEvent }) => runInsightsAgent({ db, complete, userId, question: input.question, signal, onEvent, limits, retrieval })
  })
}
