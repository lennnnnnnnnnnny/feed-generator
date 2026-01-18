import dotenv from 'dotenv'
import { AtpAgent, BlobRef, AppBskyFeedDefs } from '@atproto/api'
import { ids } from '../src/lexicon/lexicons'

const run = async () => {
  dotenv.config()

  // This pulls the info you typed into the Railway "Variables" tab
  const handle = process.env.FEEDGEN_HANDLE
  const password = process.env.FEEDGEN_PASSWORD
  const recordName = 'new-and-notable' // Change this to your feed's URL name
  const displayName = 'New and Notable'      // Change this to the name people see
  const description = 'English posts, 10+ likes, no images.' 
  const hostname = process.env.FEEDGEN_HOSTNAME

  if (!handle || !password || !hostname) {
    throw new Error('Missing variables! Check your Railway Variables tab for HANDLE, PASSWORD, and HOSTNAME.')
  }

  const feedGenDid = `did:web:${hostname}`
  const agent = new AtpAgent({ service: 'https://bsky.social' })
  
  await agent.login({ identifier: handle, password })

  await agent.api.com.atproto.repo.putRecord({
    repo: agent.session?.did ?? '',
    collection: ids.AppBskyFeedGenerator,
    rkey: recordName,
    record: {
      did: feedGenDid,
      displayName: displayName,
      description: description,
      createdAt: new Date().toISOString(),
      contentMode: AppBskyFeedDefs.CONTENTMODEUNSPECIFIED,
    },
  })

  console.log('All done 🎉 Your feed is published!')
}

run()
