export interface StreamCallbacks {
  onContent: (content: string) => void
  onDone: () => void
  onError: (message: string) => void
}

function expireAuth() {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  window.dispatchEvent(new Event('auth-expired'))
}

export async function streamPost(
  url: string,
  body: unknown,
  callbacks: StreamCallbacks,
  signal: AbortSignal
) {
  let doneCalled = false

  const finish = () => {
    if (doneCalled) return
    doneCalled = true
    callbacks.onDone()
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('token') || ''}`
      },
      body: JSON.stringify(body),
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
          finish()
          return true
        }

        if (!data) continue

        const parsed = JSON.parse(data)
        if (parsed.type === 'content') {
          callbacks.onContent(parsed.content || '')
        } else if (parsed.type === 'error') {
          throw new Error(parsed.message || 'AI 服务异常')
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
    finish()
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      finish()
      return
    }

    callbacks.onError(error instanceof Error ? error.message : '请求失败')
    finish()
  }
}
