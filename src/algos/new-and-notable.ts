import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { BskyAgent } from '@atproto/api'

export const shortname = 'new-and-notable'

// Tuning knobs
const WINDOW_MINUTES = 60
const NUDGE_WINDOW_MINUTES = 5

const MIN_LIKES_MAIN = 12
const MIN_LIKES_FRESH = 6
const FRESH_MINUTES = 10

// Hard caps to prevent timeouts
const DB_LIMIT = 300               // read at most this many rows from sqlite
const MAX_URIS_TO_SCORE = 120      // only fetch stats for at most this many newest posts
const CHUNK_SIZE = 25              // AppView chunk size

const agent = new BskyAgent({
  service: process.env.FEEDGEN_APPVIEW_URL ?? 'https://api.bsky.app',
})

export const handler = async (ctx: AppContext, params: QueryParams) => {
  const now = Date.now()
  const windowStartIso = new Date(now - WINDOW_MINUTES * 60_000).toISOString()

  // Only grab rows within the time window (huge speedup)
  const rows = await ctx.db
    .selectFrom('post')
    .selectAll()
    .where('indexedAt', '>=', windowStartIso)
    .orderBy('indexedAt', 'desc')
    .limit(DB_LIMIT)
    .execute()

  if (rows.length === 0) return { feed: [] }

  // Keep only the newest N to score (prevents tons of API calls)
  const newestRows = rows.slice(0, MAX_URIS_TO_SCORE)

  const indexedAtByUri = new Map(newestRows.map((r) => [r.uri, r.indexedAt]))

  const uris = newestRows.map((r) => r.uri)
  const chunks: string[][] = []
  for (let i = 0; i < uris.length; i += CHUNK_SIZE) {
    chunks.push(uris.slice(i, i + CHUNK_SIZE))
  }

  const postsWithLikes: { uri: string; likeCount: number }[] = []

  // Fetch stats (bounded number of calls)
  for (const chunk of chunks) {
    const res = await agent.api.app.bsky.feed.getPosts({ uris: chunk })
    for (const p of res.data.posts) {
      postsWithLikes.push({ uri: p.uri, likeCount: p.likeCount ?? 0 })
    }
  }

  const candidates = postsWithLikes
    .map((p) => {
      const indexedAt = indexedAtByUri.get(p.uri)
      const ageMs = indexedAt ? now - Date.parse(indexedAt) : Number.POSITIVE_INFINITY
      const ageMinutes = ageMs / 60000

      return {
        uri: p.uri,
        likeCount: p.likeCount,
        indexedAt: indexedAt ?? new Date(0).toISOString(),
        ageMinutes,
      }
    })
    // Safety: ensure in window
    .filter((p) => p.ageMinutes <= WINDOW_MINUTES)
    // Age-based like thresholds
    .filter((p) => {
      if (p.ageMinutes <= FRESH_MINUTES) return p.likeCount >= MIN_LIKES_FRESH
      return p.likeCount >= MIN_LIKES_MAIN
    })
    // Mostly time order, likes only nudge within 5 minutes
    .sort((a, b) => {
      const aTime = Date.parse(a.indexedAt)
      const bTime = Date.parse(b.indexedAt)

      const timeDiff = bTime - aTime

      const withinNudge = Math.abs(aTime - bTime) <= NUDGE_WINDOW_MINUTES * 60_000
      if (withinNudge) {
        const likeDiff = b.likeCount - a.likeCount
        if (likeDiff !== 0) return likeDiff
      }

      return timeDiff
    })

  const limit = params.limit ?? 50
  return { feed: candidates.slice(0, limit).map((p) => ({ post: p.uri })) }
}
