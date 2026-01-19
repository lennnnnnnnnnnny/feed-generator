import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { BskyAgent } from '@atproto/api'

export const shortname = 'new-and-notable'

// --- Tuning knobs ---
const WINDOW_MINUTES = 60
const DB_LIMIT = 1000
const MAX_URIS_TO_SCORE = 400
const CHUNK_SIZE = 25
const MIN_LIKES_THRESHOLD = 5

const agent = new BskyAgent({
  service: process.env.FEEDGEN_APPVIEW_URL ?? 'https://api.bsky.app',
})

export const handler = async (ctx: AppContext, params: QueryParams) => {
  const now = Date.now()
  const windowStartIso = new Date(now - WINDOW_MINUTES * 60_000).toISOString()

  // Cursor is a timestamp (ms). If provided, only return posts older than cursor.
  const cursorMs = params.cursor ? parseInt(params.cursor, 10) : undefined
  const cursorIso =
    cursorMs && !Number.isNaN(cursorMs) ? new Date(cursorMs).toISOString() : undefined

  // 1) Fetch candidate posts from DB within time window (and older than cursor if set)
  let qb = ctx.db
    .selectFrom('post')
    .selectAll()
    .where('indexedAt', '>=', windowStartIso)

  if (cursorIso) {
    qb = qb.where('indexedAt', '<', cursorIso)
  }

  const rows = await qb.orderBy('indexedAt', 'desc').limit(DB_LIMIT).execute()

  if (rows.length === 0) return { feed: [] }

  // 2) Score only the newest N candidates to avoid timeouts
  const newestRows = rows.slice(0, MAX_URIS_TO_SCORE)
  const indexedAtByUri = new Map(newestRows.map((r) => [r.uri, r.indexedAt]))
  const uris = newestRows.map((r) => r.uri)

  const chunks: string[][] = []
  for (let i = 0; i < uris.length; i += CHUNK_SIZE) {
    chunks.push(uris.slice(i, i + CHUNK_SIZE))
  }

  const postsWithLikes: { uri: string; likeCount: number }[] = []

  // 3) Batch fetch live popularity stats
  for (const chunk of chunks) {
    const res = await agent.api.app.bsky.feed.getPosts({ uris: chunk })
    for (const p of res.data.posts) {
      postsWithLikes.push({ uri: p.uri, likeCount: p.likeCount ?? 0 })
    }
  }

  // 4) Filter + sort newest-first (chrono, but “now” at the top)
  const candidates = postsWithLikes
    .map((p) => {
      const indexedAt = indexedAtByUri.get(p.uri)
      const indexedAtMs = indexedAt ? Date.parse(indexedAt) : 0
      const ageMs = indexedAt ? now - indexedAtMs : Number.POSITIVE_INFINITY
      return { uri: p.uri, likeCount: p.likeCount, indexedAtMs, ageMs }
    })
    .filter((p) => p.likeCount >= MIN_LIKES_THRESHOLD)
    // NEWEST FIRST:
    .sort((a, b) => b.indexedAtMs - a.indexedAtMs)

  const limit = params.limit ?? 50
  const page = candidates.slice(0, limit)

  // 5) Cursor: timestamp of the oldest item in this page
  let nextCursor: string | undefined
  const last = page.at(-1)
  if (last && last.indexedAtMs) {
    nextCursor = String(last.indexedAtMs)
  }

  return {
    feed: page.map((p) => ({ post: p.uri })),
    cursor: nextCursor,
  }
}
