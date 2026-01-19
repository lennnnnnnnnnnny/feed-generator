import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { handler as whatsAlfHandler } from './whats-alf'

// max 15 chars
export const shortname = 'new-and-notable'

export const handler = async (ctx: AppContext, params: QueryParams) => {
  return whatsAlfHandler(ctx, params)
}
