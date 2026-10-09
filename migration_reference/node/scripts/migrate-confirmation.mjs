import pool from '../db/index.js'

// Additive, repeatable migration. Existing rows keep NULL request_key and are untouched.
try {
  const [columns] = await pool.execute("SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reports' AND COLUMN_NAME = 'request_key'")
  if (!columns.length) await pool.execute('ALTER TABLE reports ADD COLUMN request_key VARCHAR(36) NULL')
  else if (columns[0].DATA_TYPE !== 'varchar' || Number(columns[0].CHARACTER_MAXIMUM_LENGTH) !== 36) throw new Error('已有 request_key 类型不兼容，迁移已停止，未改写字段')
  const [indexes] = await pool.execute("SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reports' AND INDEX_NAME = 'idx_reports_user_request_key' ORDER BY SEQ_IN_INDEX")
  if (!indexes.length) await pool.execute('ALTER TABLE reports ADD UNIQUE INDEX idx_reports_user_request_key (user_id, request_key)')
  else if (indexes.some(row => Number(row.NON_UNIQUE) !== 0) || indexes.map(row => row.COLUMN_NAME).join() !== 'user_id,request_key') throw new Error('已有同名索引不兼容，迁移已停止')
  console.log('Confirmation idempotency migration verified; existing records preserved.')
} catch (error) { console.error(error.message); process.exitCode = 1 }
finally { await pool.end() }
