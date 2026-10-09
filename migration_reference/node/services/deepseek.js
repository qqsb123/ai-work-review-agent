import axios from 'axios'

const client = axios.create({
  baseURL: 'https://api.deepseek.com',
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json'
  }
})

export async function createDeepSeekStream(messages, signal) {
  const apiKey = process.env.DEEPSEEK_API_KEY

  if (!apiKey) {
    throw new Error('未配置 DEEPSEEK_API_KEY')
  }

  return client.post(
    '/chat/completions',
    {
      model: process.env.DEEPSEEK_REPORT_MODEL || 'deepseek-chat',
      messages,
      stream: true,
      max_tokens: 4000,
      temperature: 0.7
    },
    {
      responseType: 'stream',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      signal
    }
  )
}

// Agent reasoning rounds use complete messages so tool_calls are never parsed
// from partial deltas. Existing generation/rewrite streaming remains separate.
export async function createDeepSeekCompletion({ messages, tools, maxTokens, signal }) {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('未配置 DEEPSEEK_API_KEY')
  const response = await client.post('/chat/completions', {
    model: process.env.DEEPSEEK_AGENT_MODEL || 'deepseek-flash',
    messages, tools, tool_choice: 'auto', stream: false,
    thinking: { type: 'disabled' }, temperature: 0.2, max_tokens: maxTokens
  }, { headers: { Authorization: `Bearer ${apiKey}` }, signal })
  const choice = response.data.choices?.[0]
  return { message: choice?.message, finishReason: choice?.finish_reason, usage: response.data.usage }
}
