import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { BskyAgent } from '@atproto/api'

const MIN_LIKES = 12
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

  const qualified = postsWithLikes
    .filter((p) => p.likeCount >= MIN_LIKES)
    .sort((a, b) => b.likeCount - a.likeCount)

  const limit = params.limit ?? 50
  const feed = qualified.slice(0, limit).map((p) => ({ post: p.uri }))

  return { feed }
}
