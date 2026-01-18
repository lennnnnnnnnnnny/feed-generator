import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'

export class FirehoseSubscription extends FirehoseSubscriptionBase {
  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) return

    const ops = await getOpsByType(evt)

    // 1. Identify posts to delete from your local database
    const postsToDelete = ops.posts.deletes.map((del) => del.uri)

    // 2. Identify and filter new posts based on your specific rules
    const postsToCreate = ops.posts.creates
      .filter((create) => {
        const text = create.record.text.toLowerCase()
        
        // Rule: Language must be English
        const isEnglish = create.record.langs?.includes('en')

        // Rule: Must NOT have images
        // This checks if the post has an 'embed' property of type 'images'
        const hasImages = create.record.embed?.$type === 'app.bsky.embed.images'
        const isImageFree = !hasImages

        // Rule: Exclude specific "kink" phrases to keep the feed clean
        const excludePhrases = ['diaper check', 'big belly']
        const isClean = !excludePhrases.some(phrase => text.includes(phrase))

        // Only save the post if it passes all three tests
        return isEnglish && isImageFree && isClean
      })
      .map((create) => {
        // Map the filtered posts to your database format
        return {
          uri: create.uri,
          cid: create.cid,
          indexedAt: new Date().toISOString(),
        }
      })

    // 3. Update your database
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
