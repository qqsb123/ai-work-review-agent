import { createHash } from 'node:crypto'

export function validateVector(vector) {
  if (!Array.isArray(vector) || !vector.length || vector.length > 8192 ||
      vector.some(n => typeof n !== 'number' || !Number.isFinite(n)) || !vector.some(n => n !== 0)) {
    throw new Error('EMBEDDING_VECTOR_INVALID')
  }
  return vector
}

// OpenAI-compatible embedding protocol; completely separate from DeepSeek Chat.
// No credentials or source text are included in errors/traces.
export function createEmbeddingProvider({ url = process.env.EMBEDDING_URL, key = process.env.EMBEDDING_API_KEY,
  model = process.env.EMBEDDING_MODEL, fetchImpl = fetch } = {}) {
  const enabled = Boolean(url && model)
  if (enabled) {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('EMBEDDING_CONFIG_INVALID')
  }
  return {
    enabled,
    modelKey: createHash('sha256').update(`${url || ''}:${model || ''}`).digest('hex'),
    async embed(texts, signal) {
      if (!enabled) throw new Error('EMBEDDING_NOT_CONFIGURED')
      if (!texts.length || texts.length > 24 || texts.some(t => typeof t !== 'string' || !t.trim() || t.length > 6000)) throw new Error('EMBEDDING_INPUT_INVALID')
      signal.throwIfAborted()
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model, input: texts }), signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) })
      if (!response.ok) throw new Error('EMBEDDING_PROVIDER_FAILED')
      const body = await response.json()
      if (!Array.isArray(body.data) || body.data.length !== texts.length) throw new Error('EMBEDDING_RESPONSE_INVALID')
      const sorted = [...body.data].sort((a, b) => a.index - b.index)
      const vectors = sorted.map((entry, i) => {
        if (entry.index !== i) throw new Error('EMBEDDING_RESPONSE_INVALID')
        return validateVector(entry.embedding)
      })
      if (vectors.some(v => v.length !== vectors[0].length)) throw new Error('EMBEDDING_DIMENSIONS_INVALID')
      return { vectors, tokens: Number.isSafeInteger(body.usage?.total_tokens) ? body.usage.total_tokens : null }
    }
  }
}
