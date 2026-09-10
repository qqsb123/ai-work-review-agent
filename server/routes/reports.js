import { Router } from 'express'
import pool from '../db/index.js'
import authMiddleware from '../middleware/auth.js'

const router = Router()

router.use(authMiddleware)

// 获取当前用户的历史周报
router.get('/', async (req, res) => {
  try {
    const userId = req.user.userId
    const [rows] = await pool.execute(
      `SELECT id, work_content, problems, next_plan, style, content, created_at, updated_at
       FROM reports
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    )

    res.json({ code: 0, data: rows })
  } catch (error) {
    console.error('获取历史周报失败:', error)
    res.status(500).json({ code: 500, message: '获取历史周报失败' })
  }
})

// 获取当前用户的一条周报
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, work_content, problems, next_plan, style, content, created_at, updated_at
       FROM reports
       WHERE id = ? AND user_id = ?`,
      [req.params.id, req.user.userId]
    )

    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: '周报不存在' })
    }

    res.json({ code: 0, data: rows[0] })
  } catch (error) {
    console.error('获取周报详情失败:', error)
    res.status(500).json({ code: 500, message: '获取周报详情失败' })
  }
})

// 编辑当前用户的周报内容
router.put('/:id', async (req, res) => {
  try {
    const content = String(req.body?.content || '').trim()
    if (!content) {
      return res.status(400).json({ code: 400, message: '周报内容不能为空' })
    }

    const [result] = await pool.execute(
      `UPDATE reports
       SET content = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [content, req.params.id, req.user.userId]
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ code: 404, message: '周报不存在或无权修改' })
    }

    res.json({ code: 0, message: '修改成功' })
  } catch (error) {
    console.error('修改周报失败:', error)
    res.status(500).json({ code: 500, message: '修改周报失败' })
  }
})

// 删除当前用户的周报
router.delete('/:id', async (req, res) => {
  try {
    const [result] = await pool.execute(
      'DELETE FROM reports WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.userId]
    )

    if (result.affectedRows === 0) {
      return res.status(404).json({ code: 404, message: '周报不存在或无权删除' })
    }

    res.json({ code: 0, message: '删除成功' })
  } catch (error) {
    console.error('删除周报失败:', error)
    res.status(500).json({ code: 500, message: '删除周报失败' })
  }
})

export default router
