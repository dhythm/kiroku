import handler from '@tanstack/react-start/server-entry'
import { handleApi, type AppEnv } from './server/api'
export default {
  async fetch(request: Request, env: AppEnv) {
    const url = new URL(request.url)
    const response = url.pathname.startsWith('/api/')
      ? await handleApi(request, env)
      : await handler.fetch(request)
    const secured = new Response(response.body, response)
    secured.headers.set('X-Content-Type-Options', 'nosniff')
    if (url.pathname.startsWith('/api/'))
      secured.headers.set('Cache-Control', 'no-store, private')
    secured.headers.set('Referrer-Policy', 'same-origin')
    secured.headers.set('X-Frame-Options', 'DENY')
    secured.headers.set(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()',
    )
    secured.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' " +
        (url.protocol === 'http:' ? 'ws: ' : '') +
        "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    )
    if (url.protocol === 'https:')
      secured.headers.set('Strict-Transport-Security', 'max-age=31536000')
    return secured
  },
}
