export interface AgentTraceEvent {
  type: string; stage: string; runId: string; attempt?: number; seq?: number;
  timestamp?: string; elapsedMs?: number; message?: string; meta?: Record<string, unknown>
}

export interface StreamCallbacks<T = unknown> {
  onContent: (content: string) => void
  onDone: () => void
  onError: (message: string) => void
  onProgress?: (event: { stage: string; message: string }) => void
  onResult?: (result: T) => void
  onTrace?: (event: AgentTraceEvent) => void
  requireResult?: boolean
}

function expireAuth() {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  window.dispatchEvent(new Event('auth-expired'))
}

export async function streamPost<T = unknown>(
  url: string,
  body: unknown,
  callbacks: StreamCallbacks<T>,
  signal: AbortSignal
) {
  let doneCalled = false
  let receivedResult = false
  let receivedDone = false

  const finish = () => {
    if (doneCalled) return
    doneCalled = true
    callbacks.onDone()
  }

  try {
    const agentRequest = ['/api/ai/insights', '/api/ai/plans', '/api/weekly-report/prepare'].includes(url)
    const requestBody = agentRequest ? { requestKey: crypto.randomUUID(), ...(body as object) } : body
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('token') || ''}`
      },
      body: JSON.stringify(requestBody),
      signal
    })

    if (!response.ok || !response.body) {
      let message = '请求失败'
      try {
        const data = await response.json()
        message = data.message || message
      } catch {}

      if (response.status === 401) expireAuth()
      throw new Error(message)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    const processEvent = (event: string) => {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()

        if (data === '[DONE]') {
          if (callbacks.requireResult && !receivedResult) throw new Error('分析未返回完整结果，请重试')
          receivedDone = true
          finish()
          return true
        }

        if (!data) continue

        const parsed = JSON.parse(data)
        if (parsed.runId && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
          window.dispatchEvent(new CustomEvent('agent-event', { detail: parsed }))
        }
        if (parsed.type === 'content') {
          callbacks.onContent(parsed.content || '')
        } else if (parsed.type === 'error') {
          throw new Error(parsed.message || 'AI 服务异常')
        } else if (parsed.type === 'progress') {
          callbacks.onProgress?.({ stage: parsed.stage, message: parsed.message })
        } else if (parsed.type === 'result') {
          receivedResult = true
          callbacks.onResult?.(parsed.result as T)
          if (parsed.result?.runId && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
            window.dispatchEvent(new CustomEvent('agent-event', { detail: { type: 'trace', stage: 'result_received', runId: parsed.result.runId } }))
          }
        } else if (parsed.type === 'trace') {
          callbacks.onTrace?.(parsed as AgentTraceEvent)
        }
      }
      return false
    }

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')

      while (boundary !== -1) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (processEvent(event)) return
        boundary = buffer.indexOf('\n\n')
      }
    }

    if (buffer.trim()) processEvent(buffer)
    if (callbacks.requireResult && (!receivedResult || !receivedDone)) {
      throw new Error('分析连接提前结束，请重试')
    }
    finish()
  } catch (error: unknown) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      finish()
      return
    }

    callbacks.onError(error instanceof Error ? error.message : '请求失败')
    finish()
  }
}
