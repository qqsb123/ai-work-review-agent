const buckets = new Map()

export function aiRateLimit(req, res, next) {
  const userId = req.user?.userId
  if (!userId) return next()

  const now = Date.now()
  const windowMs = 60 * 1000
  const limit = 12
  const current = buckets.get(userId)

  if (!current || now - current.windowStart >= windowMs) {
    buckets.set(userId, { windowStart: now, count: 1 })
    return next()
  }

  if (current.count >= limit) {
    const retryAfter = Math.ceil((windowMs - (now - current.windowStart)) / 1000)
    res.setHeader('Retry-After', String(retryAfter))
    return res.status(429).json({
      code: 429,
      message: `AI 请求过于频繁，请 ${retryAfter} 秒后重试`
    })
  }

  current.count += 1
  next()
}

setInterval(() => {
  const now = Date.now()
  for (const [key, value] of buckets.entries()) {
    if (now - value.windowStart > 5 * 60 * 1000) buckets.delete(key)
  }
}, 5 * 60 * 1000).unref()
