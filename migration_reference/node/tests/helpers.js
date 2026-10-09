import { EventEmitter } from 'node:events'

export class TestResponse extends EventEmitter {
  statusCode = 200
  headersSent = false
  writableEnded = false
  output = ''
  headers = {}
  status(code) { this.statusCode = code; return this }
  setHeader(name, value) { this.headers[name] = value }
  flushHeaders() { this.headersSent = true }
  write(text) { this.headersSent = true; this.output += text }
  end() { this.writableEnded = true; this.emit('close') }
  json(body) { this.body = body; this.headersSent = true; this.end(); return this }
  events() { return this.output.split('\n\n').filter(event => event.startsWith('data: ') && !event.includes('[DONE]')).map(event => JSON.parse(event.slice(6))) }
}
export const toolCall = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
export const toolResponse = (...calls) => ({ message: { role: 'assistant', content: null, tool_calls: calls }, finishReason: 'tool_calls', usage: { total_tokens: 100 } })
export const finalResponse = value => ({ message: { role: 'assistant', content: JSON.stringify(value) }, finishReason: 'stop', usage: { total_tokens: 100 } })
export const quietLogger = { info() {} }

export function createMemoryDb(initial = []) {
  const rows = initial.map(row => ({ ...row }))
  const queries = []
  const vectors = new Map()
  return { rows, queries, async execute(sql, args) {
    queries.push({ sql, args })
    if (sql.includes('INSERT INTO report_embeddings')) {
      vectors.set(`${args[0]}:${args[1]}:${args[2]}`, { content_hash: args[3], vector: args[4] })
      return [{ affectedRows: 1 }]
    }
    if (sql.includes('LEFT JOIN report_embeddings')) return [rows.filter(row => row.user_id === args[1]).sort((a,b) => b.id-a.id).slice(0,200)
      .map(row => ({ ...row, ...vectors.get(`${args[1]}:${row.id}:${args[0]}`) }))]
    if (sql.includes('LOWER(content)')) return [rows.filter(row => row.user_id === args[0] && args.slice(1).some(term => row.content.toLowerCase().includes(term)))
      .sort((a,b) => b.id-a.id).slice(0,50)]
    if (sql.startsWith('INSERT INTO reports')) {
      const [userId, work, problems, nextPlan, style, content, requestKey] = args
      let row = rows.find(row => row.user_id === userId && row.request_key === requestKey)
      if (!row) {
        row = { id: rows.reduce((max, row) => Math.max(max, row.id), 0) + 1, user_id: userId,
          work_content: work, problems, next_plan: nextPlan, style, content, request_key: requestKey, created_at: '2026-10-06', updated_at: '2026-10-06' }
        rows.push(row)
      }
      return [{ insertId: row.id }]
    }
    if (sql.includes('request_key = ?')) return [rows.filter(row => row.user_id === args[0] && row.request_key === args[1])]
    if (sql.includes('WHERE id = ? AND user_id = ?')) return [rows.filter(row => row.id === args[0] && row.user_id === args[1])]
    if (sql.includes('LIMIT 2') && !sql.includes('next_plan')) return [rows.filter(row => row.user_id === args[0]).slice(0, 2)]
    if (sql.includes('TRIM(COALESCE(next_plan')) return [rows.filter(row => row.user_id === args[0] && (!args[1] || row.id === args[1]) && row.next_plan?.trim()).sort((a, b) => b.id - a.id).slice(0, 2)]
    if (sql.includes('created_at > ?')) {
      const [userId, after, , reportId, keyword, , , offset] = args
      return [rows.filter(row => row.user_id === userId && (new Date(row.created_at) > new Date(after) || (String(row.created_at) === String(after) && row.id > reportId)) &&
        (!keyword || `${row.content}\n${row.work_content}`.includes(keyword))).sort((a, b) => b.id - a.id).slice(offset, offset + 7)]
    }
    if (sql.includes('LOCATE')) {
      const [userId, keyword, , limit, offset] = args
      return [rows.filter(row => row.user_id === userId && (!keyword || row.content.includes(keyword))).sort((a, b) => b.id - a.id).slice(offset, offset + limit)]
    }
    throw new Error(`Unexpected query in test: ${sql}`)
  } }
}
