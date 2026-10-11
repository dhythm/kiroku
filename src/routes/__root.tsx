import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from '@tanstack/react-router'
import css from '../styles.css?url'
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Kiroku — AI-powered Notes' },
      {
        name: 'description',
        content: '思いつきを、次の一歩に。あなたのブラウザだけの静かなメモ帳。',
      },
    ],
    links: [{ rel: 'stylesheet', href: css }],
  }),
  component: () => (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
  errorComponent: () => (
    <main className="fatal">
      <h1>画面を読み込めませんでした</h1>
      <p>時間をおいて、ページを再読み込みしてください。</p>
      <a href="/">再読み込み</a>
    </main>
  ),
  notFoundComponent: () => (
    <main className="fatal">
      <h1>ページが見つかりません</h1>
      <a href="/">メモ帳へ戻る</a>
    </main>
  ),
})
