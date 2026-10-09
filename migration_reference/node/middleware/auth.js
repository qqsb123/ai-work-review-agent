import jwt from 'jsonwebtoken'

export default function authMiddleware(req, res, next) {
  const authorization = req.headers.authorization

  if (!authorization) {
    return res.status(401).json({
      code: 401,
      message: '未提供登录凭证'
    })
  }

  const [type, token] = authorization.split(' ')

  if (type !== 'Bearer' || !token) {
    return res.status(401).json({
      code: 401,
      message: '登录凭证格式错误'
    })
  }

  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET
    )

    req.user = payload

    next()
  } catch (error) {
    return res.status(401).json({
      code: 401,
      message: '登录凭证无效或已过期'
    })
  }
}