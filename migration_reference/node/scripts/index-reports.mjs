import { createHash } from 'node:crypto'
import pool from '../db/index.js'
import { createEmbeddingProvider } from '../services/embeddings.js'
import { retrievalText } from '../services/hybridRetrieval.js'

// Operator command, not a model tool. Only this explicit owner's recent window
// is indexed; no formal report fields are ever written.
const userId = Number(process.argv.find(a => a.startsWith('--user='))?.split('=')[1])
try {
  if (!Number.isSafeInteger(userId) || userId < 1) throw new Error('请指定 --user=当前用户ID')
  const provider = createEmbeddingProvider()
  if (!provider.enabled) throw new Error('请配置 EMBEDDING_URL 和 EMBEDDING_MODEL')
  const signal = AbortSignal.timeout(180000)
  const [rows] = await pool.execute(`SELECT id, LEFT(content,6000) AS content FROM reports WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 200`, [userId])
  const eligible = rows.filter(row => retrievalText(row).trim())
  let tokens = 0, indexed = 0
  for (let start = 0; start < eligible.length; start += 12) {
    const batch = eligible.slice(start, start + 12)
    const response = await provider.embed(batch.map(retrievalText), signal)
    tokens += response.tokens || 0
    for (let i = 0; i < batch.length; i++) {
      signal.throwIfAborted()
      await pool.execute(`INSERT INTO report_embeddings (user_id,report_id,model_key,content_hash,vector) VALUES (?,?,?,?,?)
        ON DUPLICATE KEY UPDATE content_hash=VALUES(content_hash),vector=VALUES(vector),updated_at=CURRENT_TIMESTAMP(3)`,
      [userId,batch[i].id,provider.modelKey,createHash('sha256').update(retrievalText(batch[i])).digest('hex'),JSON.stringify(response.vectors[i])])
      indexed++
    }
  }
  console.log(JSON.stringify({ indexed, embeddingTokens: tokens, formalReportsModified: false }))
} catch (error) { console.error(error.message?.startsWith('EMBEDDING_') ? error.message : error.code || 'INDEX_CONFIG_OR_PROVIDER_FAILED'); process.exitCode = 1 }
finally { await pool.end() }
