import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { BskyAgent } from '@atproto/api'

export const shortname = 'new-and-notable'

// --- Tuning Knobs ---
const WINDOW_MINUTES = 60
const DB_LIMIT = 400            // Max posts to pull from local DB
const MAX_URIS_TO_SCORE = 150   // Max posts to check likes for
const CHUNK_SIZE = 25           // Bluesky API limit per request

const agent = new BskyAgent({
  service: process.env.FEEDGEN_APPVIEW_URL ?? 'https://api.bsky.app',
})

export const handler = async (ctx: AppContext, params: QueryParams) => {
  const now = Date.now()
  const windowStartIso = new Date(now - WINDOW_MINUTES * 60_000).toISOString()

  // 1. Get posts from your local DB that were indexed in the last hour
  const rows = await ctx.db
    .selectFrom('post')
    .selectAll()
    .where('indexedAt', '>=', windowStartIso)
    .orderBy('indexedAt', 'desc')
    .limit(DB_LIMIT)
    .execute()

  if (rows.length === 0) return { feed: [] }

  // 2. Prepare batches to ask Bluesky for the current like counts
  const newestRows = rows.slice(0, MAX_URIS_TO_SCORE)
  const indexedAtByUri = new Map(newestRows.map((r) => [r.uri, r.indexedAt]))
  const uris = newestRows.map((r) => r.uri)
  
  const chunks: string[][] = []
  for (let i = 0; i < uris.length; i += CHUNK_SIZE) {
    chunks.push(uris.slice(i, i + CHUNK_SIZE))
  }

  const postsWithLikes: { uri: string; likeCount: number }[] = []

  // 3. Fetch the "Loudness" (Like Counts)
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

  // 4. The "Pulse" Filter Logic
  const candidates = postsWithLikes
    .map((p) => {
      const indexedAt = indexedAtByUri.get(p.uri)
      const ageMs = indexedAt ? now - Date.parse(indexedAt) : 0
      const ageMinutes = ageMs / 60_000

      return {
        uri: p.uri,
        likeCount: p.likeCount,
        ageMinutes,
      }
    })
    .filter((p) => {
      // --- SLIDING THRESHOLDS ---
      // This ensures 1-2 posts a minute while staying time-sensitive
      
      if (p.ageMinutes < 2) return p.likeCount >= 1  // Brand new? Show it if it has even 1 like
      if (p.ageMinutes < 10) return p.likeCount >= 5 // 10 mins old? Need some traction
      if (p.ageMinutes < 30) return p.likeCount >= 12 // 30 mins old? Must be popular
      return p.likeCount >= 20                        // Getting older? Only the hits stay
    })
    .sort((a, b) => {
      // 5. Strictly Chronological
      // This prevents the "jarring" feeling by keeping the newest at the top
      return b.ageMinutes - a.ageMinutes 
    })

  const limit = params.limit ?? 50
  return { feed: candidates.slice(0, limit).map((p) => ({ post: p.uri })) }
}
