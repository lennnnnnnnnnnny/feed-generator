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

    const postsToCreate = ops.posts.creates
      .filter((create) => {
        const record = create.record as any
        const text = (record.text ?? '').toLowerCase()

        // English only
        const isEnglish = record.langs?.includes('en')

        // OG posts only (no replies)
        const isOriginal = !record.reply

        // Text-only (blocks images, link cards, quote posts)
        const isTextOnly = !record.embed

        // Phrase blacklist
        const excludePhrases = ['diaper', 'belly', 'kink']
        const isClean = !excludePhrases.some((p) => text.includes(p))

        return isEnglish && isOriginal && isTextOnly && isClean
      })
      .map((create) => ({
        uri: create.uri,
        cid: create.cid,
        indexedAt: new Date().toISOString(),
      }))

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
