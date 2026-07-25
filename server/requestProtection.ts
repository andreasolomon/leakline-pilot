import type { Request, RequestHandler } from 'express'

type RateLimitOptions = {
  windowMs: number
  max: number
  key?: (request: Request) => string
}

type RateLimitBucket = { count: number; resetAt: number }

function requestAddress(request: Request) {
  return request.ip || request.socket.remoteAddress || 'unknown'
}

export const securityHeaders: RequestHandler = (_request, response, next) => {
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self'",
  ].join('; '))
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  response.setHeader('Origin-Agent-Cluster', '?1')
  if (process.env.NODE_ENV === 'production') response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  next()
}

function allowedBrowserOrigin(request: Request, origin: string) {
  try {
    const parsed = new URL(origin)
    const configured = process.env.APP_BASE_URL ? new URL(process.env.APP_BASE_URL).origin : ''
    if (configured && parsed.origin === configured) return true
    if (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(parsed.hostname) && parsed.protocol === 'http:') return true
    return !configured && parsed.origin === `${request.protocol}://${request.get('host')}`
  } catch {
    return false
  }
}

export const requireSameOriginMutation: RequestHandler = (request, response, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next()
  if (request.headers['sec-fetch-site'] === 'cross-site') return response.status(403).json({ error: 'Cross-site request blocked.' })
  const origin = request.headers.origin
  if (origin && !allowedBrowserOrigin(request, origin)) return response.status(403).json({ error: 'Cross-site request blocked.' })
  next()
}

export function createRateLimiter({ windowMs, max, key = requestAddress }: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, RateLimitBucket>()
  let requestsSinceCleanup = 0

  return (request, response, next) => {
    const now = Date.now()
    if (++requestsSinceCleanup >= 500) {
      for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketKey)
      requestsSinceCleanup = 0
    }

    const bucketKey = key(request)
    const existing = buckets.get(bucketKey)
    const bucket = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + windowMs } : existing
    bucket.count += 1
    buckets.set(bucketKey, bucket)

    response.setHeader('RateLimit-Limit', String(max))
    response.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)))
    response.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)))

    if (bucket.count > max) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))))
      return response.status(429).json({ error: 'Too many requests. Please wait and try again.' })
    }
    next()
  }
}
