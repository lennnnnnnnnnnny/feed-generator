import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { BskyAgent } from '@atproto/api'

export const shortname = 'new-and-notable'

// ---- SOURCE FEED ----
const SOURCE_FEED_AT_URI =
  'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/hot-classic'
const SOURCE_LIMIT = 100

// ---- ROCKET TUNING ----
const ROCKET_WINDOW_MINUTES = 10
const ROCKET_DB_LIMIT = 300
const ROCKET_MIN_AGE_SECONDS = 30
const ROCKET_MAX_AGE_SECONDS = 600
const ROCKET_MIN_LIKES_PER_MIN = 0.6
const ROCKET_MAX_URIS_TO_SCORE = 150
const CHUNK_SIZE = 25

const agent = new BskyAgent({
  service: process.env.FEEDGEN_APPVIEW_URL ?? 'https://api.bsky.app',
})

export const handler = async (ctx: AppContext, params: QueryParams) => {
  const limit = params.limit ?? 50
  const now = Date.now()

  // 1) Pull Hot Classic
  const hotRes = await agent.api.app.bsky.feed.getFeed({
    feed: SOURCE_FEED_AT_URI,
    limit: SOURCE_LIMIT,
    cursor: params.cursor,
  })

  const hotFilteredUris = hotRes.data.feed
    .filter((item) => {
      const post = item.post
      if (!post || !post.record) return false
      const record = post.record as any
      const hasImages =
        record.embed?.$type === 'app.bsky.embed.images'
      return !hasImages
    })
    .map((item) => item.post.uri)

  // 2) Rocket candidates from DB
  const windowStartIso = new Date(
    now - ROCKET_WINDOW_MINUTES * 60_000,
  ).toISOString()

  const dbRows = await ctx.db
    .selectFrom('post')
    .selectAll()
    .where('indexedAt', '>=', windowStartIso)
    .orderBy('indexedAt', 'desc')
    .limit(ROCKET_DB_LIMIT)
    .execute()

  const newestRows = dbRows.slice(0, ROCKET_MAX_URIS_TO_SCORE)
  const indexedAtByUri = new Map(
    newestRows.map((r) => [r.uri, r.indexedAt]),
  )

  const uris = newestRows.map((r) => r.uri)

  const chunks: string[][] = []
  for (let i = 0; i < uris.length; i += CHUNK_SIZE) {
    chunks.push(uris.slice(i, i + CHUNK_SIZE))
  }

  const scored: {
    uri: string
    likeCount: number
    ageSeconds: number
    likeRate: number
    indexedAtMs: number
  }[] = []

  for (const chunk of chunks) {
    const res = await agent.api.app.bsky.feed.getPosts({ uris: chunk })
    for (const p of res.data.posts) {
      const indexedAt = indexedAtByUri.get(p.uri)
      if (!indexedAt) continue

      const indexedAtMs = Date.parse(indexedAt)
      const ageSeconds = (now - indexedAtMs) / 1000
      const ageMinutes = ageSeconds / 60
      const likeRate =
        ageMinutes > 0 ? (p.likeCount ?? 0) / ageMinutes : 0

      scored.push({
        uri: p.uri,
        likeCount: p.likeCount ?? 0,
        ageSeconds,
        likeRate,
        indexedAtMs,
      })
    }
  }

  const rockets = scored
    .filter((p) => p.ageSeconds >= ROCKET_MIN_AGE_SECONDS)
    .filter((p) => p.ageSeconds <= ROCKET_MAX_AGE_SECONDS)
    .filter((p) => p.likeRate >= ROCKET_MIN_LIKES_PER_MIN)
    .sort((a, b) => b.likeRate - a.likeRate)

  // ---- DEBUG (keep this!) ----
  console.log(
    JSON.stringify({
      hotClassic_in: hotRes.data.feed.length,
      hotClassic_noImages: hotFilteredUris.length,
      dbCandidates: dbRows.length,
      scoredCandidates: scored.length,
      rocketsQualified: rockets.length,
      rocketsSample: rockets.slice(0, 3).map((r) => ({
        likes: r.likeCount,
        ageSec: Math.round(r.ageSeconds),
        ratePerMin: Number(r.likeRate.toFixed(2)),
      })),
    }),
  )

  // 3) Merge rockets first, then hot classic
  const seen = new Set<string>()
  const merged: string[] = []

  for (const r of rockets) {
    if (!seen.has(r.uri)) {
      seen.add(r.uri)
      merged.push(r.uri)
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
    cursor: hotRes.data.cursor,
  }
}
