import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { BskyAgent } from '@atproto/api'

export const shortname = 'new-and-notable'

// --- Tuning Knobs for "What's Hot" Feel ---
const WINDOW_MINUTES = 60      // Look back 1 hour
const DB_LIMIT = 1000          // Pull 1000 posts to find enough "hot" ones
const MAX_URIS_TO_SCORE = 400  // Check live likes for 400 newest candidates
const CHUNK_SIZE = 25          // API batch size
const MIN_LIKES_THRESHOLD = 5 // The "Loudness" floor

const agent = new BskyAgent({
  service: process.env.FEEDGEN_APPVIEW_URL ?? 'https://api.bsky.app',
})

export const handler = async (ctx: AppContext, params: QueryParams) => {
  const now = Date.now()
  const windowStartIso = new Date(now - WINDOW_MINUTES * 60_000).toISOString()

  // 1. Dig deeper into the DB to find more candidates
  const rows = await ctx.db
    .selectFrom('post')
    .selectAll()
    .where('indexedAt', '>=', windowStartIso)
    .orderBy('indexedAt', 'desc')
    .limit(DB_LIMIT)
    .execute()

  if (rows.length === 0) return { feed: [] }

  // 2. Score a larger batch to ensure the feed stays full
  const newestRows = rows.slice(0, MAX_URIS_TO_SCORE)
  const indexedAtByUri = new Map(newestRows.map((r) => [r.uri, r.indexedAt]))
  const uris = newestRows.map((r) => r.uri)
  
  const chunks: string[][] = []
  for (let i = 0; i < uris.length; i += CHUNK_SIZE) {
    chunks.push(uris.slice(i, i + CHUNK_SIZE))
  }

  const postsWithLikes: { uri: string; likeCount: number }[] = []

  // 3. Batch fetch live popularity stats
  for (const chunk of chunks) {
    try {
      const res = await agent.api.app.bsky.feed.getPosts({ uris: chunk })
      for (const p of res.data.posts) {
        postsWithLikes.push({ uri: p.uri, likeCount: p.likeCount ?? 0 })
      }
    } catch (e) {
      console.error('Error fetching likes:', e)
    }
  }

  // 4. Strict "Loud Voices" Filter
  const candidates = postsWithLikes
    .map((p) => {
      const indexedAt = indexedAtByUri.get(p.uri)
      const ageMs = indexedAt ? now - Date.parse(indexedAt) : 0
      return { uri: p.uri, likeCount: p.likeCount, ageMs }
    })
    .filter((p) => {
      // Ignore the "crap"—only show posts that have hit your 12-like goal
      return p.likeCount >= MIN_LIKES_THRESHOLD
    })
    .sort((a, b) => {
      // Keep it strictly chronological so it's not jarring
      return a.ageMs - b.ageMs 
    })

  // 5. Handle Pagination (so the feed doesn't just stop)
  const limit = params.limit ?? 50
  return { 
    feed: candidates.slice(0, limit).map((p) => ({ post: p.uri })) 
  }
}
