import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import weeklyReportRouter from './routes/weeklyReport.js'
import pool from './db/index.js'
import reportsRouter from './routes/reports.js'
import authRouter from './routes/auth.js'
import aiRouter from './routes/ai.js'


dotenv.config()

const app = express()
const port = Number(process.env.PORT || 3001)

app.use(cors())
app.use(express.json({ limit: '1mb' }))
app.use('/api/auth', authRouter)

app.get('/api/health', (_req, res) => {
  res.json({ code: 0, message: 'ok' })
})

app.use('/api/weekly-report', weeklyReportRouter)
app.use('/api/reports', reportsRouter)
app.use('/api/ai', aiRouter)

app.use((err, _req, res, _next) => {
  console.error(err)
  if (!res.headersSent) {
    res.status(500).json({
      code: 500,
      message: '服务器内部错误'
    })
  }
})

app.listen(port, async () => {
  console.log(`Server running at http://localhost:${port}`)

  try {
    const [rows] = await pool.query('SELECT 1 AS result')
    console.log('MySQL connected:', rows[0].result)
  } catch (error) {
    console.error('MySQL connection failed:', error.message)
  }
})