import { randomUUID, createHash } from 'node:crypto'
import { AgentError } from '../agents/errors.js'

export const jsonValue = value => typeof value === 'string' ? JSON.parse(value) : value
const conflict = (code, message) => new AgentError(code, message)
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)

// The DB unique key and CAS lease protect across processes; the existing local
// per-user lock additionally prevents competing live tasks in this process.
export function createAgentRunStore(db) {
  return {
    async begin({ userId, task, input, requestKey = randomUUID(), retry = false }) {
      if (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(requestKey)) throw conflict('RUN_INPUT', '请求标识无效')
      const runId = randomUUID(), leaseToken = randomUUID()
      const inputHash = createHash('sha256').update(`${task}:${canonical(input)}`).digest('hex')
      await db.execute(`INSERT INTO agent_runs (run_id,user_id,request_key,task,input_hash,input_json)
        VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE run_id = run_id`, [runId, userId, requestKey, task, inputHash, JSON.stringify(input)])
      const [rows] = await db.execute('SELECT * FROM agent_runs WHERE user_id = ? AND request_key = ?', [userId, requestKey])
      const row = rows[0]
      if (!row || row.task !== task || row.input_hash !== inputHash) throw conflict('RUN_CONFLICT', '该请求标识已用于不同输入')
      if (row.status === 'succeeded') return { runId: row.run_id, replay: jsonValue(row.result_json), userId }
      const [claim] = await db.execute(`UPDATE agent_runs SET status='running', attempt=attempt+1, lease_token=?,
        lease_until=DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 240 SECOND), error_code=NULL
        WHERE run_id=? AND user_id=? AND attempt < 3 AND
        (status='pending' OR (?=1 AND (status IN ('failed','aborted','timed_out','validation_error')
          OR (status='running' AND lease_until < CURRENT_TIMESTAMP(3)))))`, [leaseToken, row.run_id, userId, retry ? 1 : 0])
      if (claim.affectedRows !== 1) throw conflict('RUN_CONFLICT', '任务正在执行、已达三次尝试上限，或需要显式重试')
      return { runId: row.run_id, userId, requestKey, leaseToken, attempt: Number(row.attempt) + 1, seq: 0 }
    },
    async record(run, event, checkpoint) {
      // Serialize with the handler awaiting each event, including progress.
      const publicEvent = { ...event, runId: run.runId, attempt: run.attempt, seq: ++run.seq, timestamp: new Date().toISOString() }
      const [write] = await db.execute(`INSERT INTO agent_run_events (run_id,user_id,attempt,event_json)
        SELECT run_id,user_id,attempt,? FROM agent_runs WHERE run_id=? AND user_id=? AND lease_token=? AND status='running'`,
      [JSON.stringify(publicEvent), run.runId, run.userId, run.leaseToken])
      if (write.affectedRows !== 1) throw conflict('RUN_LEASE_LOST', '任务执行权已失效')
      if (checkpoint) await db.execute(`UPDATE agent_runs SET checkpoint_json=? WHERE run_id=? AND user_id=? AND lease_token=? AND status='running'`,
        [JSON.stringify(checkpoint), run.runId, run.userId, run.leaseToken])
      return publicEvent
    },
    async finish(run, status, result, errorCode = null) {
      const [write] = await db.execute(`UPDATE agent_runs SET status=?,result_json=?,error_code=?,lease_until=NULL
        WHERE run_id=? AND user_id=? AND lease_token=? AND status='running'`,
      [status, result ? JSON.stringify(result) : null, errorCode, run.runId, run.userId, run.leaseToken])
      if (write.affectedRows !== 1) throw conflict('RUN_LEASE_LOST', '任务执行权已失效')
    },
    async get(runId, userId) {
      const [rows] = await db.execute('SELECT * FROM agent_runs WHERE run_id=? AND user_id=?', [runId, userId])
      if (!rows.length) throw conflict('RUN_NOT_FOUND', '任务不存在或无权查看')
      const row = rows[0]
      const [events] = await db.execute('SELECT event_json FROM agent_run_events WHERE run_id=? AND user_id=? ORDER BY id LIMIT 1000', [runId, userId])
      return { runId: row.run_id, requestKey: row.request_key, task: row.task, status: row.status,
        attempt: row.attempt, leaseUntil: row.lease_until, input: jsonValue(row.input_json),
        checkpoint: jsonValue(row.checkpoint_json), result: jsonValue(row.result_json), errorCode: row.error_code,
        createdAt: row.created_at, events: events.map(e => jsonValue(e.event_json)) }
    },
    async list(userId) {
      const [rows] = await db.execute(`SELECT run_id AS runId,task,status,attempt,created_at AS createdAt,lease_until AS leaseUntil
        FROM agent_runs WHERE user_id=? ORDER BY created_at DESC LIMIT 30`, [userId])
      return rows
    }
  }
}
