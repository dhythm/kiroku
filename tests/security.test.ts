import { describe, expect, it } from 'vitest'
import { aiConfig } from '../src/server/api'
import {
  assertSameOrigin,
  createToken,
  ownerHash,
  readJson,
  sessionCookie,
  validateNote,
} from '../src/lib/security'
describe('security boundaries', () => {
  it('generates a 256-bit cookie, hashes it, and never exposes it to script', async () => {
    const a = createToken()
    const b = createToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
    expect(await ownerHash(a)).toHaveLength(64)
    expect(sessionCookie(a, new URL('https://kiroku.example'))).toContain(
      '__Host-kiroku=',
    )
    expect(sessionCookie(a, new URL('https://kiroku.example'))).toContain(
      'HttpOnly; SameSite=Strict; Max-Age=31536000; Secure',
    )
  })
  it('rejects cross origin, missing custom header and non-JSON mutation', () => {
    const variants: Record<string, string>[] = [
      {
        Origin: 'https://evil.example',
        'X-Kiroku-Request': '1',
        'Content-Type': 'application/json',
      },
      { Origin: 'https://kiroku.example', 'Content-Type': 'application/json' },
      {
        Origin: 'https://kiroku.example',
        'X-Kiroku-Request': '1',
        'Content-Type': 'text/plain',
      },
    ]
    for (const headers of variants)
      expect(() =>
        assertSameOrigin(
          new Request('https://kiroku.example/api/notes', {
            method: 'POST',
            headers,
          }),
        ),
      ).toThrow()
  })
  it('bounds input bytes without trusting Content-Length', async () => {
    await expect(
      readJson(
        new Request('https://kiroku.example', {
          method: 'POST',
          body: JSON.stringify({ body: 'x'.repeat(40001) }),
        }),
      ),
    ).rejects.toThrow('入力が長すぎます')
  })
  it('validates and normalizes note content', () => {
    expect(
      validateNote({ title: ' Idea ', body: '', tags: ['a', ' a '] }).tags,
    ).toEqual(['a'])
    expect(() => validateNote({ title: '', body: 'a', tags: [] })).toThrow()
    expect(() =>
      validateNote({ title: 'a', body: 'a'.repeat(8001), tags: [] }),
    ).toThrow()
    expect(() =>
      validateNote({ title: 'a', body: '', tags: Array(9).fill('a') }),
    ).toThrow()
    expect(() => validateNote({ title: 'a', body: '', tags: [null] })).toThrow()
  })
  it('requires explicit enablement, free-plan acknowledgement, binding and valid capped budgets', () => {
    const env = {
      DB: {} as D1Database,
      AI: { run: async () => ({ response: 'a' }) },
      AI_ENABLED: 'true',
      FREE_PLAN_CONFIRMED: 'true',
      AI_DAILY_BUDGET: '5000',
      AI_SESSION_DAILY_LIMIT: '3',
    }
    expect(aiConfig(env).enabled).toBe(true)
    for (const overrides of [
      { AI: undefined },
      { FREE_PLAN_CONFIRMED: 'false' },
      { AI_ENABLED: 'false' },
      { AI_DAILY_BUDGET: '10000' },
      { AI_SESSION_DAILY_LIMIT: '0' },
    ])
      expect(aiConfig({ ...env, ...overrides }).enabled).toBe(false)
  })
})
