export type Note = {
  id: string
  title: string
  body: string
  tags: string[]
  summary: string | null
  version: number
  createdAt: number
  updatedAt: number
}
export type NoteInput = {
  title: string
  body: string
  tags: string[]
  version?: number
}
export type AiStatus = { enabled: boolean; reason: string; maxChars: number }
export type SessionInfo = {
  user: { id: string; name: string; email: string } | null
  googleEnabled: boolean
  pending: number
}
