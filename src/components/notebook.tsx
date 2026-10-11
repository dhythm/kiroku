import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  FileText,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Search,
  Sparkles,
  Tag,
  Trash2,
  X,
} from 'lucide-react'
import type { AiStatus, Note, NoteInput } from '../lib/types'

async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      signal: path.endsWith('/summarize')
        ? AbortSignal.timeout(45000)
        : undefined,
      headers:
        method === 'GET'
          ? {}
          : { 'Content-Type': 'application/json', 'X-Kiroku-Request': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new Error(
      path.endsWith('/summarize')
        ? 'AIの応答待ちが長くなっています。完了を確認するまで次の要約は制限されます。後で再読み込みしてください。'
        : '通信できませんでした。入力は残しています。もう一度お試しください。',
    )
  }
  const data = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(data.error ?? '通信に失敗しました。')
  return data
}
const blank: NoteInput = { title: '', body: '', tags: [] }
const formatDate = (time: number) =>
  new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric' }).format(
    time,
  )
export function Notebook() {
  const [notes, setNotes] = useState<Note[]>([])
  const [selected, setSelected] = useState<Note | null>(null)
  const [draft, setDraft] = useState<NoteInput>(blank)
  const [tagText, setTagText] = useState('')
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'save' | 'ai' | 'delete' | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [editor, setEditor] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showPrivacy, setShowPrivacy] = useState(false)
  const [ready, setReady] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const searchSequence = useRef(0)
  const titleRef = useRef<HTMLInputElement>(null)
  const parsedTags = [
    ...new Set(
      tagText
        .split(/[、,]/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ]
  const dirty =
    editor &&
    (selected
      ? draft.title !== selected.title ||
        draft.body !== selected.body ||
        JSON.stringify(parsedTags) !== JSON.stringify(selected.tags)
      : draft.title !== '' || draft.body !== '' || tagText !== '')
  const allTags = [...new Set(notes.flatMap((n) => n.tags))].sort()

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        await api('/api/session')
        const [list, ai] = await Promise.all([
          api<{ notes: Note[] }>('/api/notes'),
          api<AiStatus>('/api/status'),
        ])
        if (alive) {
          setNotes(list.notes)
          setStatus(ai)
          setReady(true)
        }
      } catch (e) {
        if (alive) setError((e as Error).message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => {
    if (!ready) return
    const sequence = ++searchSequence.current
    const timer = window.setTimeout(() => {
      setFiltering(true)
      void api<{ notes: Note[] }>(
        '/api/notes?' + new URLSearchParams({ q: query, tag: tagFilter }),
      )
        .then((data) => {
          if (sequence === searchSequence.current) setNotes(data.notes)
        })
        .catch((e) => {
          if (sequence === searchSequence.current) setError(e.message)
        })
        .finally(() => {
          if (sequence === searchSequence.current) setFiltering(false)
        })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [query, tagFilter, ready])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useEffect(() => {
    if (!confirmDelete && !showPrivacy) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        setConfirmDelete(false)
        setShowPrivacy(false)
      }
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [confirmDelete, showPrivacy, busy])
  function canLeave() {
    return (
      !dirty || window.confirm('未保存の変更があります。変更を破棄しますか？')
    )
  }
  function open(note: Note | null) {
    if (busy || !canLeave()) return
    setSelected(note)
    setDraft(
      note ? { title: note.title, body: note.body, tags: note.tags } : blank,
    )
    setTagText(note?.tags.join(', ') ?? '')
    setEditor(true)
    setError('')
    window.setTimeout(() => titleRef.current?.focus(), 0)
  }
  async function save() {
    setError('')
    setBusy('save')
    try {
      const result = await api<{ note: Note }>(
        selected ? `/api/notes/${selected.id}` : '/api/notes',
        selected ? 'PUT' : 'POST',
        { ...draft, tags: parsedTags, version: selected?.version },
      )
      setSelected(result.note)
      setDraft(result.note)
      setTagText(result.note.tags.join(', '))
      setNotes((list) => [
        result.note,
        ...list.filter((n) => n.id !== result.note.id),
      ])
      setQuery('')
      setTagFilter('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  async function summarize() {
    if (!selected) return
    setError('')
    setBusy('ai')
    try {
      const { note } = await api<{ note: Note }>(
        `/api/notes/${selected.id}/summarize`,
        'POST',
        {},
      )
      setSelected(note)
      setNotes((list) => list.map((n) => (n.id === note.id ? note : n)))
    } catch (e) {
      setError((e as Error).message)
      try {
        setStatus(await api<AiStatus>('/api/status'))
      } catch {
        /* Original error remains visible. */
      }
    } finally {
      setBusy(null)
    }
  }
  async function remove() {
    if (!selected) return
    setError('')
    setBusy('delete')
    try {
      await api(`/api/notes/${selected.id}`, 'DELETE', {
        version: selected.version,
      })
      setNotes((list) => list.filter((n) => n.id !== selected.id))
      setSelected(null)
      setDraft(blank)
      setTagText('')
      setEditor(false)
      setConfirmDelete(false)
    } catch (e) {
      setError((e as Error).message)
      setConfirmDelete(false)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Kiroku ホーム">
          <span className="brand-mark">
            <FileText size={19} strokeWidth={1.7} />
          </span>
          kiroku<span className="brand-dot">.</span>
        </a>
        <div className="workspace-label">PERSONAL WORKSPACE</div>
        <div className="nav-item">
          <FileText size={17} />
          <span>すべてのメモ</span>
          <span className="count">{notes.length}</span>
        </div>
        <div className="sidebar-section">
          <span>タグ</span>
          <Tag size={14} />
        </div>
        {allTags.length === 0 ? (
          <p className="muted sidebar-hint">
            メモにタグを付けると
            <br />
            ここに表示されます。
          </p>
        ) : (
          <div className="tag-list">
            {allTags.map((t) => (
              <button
                className={tagFilter === t ? 'tag-nav active' : 'tag-nav'}
                key={t}
                onClick={() => setTagFilter(tagFilter === t ? '' : t)}
              >
                <span>#</span>
                {t}
              </button>
            ))}
          </div>
        )}
        <div className="sidebar-bottom">
          <div className="quiet-card">
            <LockKeyhole size={17} />
            <p>
              このブラウザだけの
              <br />
              <strong>あなたのメモ帳</strong>
            </p>
          </div>
          <button className="privacy-link" onClick={() => setShowPrivacy(true)}>
            保存とプライバシー
            <ArrowUpRight size={13} />
          </button>
          <p className="sidebar-footer">小さな記録が、次の一歩に。</p>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <span className="breadcrumb">
            ワークスペース
            <ChevronRight size={13} />
            <strong>メモ</strong>
          </span>
          <span className="private-badge">
            <span />
            プライベートな記録
          </span>
          <button
            className="mobile-privacy"
            aria-label="保存とプライバシー"
            onClick={() => setShowPrivacy(true)}
          >
            <LockKeyhole size={18} />
          </button>
        </header>
        <main className={'workspace ' + (editor ? 'editor-open' : '')}>
          <section className="notes-pane" aria-label="メモ一覧">
            <div className="page-heading">
              <div>
                <p className="eyebrow">YOUR EVERYDAY NOTES</p>
                <h1>思いつきを、残そう。</h1>
                <p className="subtitle">
                  考えたこと、気づいたこと。ここから育てる。
                </p>
              </div>
              <button
                className="primary-button new-button"
                disabled={!ready || !!busy}
                onClick={() => open(null)}
              >
                <Plus size={17} />
                新しいメモ
              </button>
            </div>
            <div className="search-row">
              <label className="search-box">
                <Search size={17} />
                <input
                  aria-label="メモを検索"
                  placeholder="タイトルや本文を検索…"
                  value={query}
                  maxLength={120}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {filtering && <LoaderCircle size={15} className="spin" />}
              </label>
              {tagFilter && (
                <button
                  className="filter-chip"
                  onClick={() => setTagFilter('')}
                >
                  #{tagFilter}
                  <X size={13} />
                </button>
              )}
            </div>
            <div className="list-heading">
              <span>{query || tagFilter ? '検索結果' : '最近のメモ'}</span>
              <span>{notes.length}件</span>
            </div>
            {error && !editor && (
              <div role="alert" className="error-banner">
                {error}
                {!ready && (
                  <button onClick={() => window.location.reload()}>
                    再読み込み
                  </button>
                )}
                <button
                  aria-label="エラーを閉じる"
                  onClick={() => setError('')}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {loading ? (
              <div className="empty-state" role="status">
                <LoaderCircle className="spin" />
                <h2>メモを読み込んでいます</h2>
              </div>
            ) : notes.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">
                  <FileText size={27} strokeWidth={1.3} />
                </div>
                <h2>
                  {query || tagFilter
                    ? 'メモが見つかりませんでした'
                    : '余白から、はじめよう。'}
                </h2>
                <p>
                  {query || tagFilter
                    ? '検索語やタグを変えてお試しください。'
                    : '今日の気づきも、ふとしたアイデアも。\n最初のメモをここに残してみませんか。'}
                </p>
                {!query && !tagFilter && (
                  <button
                    className="text-button"
                    disabled={!ready}
                    onClick={() => open(null)}
                  >
                    最初のメモを書く
                    <ArrowUpRight size={15} />
                  </button>
                )}
              </div>
            ) : (
              <div className="note-list">
                {notes.map((note) => (
                  <button
                    key={note.id}
                    className={
                      'note-card ' +
                      (selected?.id === note.id && editor ? 'selected' : '')
                    }
                    onClick={() => open(note)}
                    disabled={!!busy}
                  >
                    <div className="note-card-top">
                      <span className="note-icon">
                        <FileText size={16} />
                      </span>
                      <time>{formatDate(note.updatedAt)}</time>
                    </div>
                    <h2>{note.title}</h2>
                    <p>{note.body || 'まだ本文がありません。'}</p>
                    <div className="note-card-bottom">
                      <div className="chips">
                        {note.tags.slice(0, 3).map((t) => (
                          <span className="chip" key={t}>
                            #{t}
                          </span>
                        ))}
                      </div>
                      {note.summary && (
                        <span className="summary-indicator">
                          <Sparkles size={12} />
                          要約あり
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
            <p className="list-footnote">
              <LockKeyhole size={12} />
              メモはこのブラウザのセッションに保存されます。
            </p>
          </section>
          {editor ? (
            <section className="editor-pane" aria-label="メモ編集">
              <div className="editor-toolbar">
                <button
                  className="back-button"
                  onClick={() => {
                    if (canLeave()) setEditor(false)
                  }}
                  disabled={!!busy}
                >
                  <ArrowLeft size={16} />
                  一覧へ
                </button>
                <span
                  className={'save-status ' + (dirty ? 'unsaved' : '')}
                  aria-live="polite"
                >
                  {busy === 'save' ? (
                    <>
                      <LoaderCircle size={13} className="spin" />
                      保存中
                    </>
                  ) : dirty || !selected ? (
                    '未保存'
                  ) : (
                    <>
                      <Check size={13} />
                      保存済み
                    </>
                  )}
                </span>
                <button
                  className="icon-button danger"
                  aria-label="メモを削除"
                  disabled={!selected || !!busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <div className="editor-content">
                {error && (
                  <div role="alert" className="error-banner">
                    {error}
                    <button
                      aria-label="エラーを閉じる"
                      onClick={() => setError('')}
                    >
                      <X size={15} />
                    </button>
                  </div>
                )}
                <label className="sr-only" htmlFor="note-title">
                  タイトル
                </label>
                <input
                  ref={titleRef}
                  id="note-title"
                  className="title-input"
                  placeholder="タイトルをつける"
                  maxLength={120}
                  value={draft.title}
                  disabled={!!busy}
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value })
                  }
                />
                <div className="tag-input-row">
                  <Tag size={15} />
                  <label className="sr-only" htmlFor="note-tags">
                    タグ（カンマ区切り）
                  </label>
                  <input
                    id="note-tags"
                    placeholder="タグを追加（カンマ区切り）"
                    value={tagText}
                    maxLength={220}
                    disabled={!!busy}
                    onChange={(e) => setTagText(e.target.value)}
                  />
                </div>
                <label className="sr-only" htmlFor="note-body">
                  本文
                </label>
                <textarea
                  id="note-body"
                  placeholder={
                    'いま、考えていることは？\n自由に書き留めてみましょう。'
                  }
                  value={draft.body}
                  maxLength={8000}
                  disabled={!!busy}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
                <div className="editor-meta">
                  <span>{draft.body.length.toLocaleString()} / 8,000文字</span>
                  <span>タグは8個まで</span>
                </div>
                <button
                  className="primary-button save-button"
                  disabled={
                    !!busy ||
                    !draft.title.trim() ||
                    (selected !== null && !dirty)
                  }
                  onClick={() => void save()}
                >
                  {busy === 'save' ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <Check size={16} />
                  )}
                  メモを保存
                </button>
                <div className="ai-section">
                  <div className="ai-heading">
                    <span>
                      <Sparkles size={17} />
                      <strong>考えを、ひと目で。</strong>
                    </span>
                    <span className="ai-label">AI SUMMARY</span>
                  </div>
                  <p>
                    {status?.enabled
                      ? '保存した本文をAIが短く整理します。結果はご自身で確認してください。'
                      : (status?.reason ?? 'AIの設定を確認しています。')}
                  </p>
                  <button
                    className="ai-button"
                    disabled={
                      !status?.enabled ||
                      !selected ||
                      dirty ||
                      !!busy ||
                      !draft.body.trim() ||
                      draft.body.length > (status?.maxChars ?? 3000)
                    }
                    onClick={() => void summarize()}
                  >
                    {busy === 'ai' ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <Sparkles size={16} />
                    )}
                    {busy === 'ai' ? '要約しています…' : 'ワンクリックで要約'}
                    <ArrowUpRight size={14} />
                  </button>
                  {status?.enabled && (
                    <small>
                      {dirty || !selected
                        ? '先にメモを保存してください。'
                        : draft.body.length > status.maxChars
                          ? '要約は3,000文字以内の本文で利用できます。'
                          : '本文をCloudflareへ送信します。セッションと全体の日次上限があります。'}
                    </small>
                  )}
                  {selected?.summary && (
                    <div className="summary-content">
                      <span>
                        <Sparkles size={13} />
                        AIによる要約
                      </span>
                      <p>{selected.summary}</p>
                    </div>
                  )}
                </div>
              </div>
            </section>
          ) : (
            <aside className="welcome-pane">
              <div className="welcome-art" aria-hidden="true">
                <div className="paper paper-back" />
                <div className="paper paper-front">
                  <span />
                  <span />
                  <span />
                  <span className="short" />
                  <div className="paper-spark">
                    <Sparkles size={23} />
                  </div>
                </div>
                <div className="art-dot" />
              </div>
              <p className="eyebrow">A LITTLE SPACE FOR YOUR MIND</p>
              <h2>
                書くことで、
                <br />
                少し、整う。
              </h2>
              <p>
                メモを選ぶか、新しく書きはじめて。
                <br />
                あなたの考えのための、静かな場所です。
              </p>
              <div className="welcome-divider" />
              <span className="welcome-caption">
                <Sparkles size={14} />
                AI要約で、大切なことを見つける。
              </span>
            </aside>
          )}
        </main>
      </div>
      {confirmDelete && (
        <div className="modal-backdrop">
          <dialog open aria-labelledby="delete-title" className="modal">
            <span className="modal-icon">
              <Trash2 size={22} />
            </span>
            <h2 id="delete-title">このメモを削除しますか？</h2>
            <p>「{selected?.title}」を削除します。この操作は元に戻せません。</p>
            <div className="modal-actions">
              <button
                autoFocus
                className="secondary-button"
                disabled={!!busy}
                onClick={() => setConfirmDelete(false)}
              >
                キャンセル
              </button>
              <button
                className="delete-button"
                disabled={!!busy}
                onClick={() => void remove()}
              >
                {busy === 'delete' ? '削除中…' : '削除する'}
              </button>
            </div>
          </dialog>
        </div>
      )}
      {showPrivacy && (
        <div className="modal-backdrop">
          <dialog
            open
            aria-labelledby="privacy-title"
            className="modal privacy-modal"
          >
            <button
              autoFocus
              className="modal-close icon-button"
              aria-label="閉じる"
              onClick={() => setShowPrivacy(false)}
            >
              <X size={18} />
            </button>
            <span className="modal-icon">
              <LockKeyhole size={22} />
            </span>
            <h2 id="privacy-title">あなたのメモの保存について</h2>
            <p>
              ログイン不要です。このブラウザの匿名Cookieを鍵にして、サーバー上のあなたのメモだけを表示します。
            </p>
            <p>
              <strong>
                Cookieの削除・紛失、ブラウザ変更後は、メモを復旧できません。
              </strong>
              大切な内容は別の場所にも控えてください。共有端末では、同じブラウザの利用者がメモを閲覧できます。
            </p>
            <p>
              AI要約を実行すると、本文をCloudflare Workers
              AIへ送信します。機密情報や個人情報の入力は控えてください。AIの結果は正確でない場合があります。
            </p>
            <p>
              保存はボタンで行います。未保存の入力はページを閉じると失われます。メモは100件までです。
            </p>
            <button
              className="primary-button"
              onClick={() => setShowPrivacy(false)}
            >
              わかりました
            </button>
          </dialog>
        </div>
      )}
    </div>
  )
}
