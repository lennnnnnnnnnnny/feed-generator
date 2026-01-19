import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'

const MIN_LIKES = 12

export const shortname = 'new-and-notable'

export const handler = async (ctx: AppContext, params: QueryParams) => {
  // Pull recent candidates from DB
  const rows = await ctx.db
    .selectFrom('post')
    .selectAll()
    .orderBy('indexedAt', 'desc')
    .limit(100)
    .execute()

  if (rows.length === 0) {
    return { feed: [] }
  }

  // Ask AppView for engagement stats
  const res = await ctx.appview.api.app.bsky.feed.getPosts({
    uris: rows.map((r) => r.uri),
  })

  const qualified = res.data.posts
    .filter((p) => (p.likeCount ?? 0) >= MIN_LIKES)
    .sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0))

  const feed = qualified.map((p) => ({
    post: p.uri,
  }))

  return {
    feed,
    cursor: undefined,
  }
}
