import { createDeepSeekStream } from '../services/deepseek.js'

export function setSseHeaders(res) {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
}

function writeEvent(res, payload) {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
}

export async function streamDeepSeekToClient({
  messages,
  res,
  onComplete,
  signal
}) {
  const response = await createDeepSeekStream(messages, signal)

  return new Promise((resolve, reject) => {
    let buffer = ''
    let fullContent = ''
    let settled = false

    const finish = async () => {
      if (settled) return
      settled = true

      try {
        if (onComplete) {
          await onComplete(fullContent)
        }

        if (!res.writableEnded) {
          res.write('data: [DONE]\n\n')
          res.end()
        }

        resolve(fullContent)
      } catch (error) {
        writeEvent(res, {
          type: 'error',
          message: error.message || '数据保存失败'
        })
        if (!res.writableEnded) res.end()
        reject(error)
      }
    }

    response.data.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let boundary = buffer.indexOf('\n\n')

      while (boundary !== -1) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue

          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue

          try {
            const parsed = JSON.parse(data)
            const content = parsed.choices?.[0]?.delta?.content || ''

            if (content) {
              fullContent += content
              writeEvent(res, { type: 'content', content })
            }
          } catch (error) {
            console.error('DeepSeek SSE parse error:', error)
          }
        }

        boundary = buffer.indexOf('\n\n')
      }
    })

    response.data.on('end', finish)

    response.data.on('error', (error) => {
      if (settled) return
      settled = true
      console.error('DeepSeek stream error:', error)
      writeEvent(res, { type: 'error', message: 'AI 流式响应异常' })
      if (!res.writableEnded) res.end()
      reject(error)
    })
  })
}
