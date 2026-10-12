import { readdirSync, readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { expect, it } from 'vitest'
it('preserves all existing MVP note fields and active AI locks across additive auth migrations', async () => {
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: 'migration-test',
          compatibilityDate: '2026-10-11',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents:
                  'export default {fetch(){return new Response("test")}}',
              },
            },
          },
          env: {
            DB: { type: 'd1', id: 'migration-test', name: 'migration-test' },
          },
        },
      },
    ],
  })
  try {
    const db = await mf.getD1Database('DB')
    const files = readdirSync('drizzle')
      .filter((f) => f.endsWith('.sql'))
      .sort()
    const apply = async (file: string) => {
      for (const statement of readFileSync('drizzle/' + file, 'utf8')
        .split(
          file.includes('safety') ? /;\s*\n\s*\n/ : '--> statement-breakpoint',
        )
        .map((s) => s.trim())
        .filter(Boolean))
        await db.prepare(statement).run()
    }
    for (const file of files.slice(0, 3)) await apply(file)
    await db
      .prepare(
        "INSERT INTO notes (id,owner,title,body,tags,summary,version,created_at,updated_at) VALUES ('legacy','anonymous-hash','元のタイトル','元の本文','[\"タグ\"]','既存の要約',9,10,20)",
      )
      .run()
    await db
      .prepare(
        "INSERT INTO ai_requests (id,owner,day,ip,units,session_limit,budget,active,created_at) VALUES ('unfinished','anonymous-hash','2000-01-01','old-ip',1000,3,5000,1,0)",
      )
      .run()
    const before = await db.prepare('SELECT * FROM notes').first()
    const aiBefore = await db.prepare('SELECT * FROM ai_requests').first()
    for (const file of files.slice(3)) await apply(file)
    expect(await db.prepare('SELECT * FROM notes').first()).toEqual(before)
    expect(await db.prepare('SELECT * FROM ai_requests').first()).toEqual(
      aiBefore,
    )
  } finally {
    await mf.dispose()
  }
})
