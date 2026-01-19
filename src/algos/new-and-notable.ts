import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { BskyAgent } from '@atproto/api'

export const shortname = 'new-and-notable'

// Hot Classic feed AT URI
const SOURCE_FEED_AT_URI =
  'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/hot-classic'

// Ask for more than we need so filtering doesn’t empty the feed
const SOURCE_LIMIT = 100

const agent = new BskyAgent({
  service: process.env.FEEDGEN_APPVIEW_URL ?? 'https://api.bsky.app',
})

export const handler = async (_ctx: AppContext, params: QueryParams) => {
  const limit = params.limit ?? 50

  // Fetch Hot Classic
  const res = await agent.api.app.bsky.feed.getFeed({
    feed: SOURCE_FEED_AT_URI,
    limit: SOURCE_LIMIT,
    cursor: params.cursor,
  })

  // Filter out ONLY posts with image embeds
  const filtered = res.data.feed.filter((item) => {
    const post = item.post

    // Safety: only process posts
    if (!post || !post.record) return false

    const record = post.record as any

    // Exclude image embeds only
    const hasImages =
      record.embed?.$type === 'app.bsky.embed.images'

    return !hasImages
  })

  return {
    feed: filtered.slice(0, limit).map((item) => ({
      post: item.post.uri,
    })),
    cursor: res.data.cursor,
  }
}
