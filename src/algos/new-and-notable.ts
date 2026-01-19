import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { BskyAgent } from '@atproto/api'

export const shortname = 'new-and-notable'

const SOURCE_FEED_AT_URI =
  'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/hot-classic'
const SOURCE_LIMIT = 100

// PROOF MODE: make rockets trivially easy
const ROCKET_WINDOW_MINUTES = 10
const ROCKET_DB_LIMIT = 200
const ROCKET_MAX_URIS_TO_SCORE = 100 // still fetch likes so logs show we did work
const CHUNK_SIZE = 25

// PROOF MODE: force at least this many rockets to the top
const ROCKETS_TO_PREPEND = 10

const agent = new BskyAgent({
  service: process.env.FEEDGEN_APPVIEW_URL ?? 'https://api.bsky.app',
})

export const handler = async (ctx: AppContext, params: QueryParams) => {
  const limit = params.limit ?? 50
  const now = Date.now()

  // 1) Hot Classic (no images)
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
      const hasImages = record.embed?.$type === 'app.bsky.embed.images'
      return !hasImages
    })
    .map((item) => item.post.uri)

  // 2) DB candidates (these are our “rockets” for proof)
  const windowStartIso = new Date(now - ROCKET_WINDOW_MINUTES * 60_000).toISOString()

  const dbRows = await ctx.db
    .selectFrom('post')
    .selectAll()
    .where('indexedAt', '>=', windowStartIso)
    .orderBy('indexedAt', 'desc')
    .limit(ROCKET_DB_LIMIT)
    .execute()

  // Take the newest ones as "rockets"
  const rocketRows = dbRows.slice(0, ROCKETS_TO_PREPEND)
  const rocketUris = rocketRows.map((r) => r.uri)

  // Optional: still fetch likes for a subset so we can see counts in logs
  const scoreRows = dbRows.slice(0, ROCKET_MAX_URIS_TO_SCORE)
  const indexedAtByUri = new Map(scoreRows.map((r) => [r.uri, r.indexedAt]))
  const uris = scoreRows.map((r) => r.uri)

  const chunks: string[][] = []
  for (let i = 0; i < uris.length; i += CHUNK_SIZE) chunks.push(uris.slice(i, i + CHUNK_SIZE))

  const recentWithLikes: { uri: string; likeCount: number }[] = []
  for (const chunk of chunks) {
    const res = await agent.api.app.bsky.feed.getPosts({ uris: chunk })
    for (const p of res.data.posts) {
      recentWithLikes.push({ uri: p.uri, likeCount: p.likeCount ?? 0 })
    }
  }

  // DEBUG: show proof rockets + whether they overlap Hot Classic
  const hotSet = new Set(hotFilteredUris)
  const rocketOverlap = rocketUris.filter((u) => hotSet.has(u)).length

  console.log(
    JSON.stringify({
      PROOF_MODE: true,
      hotClassic_in: hotRes.data.feed.length,
      hotClassic_noImages: hotFilteredUris.length,
      dbCandidates: dbRows.length,
      rocketsChosen: rocketUris.length,
      rocketOverlapWithHotClassic: rocketOverlap,
      rocketsTop: rocketUris.slice(0, 5),
      scoredCandidates: recentWithLikes.length,
      scoredSample: recentWithLikes.slice(0, 5),
    }),
  )

  // 3) Merge with dedupe (rockets first, then Hot Classic)
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
    cursor: hotRes.data.cursor,
  }
}
