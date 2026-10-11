import type { NoteInput } from './types'
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
export const MAX_BODY_CHARS = 8000
export const MAX_AI_CHARS = 3000
export const MODEL = '@cf/meta/llama-3.2-3b-instruct'
export const RESERVATION_UNITS = 1000
export function cookieName(url: URL) {
  return url.protocol === 'https:' ? '__Host-kiroku' : 'kiroku_dev'
}
export function assertTransport(url: URL) {
  if (
    url.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new ApiError(403, 'HTTPSが必要です。')
}
export function assertSameOrigin(request: Request) {
  if (
    request.headers.get('origin') !== new URL(request.url).origin ||
    request.headers.get('x-kiroku-request') !== '1'
  )
    throw new ApiError(403, 'この操作は同じサイトから行ってください。')
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new ApiError(415, 'JSON形式が必要です。')
}
export function readToken(request: Request) {
  const name = cookieName(new URL(request.url))
  const value = request.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(name + '='))
    ?.slice(name.length + 1)
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null
}
export function createToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}
export async function ownerHash(token: string) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  )
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}
export function sessionCookie(token: string, url: URL) {
  return `${cookieName(url)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${url.protocol === 'https:' ? '; Secure' : ''}`
}
export async function readJson(request: Request): Promise<unknown> {
  if (!request.body) throw new ApiError(400, '入力がありません。')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 40000) {
      await reader.cancel()
      throw new ApiError(413, '入力が長すぎます。')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ApiError(400, '入力形式を確認してください。')
  }
}
export function validateNote(value: unknown): NoteInput {
  if (!value || typeof value !== 'object')
    throw new ApiError(400, '入力形式を確認してください。')
  const v = value as Record<string, unknown>
  if (
    typeof v.title !== 'string' ||
    v.title.trim().length < 1 ||
    v.title.length > 120
  )
    throw new ApiError(400, 'タイトルは1〜120文字で入力してください。')
  if (typeof v.body !== 'string' || v.body.length > MAX_BODY_CHARS)
    throw new ApiError(400, '本文は8,000文字以内で入力してください。')
  if (
    !Array.isArray(v.tags) ||
    v.tags.length > 8 ||
    v.tags.some(
      (t) => typeof t !== 'string' || t.trim().length < 1 || t.length > 24,
    )
  )
    throw new ApiError(400, 'タグは24文字以内、8個までです。')
  if (
    v.version !== undefined &&
    (!Number.isSafeInteger(v.version) || Number(v.version) < 1)
  )
    throw new ApiError(400, '保存情報が正しくありません。')
  return {
    title: v.title.trim(),
    body: v.body,
    tags: [...new Set(v.tags.map((t) => (t as string).trim()))],
    version: v.version as number | undefined,
  }
}
export function boundedInt(
  value: string | undefined,
  min: number,
  max: number,
): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null
}
