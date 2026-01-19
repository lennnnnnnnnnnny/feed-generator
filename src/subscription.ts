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
    const text = create.record.text.toLowerCase()
    
    // Check if it's a quote post
    // A quote post embeds a specific record (the post being quoted)
    const isQuote = create.record.embed?.$type === 'app.bsky.embed.record'
    
    // Your existing English and Clean checks
    const isEnglish = create.record.langs?.includes('en')
    const excludePhrases = ['diaper check', 'big belly']
    const isClean = !excludePhrases.some(phrase => text.includes(phrase))

    // Allow the post if it passes your clean/lang checks 
    // AND is either a regular post OR a quote post
    return isEnglish && isClean && (text.length > 0 || isQuote)
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
