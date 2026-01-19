import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'

export class FirehoseSubscription extends FirehoseSubscriptionBase {
  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) return

    const ops = await getOpsByType(evt)

    const postsToDelete = ops.posts.deletes.map((del) => del.uri)

    const excludePhrases = ['diaper check', 'big belly']

    const postsToCreate = ops.posts.creates
      .filter((create) => {
        const record: any = create.record
        if (!record) return false

        // --- HARD NO: image posts ---
        const hasImages =
          record.embed?.$type === 'app.bsky.embed.images'
        if (hasImages) return false

        // --- Phrase blocklist ---
        const text = typeof record.text === 'string'
          ? record.text.toLowerCase()
          : ''

        const isClean = !excludePhrases.some((phrase) =>
          text.includes(phrase),
        )
        if (!isClean) return false

        // --- Allow ---
        // - original posts
        // - replies
        // - quote posts
        // - link cards
        return true
      })
      .map((create) => {
        const record: any = create.record

        return {
          uri: create.uri,
          cid: create.cid,

          // IMPORTANT: use actual post time if available
          indexedAt:
            typeof record.createdAt === 'string'
              ? record.createdAt
              : new Date().toISOString(),
        }
      })

    if (postsToDelete.length > 0) {
      await this.db
        .deleteFrom('post')
        .where('uri', 'in', postsToDelete)
        .execute()
    }

    if (postsToCreate.length > 0) {
      await this.db
        .insertInto('post')
        .values(postsToCreate)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  }
}
