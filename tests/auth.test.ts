import { readFileSync, readdirSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { handleApi, type AppEnv } from '../src/server/api'
import { accountOwner, createAuth } from '../src/server/auth'
import { createToken, ownerHash } from '../src/lib/security'
let mf: Miniflare
let env: AppEnv
let keys: Awaited<ReturnType<typeof generateKeyPair>>
let jwk: Awaited<ReturnType<typeof exportJWK>>
const origin = 'https://kiroku.example'
// Public TEST fixtures; never production credentials.
const testSecret = 'test-only-kiroku-7ec0bf2f4a23475696efc07a184429e7'
let googleSubject = 'google-A'
let googleEmail = 'alice@example.test'
let tokenFailure = false
let invalidAudience = false
let jwtFault: 'none' | 'signature' | 'issuer' | 'expired' = 'none'
let flowNumber = 0
const realFetch = globalThis.fetch
beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true })
  jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: 'kiroku-test',
    alg: 'RS256',
    use: 'sig',
  }
})
beforeEach(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          name: 'test',
          compatibilityDate: '2026-10-11',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents:
                  'export default { fetch() { return new Response("test") } }',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'auth-test', name: 'auth-test' } },
        },
      },
    ],
  })
  env = {
    DB: (await mf.getD1Database('DB')) as unknown as D1Database,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: testSecret,
    GOOGLE_CLIENT_ID: 'kiroku-test-client',
    GOOGLE_CLIENT_SECRET: 'test-only-client-secret',
    AI_ENABLED: 'true',
    FREE_PLAN_CONFIRMED: 'true',
    AI_DAILY_BUDGET: '5000',
    AI_SESSION_DAILY_LIMIT: '1',
    AI: { run: vi.fn(async () => ({ response: 'test summary' })) },
  }
  for (const file of readdirSync('drizzle')
    .filter((f) => f.endsWith('.sql'))
    .sort())
    for (const statement of readFileSync('drizzle/' + file, 'utf8')
      .split(
        file.includes('safety') ? /;\s*\n\s*\n/ : '--> statement-breakpoint',
      )
      .map((s) => s.trim())
      .filter(Boolean))
      await env.DB.prepare(statement).run()
  googleSubject = 'google-A'
  googleEmail = 'alice@example.test'
  tokenFailure = false
  invalidAudience = false
  jwtFault = 'none'
  flowNumber = 0
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === 'https://www.googleapis.com/oauth2/v3/certs')
        return Response.json({ keys: [jwk] })
      if (url === 'https://oauth2.googleapis.com/token') {
        if (tokenFailure)
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        let idToken = await new SignJWT({
          sub: googleSubject,
          email: googleEmail,
          email_verified: true,
          name: googleSubject === 'google-A' ? 'Alice' : 'Bob',
          ...(invalidAudience ? { aud: 'wrong-client' } : {}),
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'kiroku-test' })
          .setIssuer(
            jwtFault === 'issuer'
              ? 'https://evil.example'
              : 'https://accounts.google.com',
          )
          .setAudience(invalidAudience ? 'wrong-client' : 'kiroku-test-client')
          .setIssuedAt()
          .setExpirationTime(
            jwtFault === 'expired' ? Math.floor(Date.now() / 1000) - 60 : '1h',
          )
          .sign(keys.privateKey)
        if (jwtFault === 'signature') {
          const parts = idToken.split('.')
          parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1)
          idToken = parts.join('.')
        }
        return Response.json({
          access_token: 'test-only-access',
          refresh_token: 'test-only-refresh',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 3600,
        })
      }
      return realFetch(input, init)
    },
  )
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await mf.dispose()
})
function call(
  path: string,
  cookie = '',
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return handleApi(
    new Request(origin + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Kiroku-Request': '1',
        'CF-Connecting-IP': '192.0.2.1',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  )
}
function cookiePairs(response: Response) {
  return response.headers
    .getSetCookie()
    .filter((c) => !c.includes('Max-Age=0'))
    .map((c) => c.split(';')[0])
    .join('; ')
}
async function start(cookie = '') {
  const response = await call(
    '/api/auth/sign-in/social',
    cookie,
    'POST',
    {
      provider: 'google',
    },
    { 'CF-Connecting-IP': '192.0.2.' + (++flowNumber + 10) },
  )
  expect(response.status).toBe(200)
  const { url } = (await response.json()) as { url: string }
  return { url: new URL(url), cookie: cookiePairs(response), response }
}
async function finish(
  flow: Awaited<ReturnType<typeof start>>,
  extraCookie = '',
) {
  const response = await call(
    '/api/auth/callback/google?code=test-code&state=' +
      encodeURIComponent(flow.url.searchParams.get('state')!),
    [flow.cookie, extraCookie].filter(Boolean).join('; '),
    'GET',
    undefined,
    { 'Sec-Fetch-Site': 'cross-site', Origin: origin },
  )
  expect(response.status).toBe(302)
  expect(new URL(response.headers.get('location')!, origin).href).toBe(
    origin + '/',
  )
  return {
    cookie: [cookiePairs(response), extraCookie].filter(Boolean).join('; '),
    response,
  }
}
async function login(
  subject = 'google-A',
  email = 'alice@example.test',
  anonymous = '',
) {
  googleSubject = subject
  googleEmail = email
  return finish(await start(anonymous), anonymous)
}
async function note(cookie: string, title = 'account note') {
  const response = await call('/api/notes', cookie, 'POST', {
    title,
    body: '本文検索用',
    tags: ['仕事'],
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { note: { id: string; version: number } })
    .note
}
describe('real Better Auth + D1, mocked Google token/JWKS only', () => {
  it('recovers only aged, unassociated users after partial signup failure', async () => {
    const flow = await start()
    const real = env.DB
    env.DB = new Proxy(real, {
      get(target, property) {
        if (property === 'prepare')
          return (query: string) => {
            if (/insert into ["`]auth_account/i.test(query))
              throw new Error('test partial signup failure')
            return target.prepare(query)
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const failed = await call(
      '/api/auth/callback/google?code=test-code&state=' +
        flow.url.searchParams.get('state'),
      flow.cookie,
    )
    expect(failed.headers.get('location')).toContain('login=failed')
    expect(
      (await real
        .prepare('SELECT COUNT(*) AS n FROM auth_user')
        .first<{ n: number }>())!.n,
    ).toBe(1)
    expect(
      (await real
        .prepare('SELECT COUNT(*) AS n FROM auth_account')
        .first<{ n: number }>())!.n,
    ).toBe(0)
    env.DB = real
    await real
      .prepare('UPDATE auth_user SET created_at = ?')
      .bind(Date.now() - 120001)
      .run()
    const recovered = await login()
    expect((await call('/api/session', recovered.cookie)).status).toBe(200)
    expect(
      (await real
        .prepare('SELECT COUNT(*) AS n FROM auth_user')
        .first<{ n: number }>())!.n,
    ).toBe(1)
    expect(
      (await real
        .prepare('SELECT COUNT(*) AS n FROM auth_account')
        .first<{ n: number }>())!.n,
    ).toBe(1)
  })
  it('never removes a user with preserved data to recover a matching email', async () => {
    const now = Date.now() - 120001
    const id = 'test-orphan-with-data'
    await env.DB.prepare(
      "INSERT INTO auth_user (id,name,email,email_verified,created_at,updated_at) VALUES (?, 'preserved', 'alice@example.test', 1, ?, ?)",
    )
      .bind(id, now, now)
      .run()
    await env.DB.prepare(
      "INSERT INTO notes (id,owner,title,body,tags,version,created_at,updated_at) VALUES (?,?,'preserve','original','[]',1,0,0)",
    )
      .bind(crypto.randomUUID(), accountOwner(id))
      .run()
    const flow = await start()
    const rejected = await call(
      '/api/auth/callback/google?code=test-code&state=' +
        flow.url.searchParams.get('state'),
      flow.cookie,
    )
    expect(rejected.headers.get('location')).toContain('login=failed')
    expect(
      (await env.DB.prepare('SELECT id FROM auth_user').first<{
        id: string
      }>())!.id,
    ).toBe(id)
    expect(
      (await env.DB.prepare('SELECT body FROM notes').first<{
        body: string
      }>())!.body,
    ).toBe('original')
  })
  it('rejects retired-owner reservations even after an earlier app-level ownership check', async () => {
    const token = createToken()
    const anon = '__Host-kiroku=' + token
    await note(anon)
    const account = await login()
    await call('/api/import', account.cookie + '; ' + anon, 'POST', {})
    await expect(
      env.DB.prepare(
        'INSERT INTO ai_requests (id,owner,day,ip,units,session_limit,budget,active,created_at) VALUES (?,?,?, ?,1000,1,5000,1,0)',
      )
        .bind(
          crypto.randomUUID(),
          await ownerHash(token),
          new Date().toISOString().slice(0, 10),
          'retired-test-ip',
        )
        .run(),
    ).rejects.toThrow('OWNER_RETIRED')
  })
  it('leaves anonymous mode available with incomplete auth configuration', async () => {
    env.GOOGLE_CLIENT_SECRET = undefined
    expect(await (await call('/api/login-status')).json()).toEqual({
      googleEnabled: false,
    })
    expect(
      (
        await call('/api/auth/sign-in/social', '', 'POST', {
          provider: 'google',
        })
      ).status,
    ).toBe(503)
    const anonymous = await call('/api/session')
    expect(anonymous.status).toBe(200)
    await note(cookiePairs(anonymous))
  })
  it('uses only minimal scopes, state cookie and S256 PKCE; creates Host session cookies', async () => {
    expect(createAuth(env).options.account?.accountLinking?.enabled).toBe(false)
    const flow = await start()
    expect(new Set(flow.url.searchParams.get('scope')!.split(' '))).toEqual(
      new Set(['openid', 'email', 'profile']),
    )
    expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(flow.url.searchParams.get('code_challenge')).toHaveLength(43)
    expect(flow.url.searchParams.get('redirect_uri')).toBe(
      origin + '/api/auth/callback/google',
    )
    expect(flow.response.headers.getSetCookie().join()).toContain(
      '__Host-kiroku-auth.state=',
    )
    const session = await finish(flow)
    expect(session.response.headers.getSetCookie().join()).toContain(
      '__Host-kiroku-auth.session_token=',
    )
    expect(session.response.headers.getSetCookie().join()).toContain('Secure')
    const stored = await env.DB.prepare(
      'SELECT access_token, refresh_token, id_token FROM auth_account',
    ).first()
    expect(stored).toEqual({
      access_token: null,
      refresh_token: null,
      id_token: null,
    })
  })
  it('isolates accounts across CRUD/search/tags/AI and shares one account across devices', async () => {
    const a = await login()
    const b = await login('google-B', 'bob@example.test')
    const n = await note(a.cookie)
    for (const suffix of ['', '?q=本文', '?tag=仕事'])
      expect(
        await (await call('/api/notes' + suffix, b.cookie)).json(),
      ).toEqual({ notes: [] })
    for (const method of ['GET', 'PUT', 'DELETE'])
      expect(
        (
          await call(
            '/api/notes/' + n.id,
            b.cookie,
            method,
            method === 'GET'
              ? undefined
              : {
                  title: 'attack',
                  body: '',
                  tags: [],
                  version: 1,
                  owner: 'fake',
                  email: 'alice@example.test',
                },
          )
        ).status,
      ).toBe(404)
    expect(
      (await call('/api/notes/' + n.id + '/summarize', b.cookie, 'POST', {}))
        .status,
    ).toBe(404)
    const otherDevice = await login()
    expect((await call('/api/notes/' + n.id, otherDevice.cookie)).status).toBe(
      200,
    )
  })
  it('imports existing anonymous IDs and AI usage once, retires old bearer credentials', async () => {
    const token = createToken()
    expect(await ownerHash(token)).toHaveLength(64)
    const anon = '__Host-kiroku=' + token
    const n = await note(anon)
    expect(
      (await call('/api/notes/' + n.id + '/summarize', anon, 'POST', {}))
        .status,
    ).toBe(200)
    const account = await login('google-A', 'alice@example.test', anon)
    expect((await call('/api/import', account.cookie, 'POST', {})).status).toBe(
      200,
    )
    expect((await call('/api/notes/' + n.id, account.cookie)).status).toBe(200)
    expect(
      (
        await call(
          '/api/notes/' + n.id + '/summarize',
          account.cookie,
          'POST',
          {},
        )
      ).status,
    ).toBe(429)
    expect((await call('/api/notes', anon)).status).toBe(401)
    expect((await call('/api/import', account.cookie, 'POST', {})).status).toBe(
      200,
    )
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first<{
        n: number
      }>())!.n,
    ).toBe(1)
    const b = await login('google-B', 'bob@example.test', anon)
    await call('/api/import', b.cookie, 'POST', {})
    expect(await (await call('/api/notes', b.cookie)).json()).toEqual({
      notes: [],
    })
  })
  it('preserves overflow in account-owned pending storage and retries from another device', async () => {
    const a = await login()
    const info = (await (await call('/api/session', a.cookie)).json()) as {
      user: { id: string }
    }
    await env.DB.batch(
      Array.from({ length: 100 }, () =>
        env.DB.prepare(
          "INSERT INTO notes (id,owner,title,body,tags,version,created_at,updated_at) VALUES (?,?,'existing','','[]',1,0,0)",
        ).bind(crypto.randomUUID(), accountOwner(info.user.id)),
      ),
    )
    const anon = '__Host-kiroku=' + createToken()
    const n = await note(anon, '引継ぎ待ち')
    const merged = a.cookie + '; ' + anon
    expect(
      await (await call('/api/import', merged, 'POST', {})).json(),
    ).toEqual({ moved: 0, pending: 1 })
    expect((await call('/api/notes', anon)).status).toBe(401)
    const pending = (await (await call('/api/pending', a.cookie)).json()) as {
      notes: { id: string }[]
    }
    expect(pending.notes[0].id).toBe(n.id)
    const other = await login()
    const list = (await (await call('/api/notes', other.cookie)).json()) as {
      notes: { id: string; version: number }[]
    }
    await call('/api/notes/' + list.notes[0].id, other.cookie, 'DELETE', {
      version: 1,
    })
    expect(
      await (await call('/api/import', other.cookie, 'POST', {})).json(),
    ).toEqual({ moved: 1, pending: 0 })
    expect((await call('/api/notes/' + n.id, other.cookie)).status).toBe(200)
  })
  it('atomically gives a raced anonymous claim to only one account', async () => {
    const anon = '__Host-kiroku=' + createToken()
    const n = await note(anon)
    const a = await login()
    const b = await login('google-B', 'bob@example.test')
    const results = await Promise.all([
      call('/api/import', a.cookie + '; ' + anon, 'POST', {}),
      call('/api/import', b.cookie + '; ' + anon, 'POST', {}),
    ])
    expect(results.map((r) => r.status)).toEqual([200, 200])
    const statuses = await Promise.all([
      call('/api/notes/' + n.id, a.cookie),
      call('/api/notes/' + n.id, b.cookie),
    ])
    expect(statuses.map((r) => r.status).sort()).toEqual([200, 404])
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first<{
        n: number
      }>())!.n,
    ).toBe(1)
  })
  it('rolls back the complete claim/move transaction on D1 failure', async () => {
    const token = createToken()
    const anon = '__Host-kiroku=' + token
    await note(anon)
    const account = await login()
    const real = env.DB
    env.DB = new Proxy(real, {
      get(target, property) {
        if (property === 'batch')
          return (statements: D1PreparedStatement[]) =>
            target.batch([
              ...statements,
              target.prepare('INSERT INTO missing_test_table VALUES (1)'),
            ])
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    expect(
      (await call('/api/import', account.cookie + '; ' + anon, 'POST', {}))
        .status,
    ).toBe(503)
    expect(
      (await real
        .prepare('SELECT COUNT(*) AS n FROM anonymous_claims')
        .first<{ n: number }>())!.n,
    ).toBe(0)
    expect(
      (await real
        .prepare('SELECT owner FROM notes')
        .first<{ owner: string }>())!.owner,
    ).toBe(await ownerHash(token))
    env.DB = real
    expect(
      (await call('/api/import', account.cookie + '; ' + anon, 'POST', {}))
        .status,
    ).toBe(200)
  })
  it('does not confirm logout when the library cannot revoke the database session', async () => {
    const account = await login()
    const n = await note(account.cookie)
    const real = env.DB
    env.DB = new Proxy(real, {
      get(target, property) {
        if (property === 'prepare')
          return (query: string) => {
            if (/delete from ["`]auth_session/i.test(query))
              throw new Error('test D1 revoke failure')
            return target.prepare(query)
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    expect((await call('/api/logout', account.cookie, 'POST', {})).status).toBe(
      503,
    )
    env.DB = real
    expect((await call('/api/notes/' + n.id, account.cookie)).status).toBe(200)
  })
  it('revokes logout, rotates anonymous keys, rejects expiry and forged session cookies', async () => {
    const a = await login()
    const n = await note(a.cookie)
    const logout = await call('/api/logout', a.cookie, 'POST', {})
    expect(logout.status).toBe(200)
    expect((await call('/api/notes/' + n.id, a.cookie)).status).toBe(401)
    expect(
      await (await call('/api/notes', cookiePairs(logout))).json(),
    ).toEqual({ notes: [] })
    const renewed = await login()
    await env.DB.prepare('UPDATE auth_session SET expires_at = 0').run()
    expect((await call('/api/notes', renewed.cookie)).status).toBe(401)
    expect(
      (await call('/api/notes', '__Host-kiroku-auth.session_token=forged'))
        .status,
    ).toBe(401)
    expect((await call('/api/logout', renewed.cookie, 'POST', {})).status).toBe(
      200,
    )
  })
  it('rejects missing/mismatched state cookies, duplicate callback, cancellation and invalid tokens', async () => {
    const flow = await start()
    const state = flow.url.searchParams.get('state')!
    const missing = await call(
      '/api/auth/callback/google?code=test-code&state=' + state,
    )
    expect(missing.headers.get('location')).toContain('login=failed')
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_session').first<{
        n: number
      }>())!.n,
    ).toBe(0)
    const valid = await start()
    const otherState = await start()
    const mismatch = await call(
      '/api/auth/callback/google?code=test-code&state=' +
        otherState.url.searchParams.get('state'),
      valid.cookie,
    )
    expect(mismatch.headers.get('location')).toContain('login=failed')
    await finish(valid)
    const duplicate = await call(
      '/api/auth/callback/google?code=test-code&state=' +
        valid.url.searchParams.get('state'),
      valid.cookie,
    )
    expect(duplicate.headers.get('location')).toContain('login=failed')
    const cancel = await start()
    const cancelled = await call(
      '/api/auth/callback/google?error=access_denied&state=' +
        cancel.url.searchParams.get('state'),
      cancel.cookie,
    )
    expect(cancelled.headers.get('location')).toContain('login=failed')
    invalidAudience = true
    const bad = await start()
    const rejected = await call(
      '/api/auth/callback/google?code=test-code&state=' +
        bad.url.searchParams.get('state'),
      bad.cookie,
    )
    expect(rejected.headers.get('location')).toContain('login=failed')
    invalidAudience = false
    tokenFailure = true
    const failure = await start()
    const failed = await call(
      '/api/auth/callback/google?code=test-code&state=' +
        failure.url.searchParams.get('state'),
      failure.cookie,
    )
    expect(failed.headers.get('location')).toContain('login=failed')
  })
  it.each(['signature', 'issuer', 'expired'] as const)(
    'rejects Google ID tokens with invalid %s',
    async (fault) => {
      jwtFault = fault
      const flow = await start()
      const rejected = await call(
        '/api/auth/callback/google?code=test-code&state=' +
          flow.url.searchParams.get('state'),
        flow.cookie,
      )
      expect(rejected.headers.get('location')).toContain('login=failed')
      expect(
        (await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_session').first<{
          n: number
        }>())!.n,
      ).toBe(0)
      expect(
        (await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_user').first<{
          n: number
        }>())!.n,
      ).toBe(0)
    },
  )
  it('rejects login CSRF, untrusted redirects/scopes/ID-token paths and email-only linking', async () => {
    expect(
      (
        await call(
          '/api/auth/sign-in/social',
          '',
          'POST',
          { provider: 'google' },
          { Origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403)
    for (const body of [
      { provider: 'google', callbackURL: 'https://evil.example' },
      { provider: 'google', scopes: ['https://www.googleapis.com/auth/drive'] },
      { provider: 'google', idToken: { token: 'fake' } },
    ])
      expect(
        (await call('/api/auth/sign-in/social', '', 'POST', body)).status,
      ).toBe(400)
    expect((await call('/api/auth/link-social', '', 'POST', {})).status).toBe(
      404,
    )
    await login()
    googleSubject = 'different-subject-same-email'
    const flow = await start()
    const collision = await call(
      '/api/auth/callback/google?code=test-code&state=' +
        flow.url.searchParams.get('state'),
      flow.cookie,
    )
    expect(collision.headers.get('location')).toContain('login=failed')
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_account').first<{
        n: number
      }>())!.n,
    ).toBe(1)
  })
})
