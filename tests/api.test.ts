import { readFileSync, readdirSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { handleApi, type AppEnv } from '../src/server/api'
import { createToken, ownerHash } from '../src/lib/security'
let mf: Miniflare
let env: AppEnv
const a = createToken()
const b = createToken()
function request(
  path: string,
  token = a,
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return handleApi(
    new Request('https://kiroku.example' + path, {
      method,
      headers: {
        Cookie: '__Host-kiroku=' + token,
        Origin: 'https://kiroku.example',
        'Content-Type': 'application/json',
        'X-Kiroku-Request': '1',
        'CF-Connecting-IP': token === a ? '192.0.2.1' : '192.0.2.2',
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  )
}
async function create(body = '明日、企画のアイデアを3つ書く。', token = a) {
  const r = await request('/api/notes', token, 'POST', {
    title: '秘密の企画',
    body,
    tags: ['仕事'],
  })
  expect(r.status).toBe(201)
  return ((await r.json()) as { note: { id: string; version: number } }).note
}
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
                  'export default { fetch() { return new Response("test"); } }',
              },
            },
          },
          env: { DB: { type: 'd1', name: 'kiroku-test', id: 'kiroku-test' } },
        },
      },
    ],
  })
  env = {
    DB: (await mf.getD1Database('DB')) as unknown as D1Database,
    AI_ENABLED: 'true',
    FREE_PLAN_CONFIRMED: 'true',
    AI_DAILY_BUDGET: '5000',
    AI_SESSION_DAILY_LIMIT: '3',
    AI: {
      run: vi.fn(async () => ({ response: '・企画のアイデアを3つ書く。' })),
    },
  }
  for (const file of readdirSync('drizzle')
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const text = readFileSync('drizzle/' + file, 'utf8')
    const statements = file.includes('safety')
      ? text
          .split(/;\s*\n\s*\n/)
          .map((v) => v.trim())
          .filter(Boolean)
      : text
          .split('--> statement-breakpoint')
          .map((v) => v.trim())
          .filter(Boolean)
    for (const statement of statements) await env.DB.prepare(statement).run()
  }
})
afterEach(async () => {
  await mf?.dispose()
})
describe('API against workerd + real SQLite/D1', () => {
  it('issues secure cookies and hides owner hashes in CRUD responses', async () => {
    const r = await request('/api/session', 'invalid')
    expect(r.status).toBe(200)
    expect(r.headers.get('set-cookie')).toMatch(
      /__Host-kiroku=.{43}; Path=\/; HttpOnly; SameSite=Strict/,
    )
    const n = await create()
    const detail = await request('/api/notes/' + n.id)
    expect(detail.headers.get('cache-control')).toContain('no-store')
    expect(await detail.text()).not.toContain(await ownerHash(a))
  })
  it('isolates guessed IDs, CRUD, title/body search, tags and AI from other sessions', async () => {
    const n = await create()
    for (const suffix of ['', '?q=企画', '?q=明日', '?tag=仕事'])
      expect(await (await request('/api/notes' + suffix, b)).json()).toEqual({
        notes: [],
      })
    for (const method of ['GET', 'PUT', 'DELETE'])
      expect(
        (
          await request(
            '/api/notes/' + n.id,
            b,
            method,
            method === 'GET'
              ? undefined
              : {
                  title: 'attack',
                  body: '',
                  tags: [],
                  version: 1,
                  owner: await ownerHash(a),
                },
          )
        ).status,
      ).toBe(404)
    expect(
      (await request('/api/notes/' + n.id + '/summarize', b, 'POST', {}))
        .status,
    ).toBe(404)
    expect(env.AI!.run).not.toHaveBeenCalled()
    const result = await request('/api/notes?owner=' + (await ownerHash(a)), b)
    expect(await result.json()).toEqual({ notes: [] })
  })
  it('saves edits, searches literally, detects conflicts and deletes', async () => {
    const n = await create('100% complete_日本語')
    const edit = {
      title: '新しいタイトル',
      body: '100% complete_日本語',
      tags: ['暮らし'],
      version: 1,
    }
    expect((await request('/api/notes/' + n.id, a, 'PUT', edit)).status).toBe(
      200,
    )
    expect((await request('/api/notes/' + n.id, a, 'PUT', edit)).status).toBe(
      409,
    )
    expect(
      (await request('/api/notes/' + n.id, a, 'DELETE', { version: 1 })).status,
    ).toBe(409)
    expect(
      (
        (await (
          await request(
            '/api/notes?q=' +
              encodeURIComponent('% complete_') +
              '&tag=' +
              encodeURIComponent('暮らし'),
          )
        ).json()) as { notes: unknown[] }
      ).notes,
    ).toHaveLength(1)
    expect(
      (await request('/api/notes/' + n.id, a, 'DELETE', { version: 2 })).status,
    ).toBe(200)
    expect((await request('/api/notes/' + n.id)).status).toBe(404)
  })
  it('rejects missing cookies, CSRF, oversized payloads, invalid JSON and disabled AI', async () => {
    expect((await request('/api/notes', '')).status).toBe(401)
    expect(
      (
        await request(
          '/api/notes',
          a,
          'POST',
          {},
          { Origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403)
    expect(
      (await request('/api/notes', a, 'POST', {}, { 'X-Kiroku-Request': '' }))
        .status,
    ).toBe(403)
    expect(
      (
        await request('/api/notes', a, 'POST', {
          title: 'a',
          body: 'a'.repeat(8001),
          tags: [],
        })
      ).status,
    ).toBe(400)
    const n = await create()
    env.AI_ENABLED = 'false'
    expect(
      (await request('/api/notes/' + n.id + '/summarize', a, 'POST', {}))
        .status,
    ).toBe(503)
    expect(env.AI!.run).not.toHaveBeenCalled()
  })
  it('bounds AI inputs and output, and clears stale summaries on body edit', async () => {
    const long = await create('あ'.repeat(3001))
    expect(
      (await request('/api/notes/' + long.id + '/summarize', a, 'POST', {}))
        .status,
    ).toBe(413)
    expect(env.AI!.run).not.toHaveBeenCalled()
    const n = await create()
    const r = await request('/api/notes/' + n.id + '/summarize', a, 'POST', {})
    expect(r.status).toBe(200)
    expect(env.AI!.run).toHaveBeenCalledWith(
      '@cf/meta/llama-3.2-3b-instruct',
      expect.objectContaining({ max_tokens: 256 }),
    )
    const edited = await request('/api/notes/' + n.id, a, 'PUT', {
      title: 'a',
      body: '変更',
      tags: [],
      version: 2,
    })
    expect(
      ((await edited.json()) as { note: { summary: string | null } }).note
        .summary,
    ).toBeNull()
  })
  it('admits only one concurrent AI request across sessions', async () => {
    const na = await create()
    const nb = await create('別のメモ', b)
    let resolve!: (value: unknown) => void
    env.AI!.run = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const first = request('/api/notes/' + na.id + '/summarize', a, 'POST', {})
    await vi.waitFor(() => expect(env.AI!.run).toHaveBeenCalledTimes(1))
    expect(
      (await request('/api/notes/' + nb.id + '/summarize', b, 'POST', {}))
        .status,
    ).toBe(429)
    resolve({ response: '要約' })
    expect((await first).status).toBe(200)
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_requests').first<{
        n: number
      }>())!.n,
    ).toBe(1)
  })
  it('enforces daily session and global reservation budgets atomically, including failures', async () => {
    env.AI_SESSION_DAILY_LIMIT = '2'
    env.AI_DAILY_BUDGET = '2000'
    const n = await create()
    expect(
      (await request('/api/notes/' + n.id + '/summarize', a, 'POST', {}))
        .status,
    ).toBe(200)
    expect(
      (await request('/api/notes/' + n.id + '/summarize', a, 'POST', {}))
        .status,
    ).toBe(200)
    expect(
      (await request('/api/notes/' + n.id + '/summarize', a, 'POST', {}))
        .status,
    ).toBe(429)
    const other = await create('別のメモ', b)
    expect(
      (await request('/api/notes/' + other.id + '/summarize', b, 'POST', {}))
        .status,
    ).toBe(429)
    expect(env.AI!.run).toHaveBeenCalledTimes(2)
  })
  it('blocks cookie-rotation abuse using a daily hashed IP quota', async () => {
    const n = await create()
    for (let i = 0; i < 3; i++)
      expect(
        (await request('/api/notes/' + n.id + '/summarize', a, 'POST', {}))
          .status,
      ).toBe(200)
    const other = await create('a', b)
    expect(
      (
        await request(
          '/api/notes/' + other.id + '/summarize',
          b,
          'POST',
          {},
          { 'CF-Connecting-IP': '192.0.2.1' },
        )
      ).status,
    ).toBe(429)
  })
  it('fails closed and trips a persistent fuse on provider quota errors', async () => {
    const n = await create()
    env.AI!.run = vi.fn(async () => {
      throw new Error('quota')
    })
    expect(
      (await request('/api/notes/' + n.id + '/summarize', a, 'POST', {}))
        .status,
    ).toBe(503)
    expect(
      (await request('/api/notes/' + n.id + '/summarize', a, 'POST', {}))
        .status,
    ).toBe(503)
    expect(env.AI!.run).toHaveBeenCalledTimes(1)
    expect(
      ((await (await request('/api/status')).json()) as { enabled: boolean })
        .enabled,
    ).toBe(false)
    expect(
      (await env.DB.prepare('SELECT SUM(units) AS n FROM ai_requests').first<{
        n: number
      }>())!.n,
    ).toBe(1000)
  })
  it('never calls AI if D1 admission fails', async () => {
    const n = await create()
    await env.DB.prepare('DROP TABLE ai_control').run()
    expect(
      (await request('/api/notes/' + n.id + '/summarize', a, 'POST', {}))
        .status,
    ).toBe(503)
    expect(env.AI!.run).not.toHaveBeenCalled()
  })
  it('keeps the global lock if persisting the provider failure fuse fails', async () => {
    const n = await create()
    const real = env.DB
    env.DB = new Proxy(real, {
      get(target, property) {
        if (property === 'prepare')
          return (query: string) => {
            if (query.startsWith('UPDATE ai_control'))
              throw new Error('D1 unavailable')
            return target.prepare(query)
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    env.AI!.run = vi.fn(async () => {
      throw new Error('provider failure')
    })
    expect(
      (await request('/api/notes/' + n.id + '/summarize', a, 'POST', {}))
        .status,
    ).toBe(503)
    expect(
      (await real
        .prepare('SELECT active FROM ai_requests')
        .first<{ active: number }>())!.active,
    ).toBe(1)
    expect(
      (await request('/api/notes/' + n.id + '/summarize', a, 'POST', {}))
        .status,
    ).toBe(429)
    expect(env.AI!.run).toHaveBeenCalledTimes(1)
  })
  it('retains an unfinished lock across UTC midnight', async () => {
    const n = await create()
    await env.DB.prepare(
      'INSERT INTO ai_requests (id, owner, day, ip, units, session_limit, budget, active, created_at) VALUES (?, ?, ?, ?, 1000, 3, 5000, 1, 0)',
    )
      .bind(crypto.randomUUID(), await ownerHash(b), '2000-01-01', 'old-ip')
      .run()
    expect(
      (await request('/api/notes/' + n.id + '/summarize', a, 'POST', {}))
        .status,
    ).toBe(429)
    expect(env.AI!.run).not.toHaveBeenCalled()
  })
  it.each([{}, { response: '' }, { response: 'x'.repeat(3001) }])(
    'fails closed on malformed AI output %j',
    async (output) => {
      const n = await create()
      env.AI!.run = vi.fn(async () => output)
      expect(
        (await request('/api/notes/' + n.id + '/summarize', a, 'POST', {}))
          .status,
      ).toBe(503)
      expect(
        (await request('/api/notes/' + n.id + '/summarize', a, 'POST', {}))
          .status,
      ).toBe(503)
      expect(env.AI!.run).toHaveBeenCalledTimes(1)
    },
  )
  it('applies session limits even while the global budget has room', async () => {
    env.AI_SESSION_DAILY_LIMIT = '1'
    const na = await create()
    const nb = await create('b', b)
    expect(
      (await request('/api/notes/' + na.id + '/summarize', a, 'POST', {}))
        .status,
    ).toBe(200)
    expect(
      (await request('/api/notes/' + na.id + '/summarize', a, 'POST', {}))
        .status,
    ).toBe(429)
    expect(
      (await request('/api/notes/' + nb.id + '/summarize', b, 'POST', {}))
        .status,
    ).toBe(200)
  })
  it('rejects invalid JSON before writing to D1', async () => {
    const result = await handleApi(
      new Request('https://kiroku.example/api/notes', {
        method: 'POST',
        headers: {
          Cookie: '__Host-kiroku=' + a,
          Origin: 'https://kiroku.example',
          'Content-Type': 'application/json',
          'X-Kiroku-Request': '1',
        },
        body: '{oops',
      }),
      env,
    )
    expect(result.status).toBe(400)
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM notes').first<{
        n: number
      }>())!.n,
    ).toBe(0)
  })
  it('rejects stale AI results after a concurrent edit', async () => {
    const n = await create()
    let resolve!: (value: unknown) => void
    env.AI!.run = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const running = request('/api/notes/' + n.id + '/summarize', a, 'POST', {})
    await vi.waitFor(() => expect(env.AI!.run).toHaveBeenCalled())
    expect(
      (
        await request('/api/notes/' + n.id, a, 'PUT', {
          title: 'a',
          body: 'changed',
          tags: [],
          version: 1,
        })
      ).status,
    ).toBe(200)
    resolve({ response: 'old result' })
    expect((await running).status).toBe(409)
  })
  it('enforces per-session storage bounds in SQLite', async () => {
    const owner = await ownerHash(a)
    const statements = Array.from({ length: 100 }, () =>
      env.DB.prepare(
        'INSERT INTO notes (id, owner, title, body, tags, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, 0)',
      ).bind(crypto.randomUUID(), owner, 'a', '', '[]'),
    )
    await env.DB.batch(statements)
    expect(
      (
        await request('/api/notes', a, 'POST', {
          title: 'overflow',
          body: '',
          tags: [],
        })
      ).status,
    ).toBe(429)
  })
})
