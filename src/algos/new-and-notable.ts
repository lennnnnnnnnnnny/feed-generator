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

        // OG posts only (no replies)
        const isOriginal = !record.reply

        // Text-only (no embeds at all)
        const isTextOnly = !record.embed

        // Language: allow if explicitly English OR if langs is missing
        const langs = record.langs as string[] | undefined
        const isEnglishOrUnknown = !langs || langs.includes('en')

        // Phrase blacklist (edit as you like)
        const excludePhrases = ['diaper', 'big belly', 'abdl', 'ssbbw', 'feeder', 'feedee']
        const isClean = !excludePhrases.some((p) => text.includes(p))

        return isOriginal && isTextOnly && isEnglishOrUnknown && isClean
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

      console.log(`saved ${postsToCreate.length} posts`)
    }
  }
}
