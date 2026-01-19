import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { BskyAgent } from '@atproto/api'

const MIN_LIKES = 12
const WINDOW_MINUTES = 60
const NUDGE_WINDOW_MINUTES = 5

export const shortname = 'new-and-notable'

// Public AppView client
const agent = new BskyAgent({
  service: process.env.FEEDGEN_APPVIEW_URL ?? 'https://api.bsky.app',
})

export const handler = async (ctx: AppContext, params: QueryParams) => {
  // Pull recent candidates from DB
  const rows = await ctx.db
    .selectFrom('post')
    .selectAll()
    .orderBy('indexedAt', 'desc')
    .limit(200)
    .execute()

  if (rows.length === 0) return { feed: [] }

  // uri -> indexedAt lookup
  const indexedAtByUri = new Map(rows.map((r) => [r.uri, r.indexedAt]))

  // AppView getPosts is typically capped per request, so chunk
  const uris = rows.map((r) => r.uri)
  const chunks: string[][] = []
  for (let i = 0; i < uris.length; i += 25) {
    chunks.push(uris.slice(i, i + 25))
  }

  const postsWithLikes: { uri: string; likeCount: number }[] = []

  for (const chunk of chunks) {
    const res = await agent.api.app.bsky.feed.getPosts({ uris: chunk })
    for (const p of res.data.posts) {
      postsWithLikes.push({ uri: p.uri, likeCount: p.likeCount ?? 0 })
    }
  }

  const now = Date.now()

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
    // Only posts seen within the last hour
    .filter((p) => p.ageMinutes <= WINDOW_MINUTES)
    // Only posts with enough likes
    .filter((p) => p.likeCount >= MIN_LIKES)
    // Mostly time-ordered (newest first), but allow likes to nudge order within 5 minutes
    .sort((a, b) => {
      const aTime = Date.parse(a.indexedAt)
      const bTime = Date.parse(b.indexedAt)

      // Primary: newest first
      const timeDiff = bTime - aTime

      // If within nudge window, use likes as a tie-breaker
      const withinNudge = Math.abs(aTime - bTime) <= NUDGE_WINDOW_MINUTES * 60_000

      if (withinNudge) {
        const likeDiff = b.likeCount - a.likeCount
        if (likeDiff !== 0) return likeDiff
      }

      return timeDiff
    })

  const limit = params.limit ?? 50
  const feed = candidates.slice(0, limit).map((p) => ({ post: p.uri }))

  return { feed }
}
