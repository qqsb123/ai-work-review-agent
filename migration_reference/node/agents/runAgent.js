import { AgentError, ToolInputError } from './errors.js'
import { argumentSummary, resultSummary } from './trace.js'

export const DEFAULT_AGENT_LIMITS = Object.freeze({
  maxSteps: 8,
  maxToolCalls: 12,
  maxToolCallsPerStep: 6,
  maxOutputTokens: 3000,
  maxTotalTokens: 80000,
  maxContextChars: 50000,
  maxFinalRepairs: 2,
  timeoutMs: 180000
})

export function waitForAbort(promise, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}

// Provider and tools are injected so the actual loop can be tested without an API key or DB.
export async function runAgent({ messages: initialMessages, registry, complete, context,
  validateFinal, signal, onEvent = () => {}, limits: overrides = {} }) {
  const limits = { ...DEFAULT_AGENT_LIMITS, ...overrides }
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  if (signal.aborted) cancel()
  else signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new AgentError('AGENT_TIMEOUT', '分析超时，请缩小范围后重试')), limits.timeoutMs)
  const taskSignal = controller.signal
  const messages = initialMessages.map((message) => ({ ...message }))
  const stats = { steps: 0, toolCalls: 0, totalTokens: 0, usageEstimated: false, repairs: 0 }
  const startedAt = Date.now()
  const seenCallIds = new Set()
  context.retrievalState = { documents: 0, pendingTokens: 0, remainingTokens: 0 }
  const trace = async (stage, meta = {}) => {
    await onEvent({ type: 'trace', stage, meta, elapsedMs: Date.now() - startedAt,
      checkpoint: { boundary: stage, stats: { ...stats }, sourceIds: [...(context.sources?.keys() || [])],
        recovery: 'restart_from_input' } })
    taskSignal.throwIfAborted()
  }

  try {
    await trace('run_started', { budget: limits })
    for (let step = 1; step <= limits.maxSteps; step++) {
      taskSignal.throwIfAborted()
      const serialized = JSON.stringify({ messages, tools: registry.schemas })
      if (serialized.length > limits.maxContextChars) {
        throw new AgentError('AGENT_CONTEXT_LIMIT', '分析上下文达到上限，请缩小范围后重试')
      }
      // UTF-8 byte count conservatively reserves input tokens, including tool schemas.
      const inputReserve = Buffer.byteLength(serialized, 'utf8')
      const remaining = limits.maxTotalTokens - stats.totalTokens - inputReserve
      if (remaining < 256) throw new AgentError('AGENT_TOKEN_LIMIT', '分析用量达到上限，请缩小范围后重试')
      const maxTokens = Math.min(limits.maxOutputTokens, remaining)
      stats.steps = step
      context.retrievalState.remainingTokens = remaining - maxTokens
      await onEvent({ type: 'progress', stage: 'thinking', message: context.progressLabels?.thinking || `正在分析已有证据（第 ${step} 轮）` })
      const roundStarted = Date.now()
      await trace('model_start', { step, maxTokens, contextChars: serialized.length, remainingTokens: remaining })
      const response = await waitForAbort(complete({ messages, tools: registry.schemas,
        maxTokens, signal: taskSignal }), taskSignal)
      taskSignal.throwIfAborted()
      if (Number.isSafeInteger(response.usage?.total_tokens) && response.usage.total_tokens > 0) {
        stats.totalTokens += response.usage.total_tokens
      } else {
        stats.totalTokens += inputReserve + maxTokens
        stats.usageEstimated = true
      }
      if (stats.totalTokens > limits.maxTotalTokens) throw new AgentError('AGENT_TOKEN_LIMIT', '分析用量达到上限')
      const message = response.message
      if (!message || message.role !== 'assistant') throw new AgentError('AGENT_RESPONSE_INVALID', '模型返回了无效响应')
      if (response.finishReason !== 'stop' && response.finishReason !== 'tool_calls') {
        throw new AgentError('AGENT_RESPONSE_INCOMPLETE', '模型响应未完整结束，请重试')
      }
      const calls = message.tool_calls || []
      if (!Array.isArray(calls)) throw new AgentError('AGENT_RESPONSE_INVALID', '模型工具调用格式无效')
      if ((calls.length > 0) !== (response.finishReason === 'tool_calls')) {
        throw new AgentError('AGENT_RESPONSE_INVALID', '模型结束状态与工具调用不一致')
      }
      await trace('model_end', { step, finishReason: response.finishReason, toolCount: calls.length,
        tokens: response.usage?.total_tokens || null, usageEstimated: stats.usageEstimated,
        totalTokens: stats.totalTokens, durationMs: Date.now() - roundStarted })
      if (calls.length) {
        if (calls.length > limits.maxToolCallsPerStep || stats.toolCalls + calls.length > limits.maxToolCalls) {
          throw new AgentError('AGENT_TOOL_LIMIT', '工具调用达到上限，请缩小范围后重试')
        }
        for (const call of calls) {
          if (!call || typeof call.id !== 'string' || !call.id || call.id.length > 200 || seenCallIds.has(call.id)) {
            throw new AgentError('AGENT_RESPONSE_INVALID', '模型工具调用标识无效或重复')
          }
          seenCallIds.add(call.id)
        }
        // Preserve the complete assistant message, including reasoning_content when supplied.
        messages.push(message)
        for (const call of calls) {
          taskSignal.throwIfAborted()
          stats.toolCalls++
          await onEvent({ type: 'progress', stage: 'tool',
            message: registry.getProgress(call.function?.name) })
          const toolStarted = Date.now()
          await trace('tool_start', { step, tool: registry.getSafeName(call.function?.name), callId: call.id,
            arguments: argumentSummary(call) })
          let result
          try {
            result = await waitForAbort(registry.execute(call, { ...context, signal: taskSignal }), taskSignal)
          } catch (error) {
            if (!(error instanceof ToolInputError)) throw error
            result = { error: { code: error.code, message: error.message } }
            await trace('tool_validation_error', { step, code: error.code })
          }
          taskSignal.throwIfAborted()
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
          if (context.retrievalState.pendingTokens) {
            stats.totalTokens += context.retrievalState.pendingTokens
            stats.embeddingTokens = (stats.embeddingTokens || 0) + context.retrievalState.pendingTokens
            if (context.retrievalState.usageEstimated) stats.usageEstimated = true
            context.retrievalState.pendingTokens = 0
            if (stats.totalTokens > limits.maxTotalTokens) throw new AgentError('AGENT_TOKEN_LIMIT', '检索与模型总用量达到上限')
          }
          await trace('tool_end', { step, tool: registry.getSafeName(call.function?.name), callId: call.id,
            result: resultSummary(result), durationMs: Date.now() - toolStarted })
        }
        continue
      }

      await onEvent({ type: 'progress', stage: 'validating', message: '正在核对结论引用的原文证据' })
      const checked = validateFinal(message.content, context)
      if (checked.ok) {
        await trace('validation_passed', { step })
        const metrics = { ...stats, durationMs: Date.now() - startedAt }
        return { result: checked.value, metrics }
      }
      await trace('validation_error', { step, code: 'AGENT_EVIDENCE_INVALID', repairs: stats.repairs })
      if (stats.repairs >= limits.maxFinalRepairs) {
        throw new AgentError('AGENT_EVIDENCE_INVALID', '分析结果未通过证据校验，请重试')
      }
      stats.repairs++
      messages.push(message, { role: 'user', content: `最终结果未通过服务端校验。请根据工具返回的原文修正，必要时继续调用工具。只输出规定 JSON。校验问题：${checked.error}` })
      await onEvent({ type: 'progress', stage: 'repairing', message: '正在修正未通过校验的引用' })
    }
    throw new AgentError('AGENT_STEP_LIMIT', '分析轮次达到上限，未得到可靠结果，请重试')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}
