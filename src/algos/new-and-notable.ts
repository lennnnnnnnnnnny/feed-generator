import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { BskyAgent } from '@atproto/api'

export const shortname = 'new-and-notable'

// Hot Classic feed AT URI
const SOURCE_FEED_AT_URI =
  'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/hot-classic'

// Hot Classic pull size (ask for more so filtering images still leaves plenty)
const SOURCE_LIMIT = 100

// Rocket detection knobs
const ROCKET_WINDOW_MINUTES = 10        // only look at very recent DB posts
const ROCKET_DB_LIMIT = 200             // how many recent candidates to consider
const ROCKET_MIN_AGE_SECONDS = 30       // avoid dividing by tiny ages
const ROCKET_MAX_AGE_SECONDS = 180      // "one minute mark vibe" up to 3 minutes
const ROCKET_MIN_LIKES_PER_MIN = 6      // your rule: 6+ likes per minute
const ROCKET_MAX_URIS_TO_SCORE = 100    // cap API calls
const CHUNK_SIZE = 25

const agent = new BskyAgent({
  service: process.env.FEEDGEN_APPVIEW_URL ?? 'https://api.bsky.app',
})

export const handler = async (ctx: AppContext, params: QueryParams) => {
  const limit = params.limit ?? 50
  const now = Date.now()

  // 1) Pull Hot Classic (for guaranteed "loud" content)
  const hotRes = await agent.api.app.bsky.feed.getFeed({
    feed: SOURCE_FEED_AT_URI,
    limit: SOURCE_LIMIT,
    cursor: params.cursor,
  })

  // Filter out ONLY image embeds from Hot Classic
  const hotFilteredUris = hotRes.data.feed
    .filter((item) => {
      const post = item.post
      if (!post || !post.record) return false
      const record = post.record as any
      const hasImages = record.embed?.$type === 'app.bsky.embed.images'
      return !hasImages
    })
    .map((item) => item.post.uri)

  // 2) Pull very recent candidates from YOUR DB for "rocket" detection
  const windowStartIso = new Date(now - ROCKET_WINDOW_MINUTES * 60_000).toISOString()

  const dbRows = await ctx.db
    .selectFrom('post')
    .selectAll()
    .where('indexedAt', '>=', windowStartIso)
    .orderBy('indexedAt', 'desc')
    .limit(ROCKET_DB_LIMIT)
    .execute()

  const newestRows = dbRows.slice(0, ROCKET_MAX_URIS_TO_SCORE)
  const indexedAtByUri = new Map(newestRows.map((r) => [r.uri, r.indexedAt]))
  const uris = newestRows.map((r) => r.uri)

  // Fetch like counts for recent candidates (chunked)
  const chunks: string[][] = []
  for (let i = 0; i < uris.length; i += CHUNK_SIZE) chunks.push(uris.slice(i, i + CHUNK_SIZE))

  const recentWithLikes: { uri: string; likeCount: number }[] = []
  for (const chunk of chunks) {
    const res = await agent.api.app.bsky.feed.getPosts({ uris: chunk })
    for (const p of res.data.posts) {
      recentWithLikes.push({ uri: p.uri, likeCount: p.likeCount ?? 0 })
    }
  }

  // Compute rocket score and select only fast-risers
  const rocketUris = recentWithLikes
    .map((p) => {
      const indexedAt = indexedAtByUri.get(p.uri)
      const indexedAtMs = indexedAt ? Date.parse(indexedAt) : 0
      const ageSeconds = indexedAt ? (now - indexedAtMs) / 1000 : Number.POSITIVE_INFINITY
      const ageMinutes = ageSeconds / 60
      const likeRate = ageMinutes > 0 ? p.likeCount / ageMinutes : 0

      return {
        uri: p.uri,
        likeCount: p.likeCount,
        ageSeconds,
        likeRate,
        indexedAtMs,
      }
    })
    .filter((p) => p.ageSeconds >= ROCKET_MIN_AGE_SECONDS)
    .filter((p) => p.ageSeconds <= ROCKET_MAX_AGE_SECONDS)
    .filter((p) => p.likeRate >= ROCKET_MIN_LIKES_PER_MIN)
    // newest first (so it feels live)
    .sort((a, b) => b.indexedAtMs - a.indexedAtMs)
    .map((p) => p.uri)

  // 3) Merge: rockets first, then Hot Classic (both already image-filtered for hot)
  // Dedupe while preserving order
  const seen = new Set<string>()
  const merged: string[] = []

  for (const uri of rocketUris) {
    if (!seen.has(uri)) {
      seen.add(uri)
      merged.push(uri)
    }
  }

  for (const uri of hotFilteredUris) {
    if (!seen.has(uri)) {
      seen.add(uri)
      merged.push(uri)
    }
  }

  return {
    feed: merged.slice(0, limit).map((uri) => ({ post: uri })),
    cursor: hotRes.data.cursor, // keep Hot Classic pagination behavior
  }
}
