import { readFile } from 'node:fs/promises'
import pool from '../db/index.js'

try {
  const source = await readFile(new URL('../sql/agent-engineering.sql', import.meta.url), 'utf8')
  const sql = source.replace(/^--.*$/gm, '')
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await pool.execute(statement)
  // IF NOT EXISTS alone cannot prove an existing table has a usable schema.
  const required = {
    report_embeddings: ['user_id','report_id','model_key','content_hash','vector','updated_at'],
    agent_runs: ['run_id','user_id','request_key','task','input_hash','input_json','status','attempt','lease_token','lease_until','checkpoint_json','result_json','error_code','created_at','updated_at'],
    agent_run_events: ['id','run_id','user_id','attempt','event_json','created_at'],
    agent_drafts: ['session_id','user_id','draft_json','expires_at','updated_at']
  }
  for (const [table, names] of Object.entries(required)) {
    const [columns] = await pool.execute('SELECT COLUMN_NAME,DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[table])
    if (names.some(name => !columns.some(column => column.COLUMN_NAME===name))) throw new Error('ENGINEERING_SCHEMA_INCOMPATIBLE')
    for (const column of columns) if (['vector','input_json','checkpoint_json','result_json','event_json','draft_json'].includes(column.COLUMN_NAME) && column.DATA_TYPE !== 'json') throw new Error('ENGINEERING_SCHEMA_INCOMPATIBLE')
  }
  const [indexes] = await pool.execute("SELECT COLUMN_NAME,NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_runs' AND INDEX_NAME='idx_run_request' ORDER BY SEQ_IN_INDEX")
  if(indexes.map(row=>row.COLUMN_NAME).join() !== 'user_id,request_key' || indexes.some(row=>Number(row.NON_UNIQUE)!==0)) throw new Error('ENGINEERING_SCHEMA_INCOMPATIBLE')
  console.log('Agent engineering tables verified; existing business records preserved.')
} catch (error) { console.error('Migration failed:', error.code || 'SCHEMA_ERROR'); process.exitCode = 1 }
finally { await pool.end() }
