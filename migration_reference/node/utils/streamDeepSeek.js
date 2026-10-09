import { StringDecoder } from 'node:string_decoder'
import { createDeepSeekStream } from '../services/deepseek.js'

export function setSseHeaders(res) {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
}

export async function streamDeepSeekToClient({ messages, res, onComplete, signal, createStream = createDeepSeekStream }) {
  signal.throwIfAborted()
  const response = await createStream(messages, signal)
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    let fullContent = ''
    let settled = false
    let sawDone = false
    let finishReason = null
    let ended = false
    const cleanup = () => signal.removeEventListener('abort', abort)
    const fail = error => {
      if (settled) return
      settled = true
      cleanup()
      response.data.destroy?.()
      reject(error)
    }
    const abort = () => fail(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    const processBuffer = () => {
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue
          const text = line.slice(5).trim()
          if (!text) continue
          if (text === '[DONE]') { sawDone = true; continue }
          const parsed = JSON.parse(text)
          if (parsed.error) throw new Error('上游流式响应异常')
          const choice = parsed.choices?.[0]
          if (choice?.finish_reason) finishReason = choice.finish_reason
          const content = choice?.delta?.content || ''
          if (content) {
            fullContent += content
            if (fullContent.length > 24000) throw new Error('生成内容过长')
            if (!res.writableEnded && !signal.aborted) res.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`)
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
    response.data.on('data', chunk => {
      if (settled) return
      try { buffer = (buffer + decoder.write(chunk)).replace(/\r\n/gu, '\n'); processBuffer() }
      catch (error) { fail(error) }
    })
    response.data.on('error', fail)
    response.data.on('close', () => { if (!ended && !settled) fail(new Error('上游连接提前关闭')) })
    response.data.on('end', async () => {
      ended = true
      if (settled) return
      try {
        buffer += decoder.end()
        if (buffer.trim()) { buffer += '\n\n'; processBuffer() }
        signal.throwIfAborted()
        if (!sawDone || finishReason !== 'stop' || !fullContent.trim()) throw new Error('模型流未完整结束，草稿未保存')
        if (onComplete) await onComplete(fullContent)
        signal.throwIfAborted()
        if (settled) return
        settled = true
        cleanup()
        if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
        resolve(fullContent)
      } catch (error) { fail(error) }
    })
  })
}
