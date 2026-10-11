import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull(),
    summary: text('summary'),
    version: integer('version').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('notes_owner_updated').on(t.owner, t.updatedAt)],
)
export const aiRequests = sqliteTable(
  'ai_requests',
  {
    id: text('id').primaryKey(),
    owner: text('owner').notNull(),
    day: text('day').notNull(),
    ip: text('ip').notNull(),
    units: integer('units').notNull(),
    sessionLimit: integer('session_limit').notNull(),
    budget: integer('budget').notNull(),
    active: integer('active').notNull().default(1),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('ai_day_owner').on(t.day, t.owner),
    index('ai_day_ip').on(t.day, t.ip),
    index('ai_active').on(t.active),
  ],
)
export const aiControl = sqliteTable('ai_control', {
  id: integer('id').primaryKey(),
  blocked: integer('blocked').notNull().default(0),
})
