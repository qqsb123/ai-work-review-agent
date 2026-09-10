import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pool from '../db/index.js'

const router = Router()

// 注册
router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body || {}

    if (!username?.trim() || !password) {
      return res.status(400).json({
        code: 400,
        message: '用户名和密码不能为空'
      })
    }

    const [existingUsers] = await pool.execute(
      'SELECT id FROM users WHERE username = ?',
      [username.trim()]
    )

    if (existingUsers.length > 0) {
      return res.status(409).json({
        code: 409,
        message: '用户名已存在'
      })
    }

    const passwordHash = await bcrypt.hash(password, 10)

    const [result] = await pool.execute(
      `
        INSERT INTO users (username, password_hash)
        VALUES (?, ?)
      `,
      [username.trim(), passwordHash]
    )

    res.status(201).json({
      code: 0,
      data: {
        id: result.insertId,
        username: username.trim()
      }
    })
  } catch (error) {
    console.error('注册失败:', error)

    res.status(500).json({
      code: 500,
      message: '注册失败'
    })
  }
})

// 登录
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {}

    if (!username?.trim() || !password) {
      return res.status(400).json({
        code: 400,
        message: '用户名和密码不能为空'
      })
    }

    const [rows] = await pool.execute(
      `
        SELECT id, username, password_hash
        FROM users
        WHERE username = ?
      `,
      [username.trim()]
    )

    if (rows.length === 0) {
      return res.status(401).json({
        code: 401,
        message: '用户名或密码错误'
      })
    }

    const user = rows[0]

    const passwordMatched = await bcrypt.compare(
      password,
      user.password_hash
    )

    if (!passwordMatched) {
      return res.status(401).json({
        code: 401,
        message: '用户名或密码错误'
      })
    }

    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '7d'
      }
    )

    res.json({
      code: 0,
      data: {
        token,
        user: {
          id: user.id,
          username: user.username
        }
      }
    })
  } catch (error) {
    console.error('登录失败:', error)

    res.status(500).json({
      code: 500,
      message: '登录失败'
    })
  }
})

export default router