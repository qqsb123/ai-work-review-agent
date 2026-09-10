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
      model: 'deepseek-chat',
      messages,
      stream: true,
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
