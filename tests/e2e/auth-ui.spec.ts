import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
// UI-only account fixtures. OAuth verification is exercised by auth.test.ts;
// these fixtures are never compiled into the app or a deployed Worker.
test('account controls, pending import, logout and private-data clearing', async ({
  page,
}, testInfo) => {
  let loggedIn = true
  const note = {
    id: '11111111-1111-4111-8111-111111111111',
    title: '端末を越えて、つづきを書く',
    body: 'PCで考えたアイデアを、スマホからも読み返す。\n日々の記録を、同じアカウントで。',
    tags: ['アイデア', '日々'],
    summary: null,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await page.route('**/api/login-status', (r) =>
    r.fulfill({ json: { googleEnabled: true } }),
  )
  await page.route('**/api/session', (r) =>
    r.fulfill({
      json: {
        user: loggedIn
          ? { id: 'test-A', name: 'テストユーザー', email: 'demo@example.test' }
          : null,
        googleEnabled: true,
        pending: loggedIn ? 1 : 0,
      },
    }),
  )
  await page.route('**/api/import', (r) =>
    r.fulfill({ json: { moved: 0, pending: loggedIn ? 1 : 0 } }),
  )
  await page.route('**/api/notes**', (r) =>
    r.fulfill({ json: { notes: loggedIn ? [note] : [] } }),
  )
  await page.route('**/api/status', (r) =>
    r.fulfill({
      json: {
        enabled: false,
        reason: 'AIは未設定のため無効です。',
        maxChars: 3000,
      },
    }),
  )
  await page.route('**/api/pending**', (r) =>
    r.fulfill({
      json: {
        notes: [
          {
            id: 'test-pending',
            title: '大切な引き継ぎ待ち',
            body: '上限を超えても消さずに保管しています。',
          },
        ],
        total: 1,
      },
    }),
  )
  await page.route('**/api/logout', (r) => {
    loggedIn = false
    return r.fulfill({ json: { ok: true } })
  })
  await page.goto('/')
  await expect(page.getByText('テストユーザー', { exact: true })).toBeVisible()
  await expect(
    page.getByText('引き継ぎ待ちのメモが1件あります。', { exact: false }),
  ).toBeVisible()
  await page.getByRole('button', { name: '待機メモを見る' }).click()
  await expect(page.getByRole('dialog')).toContainText('大切な引き継ぎ待ち')
  await page.getByRole('button', { name: '閉じる', exact: true }).click()
  await page.getByRole('heading', { name: note.title }).click()
  mkdirSync('screenshots', { recursive: true })
  await page.screenshot({
    path: `screenshots/${testInfo.project.name}-google-account.png`,
    fullPage: true,
  })
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Googleでログイン' }),
  ).toBeEnabled()
  await expect(page.getByRole('heading', { name: note.title })).toHaveCount(0)
})
test('unconfigured Google login is explicit', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '新しいメモ' })).toBeEnabled()
  await expect(
    page.getByRole('button', { name: 'Googleでログイン' }),
  ).toBeDisabled()
  await expect(page.getByText('未設定', { exact: true })).toBeVisible()
})
test('temporary session-check failure retains the draft behind a privacy screen', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '新しいメモ' }).click()
  await page
    .getByLabel('タイトル', { exact: true })
    .fill('通信復帰まで保持する入力')
  await page.getByLabel('本文', { exact: true }).fill('未保存の大切な本文')
  await page.route('**/api/session', (r) => r.abort('failed'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(
    page.getByRole('heading', { name: 'ログイン状態を確認できません' }),
  ).toBeVisible()
  await expect(page.getByLabel('本文', { exact: true })).toHaveCount(0)
  await page.unroute('**/api/session')
  await page.getByRole('button', { name: '接続を再確認' }).click()
  await expect(page.getByLabel('本文', { exact: true })).toHaveValue(
    '未保存の大切な本文',
  )
})
test('late pending-note responses cannot reveal the previous account after invalidation', async ({
  page,
}) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/status', (r) =>
    r.fulfill({
      json: { enabled: false, reason: 'AIは未設定です。', maxChars: 3000 },
    }),
  )
  await page.route('**/api/login-status', (r) =>
    r.fulfill({ json: { googleEnabled: true } }),
  )
  await page.route('**/api/session', (r) =>
    r.fulfill({
      json: {
        user: { id: 'test-A', name: 'テスト', email: 'demo@example.test' },
        googleEnabled: true,
        pending: 1,
      },
    }),
  )
  await page.route('**/api/import', (r) =>
    r.fulfill({ json: { moved: 0, pending: 1 } }),
  )
  await page.route('**/api/notes**', (r) => r.fulfill({ json: { notes: [] } }))
  await page.route('**/api/pending**', async (r) => {
    await held
    return r.fulfill({
      json: {
        notes: [
          { id: 'private', title: '旧アカウントの待機メモ', body: '秘密' },
        ],
        total: 1,
      },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '待機メモを見る' }).click()
  await page.evaluate(() =>
    window.dispatchEvent(new Event('kiroku-session-invalid')),
  )
  const completed = page.waitForResponse((r) =>
    r.url().includes('/api/pending'),
  )
  release()
  await (await completed).finished()
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  )
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('旧アカウントの待機メモ')).toHaveCount(0)
})
test('late save responses cannot restore private data after session invalidation', async ({
  page,
}) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/notes', async (r) => {
    if (r.request().method() === 'POST') {
      await held
      return r.fulfill({
        json: {
          note: {
            id: '11111111-1111-4111-8111-111111111111',
            title: '旧アカウントの内容',
            body: '秘密',
            tags: [],
            summary: null,
            version: 1,
            createdAt: 0,
            updatedAt: 0,
          },
        },
      })
    }
    return r.continue()
  })
  await page.goto('/')
  await page.getByRole('button', { name: '新しいメモ' }).click()
  await page.getByLabel('タイトル', { exact: true }).fill('旧アカウントの内容')
  await page.getByRole('button', { name: 'メモを保存' }).click()
  await expect(page.getByText('保存中', { exact: true })).toBeVisible()
  await page.evaluate(() =>
    window.dispatchEvent(new Event('kiroku-session-invalid')),
  )
  const completed = page.waitForResponse(
    (r) => r.url().endsWith('/api/notes') && r.request().method() === 'POST',
  )
  release()
  await (await completed).finished()
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  )
  await expect(page.getByLabel('タイトル', { exact: true })).toHaveCount(0)
  await expect(
    page.getByRole('heading', { name: '旧アカウントの内容' }),
  ).toHaveCount(0)
})
