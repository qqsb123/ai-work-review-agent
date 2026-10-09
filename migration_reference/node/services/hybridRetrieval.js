import { createHash } from 'node:crypto'
import { createEmbeddingProvider, validateVector } from './embeddings.js'

const hash = text => createHash('sha256').update(text).digest('hex')
export const retrievalText = row => String(row.content || '').slice(0, 6000)
export function cosine(a, b) {
  validateVector(a); validateVector(b)
  if (a.length !== b.length) throw new Error('EMBEDDING_DIMENSIONS_INVALID')
  const dot = a.reduce((sum, n, i) => sum + n * b[i], 0)
  return dot / Math.hypot(...a) / Math.hypot(...b)
}
export function queryTerms(query) {
  const terms = query.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]+/gu) || []
  return [...new Set([query.toLowerCase().trim(), ...terms.flatMap(term => /\p{Script=Han}/u.test(term) && term.length > 4
    ? Array.from({ length: term.length - 1 }, (_, i) => term.slice(i, i + 2)) : [term])])].filter(Boolean).slice(0, 12)
}
export function fuseRanks(keyword, semantic, limit = 6) {
  const scores = new Map()
  for (const [channel, entries] of [['keyword', keyword], ['semantic', semantic]]) entries.forEach((entry, i) => {
    const hit = scores.get(entry.id) || { ...entry, score: 0, channels: [] }
    hit.score += 1 / (60 + i + 1); hit.channels.push(channel); scores.set(entry.id, hit)
  })
  return [...scores.values()].sort((a, b) => b.score - a.score || a.id - b.id).slice(0, limit)
}
const parseVector = value => typeof value === 'string' ? JSON.parse(value) : value

export function createHybridRetrieval(db, provider = createEmbeddingProvider()) {
  return {
    async search({ query, limit = 6 }, context) {
      const { userId, signal } = context
      signal.throwIfAborted()
      const terms = queryTerms(query)
      // Keyword recall is not restricted to the recent semantic window.
      const [keywordRows] = await db.execute(`SELECT id, LEFT(content, 6000) AS content, created_at, updated_at FROM reports
        WHERE user_id = ? AND (${terms.map(() => 'LOCATE(?, LOWER(content)) > 0').join(' OR ') || 'FALSE'})
        ORDER BY created_at DESC, id DESC LIMIT 50`, [userId, ...terms])
      const [recent] = await db.execute(`SELECT r.id, LEFT(r.content, 6000) AS content, r.created_at, r.updated_at,
        e.content_hash, e.vector FROM reports r LEFT JOIN report_embeddings e
        ON e.user_id = r.user_id AND e.report_id = r.id AND e.model_key = ?
        WHERE r.user_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 200`, [provider.modelKey, userId])
      signal.throwIfAborted()
      const keyword = keywordRows.map(row => ({ ...row, id: Number(row.id), lexical: terms.reduce((score, term) => score + (retrievalText(row).toLowerCase().includes(term) ? term.length : 0), 0) }))
        .sort((a, b) => b.lexical - a.lexical || Number(b.id) - Number(a.id)).filter(r => r.lexical > 0)
      let semantic = [], indexed = 0, tokens = 0, degraded = provider.enabled ? null : 'EMBEDDING_NOT_CONFIGURED'
      if (provider.enabled) {
        let reserved = 0
        try {
          // A per-run cap prevents the model multiplying paid embedding batches.
          const budget = context.retrievalState ??= { documents: 0, pendingTokens: 0 }
          const candidates = recent.filter(row => retrievalText(row).trim() && (!row.vector || row.content_hash !== hash(retrievalText(row))))
            .slice(0, Math.max(0, 12 - budget.documents))
          const missing = []
          for (const row of candidates) {
            const nextReserve = Buffer.byteLength(JSON.stringify([query, ...missing.map(retrievalText), retrievalText(row)]), 'utf8')
            if (budget.remainingTokens === undefined || nextReserve <= budget.remainingTokens) missing.push(row)
          }
          const reserve = Buffer.byteLength(JSON.stringify([query, ...missing.map(retrievalText)]), 'utf8')
          if (budget.remainingTokens !== undefined && reserve > budget.remainingTokens) throw new Error('EMBEDDING_BUDGET_LIMIT')
          budget.documents += missing.length
          reserved = reserve
          budget.pendingTokens += reserve
          if (budget.remainingTokens !== undefined) budget.remainingTokens -= reserve
          const response = await provider.embed([query, ...missing.map(retrievalText)], signal)
          tokens = response.tokens
          if (tokens === null) budget.usageEstimated = true
          budget.pendingTokens += (tokens ?? reserve) - reserve
          if (budget.remainingTokens !== undefined) budget.remainingTokens -= (tokens ?? reserve) - reserve
          reserved = 0
          const [queryVector, ...vectors] = response.vectors
          for (let i = 0; i < missing.length; i++) {
            signal.throwIfAborted()
            const row = missing[i], vector = vectors[i]
            await db.execute(`INSERT INTO report_embeddings (user_id, report_id, model_key, content_hash, vector)
              VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE content_hash = VALUES(content_hash), vector = VALUES(vector), updated_at = CURRENT_TIMESTAMP(3)`,
            [userId, row.id, provider.modelKey, hash(retrievalText(row)), JSON.stringify(vector)])
            row.vector = vector; row.content_hash = hash(retrievalText(row))
          }
          semantic = recent.filter(row => row.vector && row.content_hash === hash(retrievalText(row))).flatMap(row => {
            try { return [{ ...row, id: Number(row.id), similarity: cosine(queryVector, parseVector(row.vector)) }] }
            catch { return [] } // Invalid or old dimension entries are never used.
          }).sort((a, b) => b.similarity - a.similarity || a.id - b.id)
          indexed = semantic.length
          semantic = semantic.filter(row => row.similarity > 0).slice(0, 30)
        } catch (error) {
          if (reserved) context.retrievalState.usageEstimated = true
          signal.throwIfAborted()
          degraded = error.message === 'EMBEDDING_BUDGET_LIMIT' ? 'EMBEDDING_BUDGET_LIMIT' : 'EMBEDDING_UNAVAILABLE'
        }
      }
      signal.throwIfAborted()
      return {
        reports: fuseRanks(keyword, semantic, limit).map(row => ({ id: row.id, createdAt: row.created_at, updatedAt: row.updated_at,
          summary: retrievalText(row).slice(0, 300), score: Number(row.score.toFixed(6)), channels: row.channels })),
        retrieval: { mode: degraded ? 'keyword' : 'hybrid', fusion: 'RRF(k=60)', degraded,
          semanticWindow: recent.length, indexed, embeddingTokens: tokens, keywordWindow: keywordRows.length,
          limitation: '语义范围最多最近200份记录；在线每次运行最多补索引12份；关键词最多50份候选。候选不是证据，必须read_report。' },
        untrusted: true
      }
    }
  }
}
