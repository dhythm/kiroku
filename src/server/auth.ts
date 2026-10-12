import { betterAuth } from 'better-auth/minimal'
import { google } from 'better-auth/social-providers'
import { verifyProviderIdToken } from 'better-auth/oauth2'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '../db/auth-schema'
import {
  ApiError,
  cookieName,
  createToken,
  ownerHash,
  readToken,
  sessionCookie,
} from '../lib/security'

export interface AuthEnv {
  DB: D1Database
  BETTER_AUTH_URL?: string
  BETTER_AUTH_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
}
export function authConfigured(env: AuthEnv) {
  if (
    !env.BETTER_AUTH_URL ||
    !env.BETTER_AUTH_SECRET ||
    env.BETTER_AUTH_SECRET.length < 32 ||
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET
  )
    return false
  try {
    const url = new URL(env.BETTER_AUTH_URL)
    return (
      url.origin === env.BETTER_AUTH_URL &&
      (url.protocol === 'https:' ||
        (['127.0.0.1', 'localhost'].includes(url.hostname) &&
          url.protocol === 'http:'))
    )
  } catch {
    return false
  }
}
export function createAuth(env: AuthEnv) {
  if (!authConfigured(env))
    throw new ApiError(
      503,
      'Googleログインは未設定のため利用できません。匿名モードをご利用ください。',
    )
  // The code-flow provider decodes its token-endpoint profile by default. Use
  // Better Auth's own OIDC verifier too; no app-owned JWT/OAuth crypto.
  const verifiedGoogle = google({
    clientId: env.GOOGLE_CLIENT_ID!,
    clientSecret: env.GOOGLE_CLIENT_SECRET!,
  })
  return betterAuth({
    appName: 'Kiroku',
    baseURL: env.BETTER_AUTH_URL!,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET!,
    database: drizzleAdapter(drizzle(env.DB), {
      provider: 'sqlite',
      schema,
      transaction: false,
    }),
    trustedOrigins: [env.BETTER_AUTH_URL!],
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        disableDefaultScope: true,
        scope: ['openid', 'email', 'profile'],
        includeGrantedScopes: false,
        accessType: 'online',
        prompt: 'select_account',
        disableIdTokenSignIn: true,
        getUserInfo: async (tokens) => {
          if (
            !tokens.idToken ||
            !(await verifyProviderIdToken(verifiedGoogle, tokens.idToken))
          )
            return null
          const profile = await verifiedGoogle.getUserInfo(tokens)
          // D1 has no interactive transaction. Recover only aged, completely
          // unassociated signup rows after a verified Google identity, never link by email.
          if (profile?.user.email && profile.user.emailVerified === true)
            await env.DB.prepare(
              `DELETE FROM auth_user WHERE email = ? AND created_at < ?
            AND NOT EXISTS (SELECT 1 FROM auth_account WHERE user_id = auth_user.id)
            AND NOT EXISTS (SELECT 1 FROM auth_session WHERE user_id = auth_user.id)
            AND NOT EXISTS (SELECT 1 FROM notes WHERE owner = 'user:' || auth_user.id)
            AND NOT EXISTS (SELECT 1 FROM anonymous_claims WHERE user_id = auth_user.id)
            AND NOT EXISTS (SELECT 1 FROM ai_requests WHERE owner = 'user:' || auth_user.id)`,
            )
              .bind(profile.user.email.toLowerCase(), Date.now() - 120000)
              .run()
          return profile
        },
      },
    },
    emailAndPassword: { enabled: false },
    account: {
      accountLinking: { enabled: false, disableImplicitLinking: true },
      storeStateStrategy: 'database',
      skipStateCookieCheck: false,
      encryptOAuthTokens: true,
      storeAccountCookie: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      cookiePrefix: 'kiroku-auth',
      // Avoid an automatic __Secure- prefix before the explicit __Host- name.
      useSecureCookies: false,
      cookies: {
        state: {
          name: env.BETTER_AUTH_URL!.startsWith('https:')
            ? '__Host-kiroku-auth.state'
            : 'kiroku-auth.state',
        },
        session_token: {
          name: env.BETTER_AUTH_URL!.startsWith('https:')
            ? '__Host-kiroku-auth.session_token'
            : 'kiroku-auth.session_token',
        },
        oauth_state: {
          name: env.BETTER_AUTH_URL!.startsWith('https:')
            ? '__Host-kiroku-auth.oauth_state'
            : 'kiroku-auth.oauth_state',
        },
      },
      crossSubDomainCookies: { enabled: false },
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: env.BETTER_AUTH_URL!.startsWith('https:'),
      },
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 20 },
    logger: { disabled: true },
    onAPIError: { errorURL: '/?login=failed' },
    databaseHooks: {
      account: {
        create: {
          before: async (data) => ({
            data: {
              ...data,
              accessToken: undefined,
              refreshToken: undefined,
              idToken: undefined,
            },
          }),
        },
        update: {
          before: async (data) => ({
            data: {
              ...data,
              accessToken: undefined,
              refreshToken: undefined,
              idToken: undefined,
            },
          }),
        },
      },
    },
  })
}
export function hasAuthCookie(request: Request) {
  return (
    request.headers
      .get('cookie')
      ?.split(';')
      .some((c) =>
        /^(?:__Host-|__Secure-)?kiroku-auth\.session_token=/.test(c.trim()),
      ) ?? false
  )
}
export async function currentUser(request: Request, env: AuthEnv) {
  if (!hasAuthCookie(request)) return null
  if (!authConfigured(env))
    throw new ApiError(
      503,
      'ログイン設定を確認できません。アカウントのデータは読み込んでいません。',
    )
  const session = await createAuth(env).api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
  })
  if (!session)
    throw new ApiError(
      401,
      'ログインの有効期限が切れました。再ログインするか、ログアウトして匿名モードに戻ってください。',
    )
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
  }
}
export const accountOwner = (userId: string) => 'user:' + userId
export async function resolveOwner(request: Request, env: AuthEnv) {
  const user = await currentUser(request, env)
  if (user) return { owner: accountOwner(user.id), user }
  const token = readToken(request)
  if (!token) throw new ApiError(401, 'セッションを再読み込みしてください。')
  const owner = await ownerHash(token)
  if (
    await env.DB.prepare('SELECT owner FROM anonymous_claims WHERE owner = ?')
      .bind(owner)
      .first()
  )
    throw new ApiError(
      401,
      'この匿名セッションは引き継ぎ済みです。再読み込みしてください。',
    )
  return { owner, user: null }
}
export async function importAnonymous(
  request: Request,
  env: AuthEnv,
  userId: string,
) {
  const token = readToken(request)
  const target = accountOwner(userId)
  const statements: D1PreparedStatement[] = []
  if (token) {
    const owner = await ownerHash(token)
    statements.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO anonymous_claims (owner, user_id, created_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM notes WHERE owner = ?) OR EXISTS (SELECT 1 FROM ai_requests WHERE owner = ?)',
      ).bind(owner, userId, Date.now(), owner, owner),
    )
  }
  // Claim, lifetime/daily quota transfer, and available-capacity move are one D1 transaction.
  statements.push(
    env.DB.prepare(
      'UPDATE ai_requests SET owner = ? WHERE owner IN (SELECT owner FROM anonymous_claims WHERE user_id = ?)',
    ).bind(target, userId),
  )
  statements.push(
    env.DB.prepare(
      `UPDATE notes SET owner = ?, version = version + 1 WHERE id IN (
    SELECT n.id FROM notes n INNER JOIN anonymous_claims c ON c.owner = n.owner WHERE c.user_id = ? ORDER BY n.created_at, n.id
    LIMIT MAX(0, 100 - (SELECT COUNT(*) FROM notes WHERE owner = ?)))`,
    ).bind(target, userId, target),
  )
  const results = await env.DB.batch(statements)
  const pending = await pendingCount(env, userId)
  return {
    moved: results.at(-1)!.meta.changes,
    pending,
    cookie: token
      ? sessionCookie(createToken(), new URL(request.url))
      : undefined,
  }
}
export async function pendingCount(env: AuthEnv, userId: string) {
  return (await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM notes n INNER JOIN anonymous_claims c ON c.owner = n.owner WHERE c.user_id = ?',
  )
    .bind(userId)
    .first<{ count: number }>())!.count
}
export function clearAuthCookies(request: Request, headers: Headers) {
  // Used after the library revokes a session, including an expired token.
  for (const name of [
    '__Host-kiroku-auth.session_token',
    'kiroku-auth.session_token',
    '__Secure-kiroku-auth.session_token',
  ])
    headers.append(
      'Set-Cookie',
      `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${name.startsWith('__') ? '; Secure' : ''}`,
    )
  headers.append(
    'Set-Cookie',
    `${cookieName(new URL(request.url))}=${createToken()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`,
  )
}
