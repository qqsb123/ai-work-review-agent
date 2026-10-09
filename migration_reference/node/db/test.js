import pool from './index.js'

try {
  // 1. 插入用户
  const username = `test_${Date.now()}`
  const passwordHash = 'demo_hash'

  const [result] = await pool.execute(
    'INSERT INTO users (username, password_hash) VALUES (?, ?)',
    [username, passwordHash]
  )

  console.log('用户插入成功，id:', result.insertId)

  // 2. 把刚刚插入的用户查出来
  const [rows] = await pool.execute(
    'SELECT id, username, created_at FROM users WHERE id = ?',
    [result.insertId]
  )

  console.table(rows)
} catch (error) {
  console.error('数据库操作失败:', error.message)
} finally {
  await pool.end()
}