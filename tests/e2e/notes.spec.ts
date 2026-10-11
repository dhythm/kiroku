import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
test('real Worker UI: CRUD, search, tags, privacy, disabled AI, delete confirmation', async ({
  page,
  browser,
}, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '新しいメモ' })).toBeEnabled()
  await page.getByRole('button', { name: '新しいメモ' }).click()
  await page.getByLabel('タイトル', { exact: true }).fill('朝のアイデア')
  await page
    .getByLabel('本文', { exact: true })
    .fill(
      '散歩で見つけた小さな気づき。\n次の企画は、使いやすさを大切にしたい。',
    )
  await page.getByLabel('タグ（カンマ区切り）').fill('アイデア, 暮らし')
  await expect(page.getByText('未保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'メモを保存' }).click()
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'ワンクリックで要約' }),
  ).toBeDisabled()
  await expect(page.getByText('AIは未設定', { exact: false })).toBeVisible()
  const list = await page.request.get('/api/notes')
  const { notes } = await list.json()
  const id = notes.find((n: { title: string }) => n.title === '朝のアイデア').id
  const other = await browser.newContext()
  await other.request.get('http://127.0.0.1:3000/api/session')
  expect(
    (await other.request.get('http://127.0.0.1:3000/api/notes/' + id)).status(),
  ).toBe(404)
  await other.close()
  mkdirSync('screenshots', { recursive: true })
  await page.screenshot({
    path: `screenshots/${testInfo.project.name}-editor.png`,
    fullPage: true,
  })
  await page.getByRole('button', { name: '一覧へ' }).click()
  await page.getByLabel('メモを検索').fill('小さな気づき')
  await expect(
    page.getByRole('heading', { name: '朝のアイデア' }),
  ).toBeVisible()
  await page.getByLabel('メモを検索').fill('該当なし')
  await expect(page.getByText('メモが見つかりませんでした')).toBeVisible()
  await page.getByLabel('メモを検索').fill('')
  await page.getByRole('heading', { name: '朝のアイデア' }).click()
  await page.getByLabel('本文', { exact: true }).fill('更新した本文')
  await page.getByRole('button', { name: 'メモを保存' }).click()
  await expect(page.getByText('保存済み', { exact: true })).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole('heading', { name: '朝のアイデア' }),
  ).toBeVisible()
  await page.getByRole('heading', { name: '朝のアイデア' }).click()
  await expect(page.getByLabel('本文', { exact: true })).toHaveValue(
    '更新した本文',
  )
  await page.getByRole('button', { name: 'メモを削除' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'キャンセル' }).click()
  await page.getByRole('button', { name: 'メモを削除' }).click()
  await page.getByRole('button', { name: '削除する', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '余白から、はじめよう。' }),
  ).toBeVisible()
})
test('failed save retains unsaved text and UI warns about cookie loss', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '新しいメモ' }).click()
  await page
    .getByLabel('タイトル', { exact: true })
    .fill('保存に失敗しても残る')
  await page.getByLabel('本文', { exact: true }).fill('消えない大事な入力')
  await page.route('**/api/notes', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: '保存に失敗しました。再試行してください。',
          }),
        })
      : route.continue(),
  )
  await page.getByRole('button', { name: 'メモを保存' }).click()
  await expect(page.getByRole('alert')).toContainText('保存に失敗しました')
  await expect(page.getByLabel('本文', { exact: true })).toHaveValue(
    '消えない大事な入力',
  )
  await expect(page.getByText('未保存', { exact: true })).toBeVisible()
  const privacy = page.getByRole('button', {
    name: '保存とプライバシー',
    exact: true,
  })
  await privacy.filter({ visible: true }).click()
  await expect(page.getByRole('dialog')).toContainText('メモを復旧できません')
  await page.getByRole('button', { name: 'わかりました' }).click()
})
