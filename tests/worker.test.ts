import { readFileSync, readdirSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { expect, it } from 'vitest'
it('runs configured Better Auth PKCE and D1 state in the production workerd bundle', async () => {
  const modules: Record<string, { type: 'esm'; contents: string }> = {}
  for (const file of readdirSync('dist/server', { recursive: true }).filter(
    (f) => String(f).endsWith('.js'),
  ))
    modules[String(file)] = {
      type: 'esm',
      contents: readFileSync('dist/server/' + String(file), 'utf8'),
    }
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: 'kiroku-auth-runtime-test',
          compatibilityDate: '2026-10-11',
          compatibilityFlags: ['nodejs_compat'],
          manifest: { mainModule: 'index.js', modules },
          env: {
            DB: {
              type: 'd1',
              id: 'worker-auth-test',
              name: 'worker-auth-test',
            },
            BETTER_AUTH_URL: {
              type: 'text',
              value: 'https://kiroku.example',
            },
            BETTER_AUTH_SECRET: {
              type: 'text',
              value: 'test-only-runtime-a37ecfb7426041c391f08a3c328a1bda',
            },
            GOOGLE_CLIENT_ID: { type: 'text', value: 'test-only-client' },
            GOOGLE_CLIENT_SECRET: {
              type: 'text',
              value: 'test-only-secret',
            },
          },
        },
      },
    ],
  })
  try {
    const db = await mf.getD1Database('DB')
    for (const file of readdirSync('drizzle')
      .filter((f) => f.endsWith('.sql'))
      .sort())
      for (const statement of readFileSync('drizzle/' + file, 'utf8')
        .split(
          file.includes('safety') ? /;\s*\n\s*\n/ : '--> statement-breakpoint',
        )
        .map((s) => s.trim())
        .filter(Boolean))
        await db.prepare(statement).run()
    const response = await mf.dispatchFetch(
      'https://kiroku.example/api/auth/sign-in/social',
      {
        method: 'POST',
        headers: {
          Origin: 'https://kiroku.example',
          'Content-Type': 'application/json',
          'X-Kiroku-Request': '1',
          'CF-Connecting-IP': '192.0.2.1',
        },
        body: '{"provider":"google"}',
      },
    )
    expect(response.status).toBe(200)
    const result = (await response.json()) as { url: string }
    const url = new URL(result.url)
    expect(url.hostname).toBe('accounts.google.com')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(response.headers.get('set-cookie')).toContain(
      '__Host-kiroku-auth.state=',
    )
    expect(
      (await db
        .prepare('SELECT COUNT(*) AS n FROM auth_verification')
        .first<{ n: number }>())!.n,
    ).toBe(1)
    const forged = await mf.dispatchFetch('https://kiroku.example/api/notes', {
      headers: { Cookie: '__Host-kiroku-auth.session_token=forged' },
    })
    expect(forged.status).toBe(401)
    expect(forged.headers.get('cache-control')).toContain('no-store')
  } finally {
    await mf.dispose()
  }
})
