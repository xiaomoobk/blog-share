import { NotionAPI as NotionLibrary } from 'notion-client'
import BLOG from '@/blog.config'
import path from 'path'
import { RateLimiter } from './RateLimiter'

// 限流配置，打包编译阶段避免接口频繁，限制频率
const useRateLimiter = process.env.BUILD_MODE || process.env.EXPORT
const lockFilePath = path.resolve(process.cwd(), '.notion-api-lock')
const rateLimiter = new RateLimiter(200, lockFilePath)

const globalStore = { notion: null, inflight: new Map() }
const collectionEnrichment = new WeakMap()

function getRawNotion() {
  if (!globalStore.notion) {
    globalStore.notion = new NotionLibrary({
      apiBaseUrl: BLOG.API_BASE_URL || 'https://www.notion.so/api/v3',
      activeUser: BLOG.NOTION_ACTIVE_USER || null,
      authToken: BLOG.NOTION_TOKEN_V2 || null,
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      // notion-client 7.7 uses ofetch. Without a browser-like User-Agent,
      // Notion's edge responds 403 to the default Node agent even for public pages.
      ofetchOptions: {
        headers: {
          'User-Agent': 'NotionNext (+https://github.com/tangly1024/NotionNext)'
        }
      },
      kyOptions: {
        mode: 'cors',
        hooks: {
          beforeRequest: [
            (request) => {
              const url = request.url.toString()
              if (url.includes('/api/v3/syncRecordValues')) {
                return new Request(
                  url.replace('/api/v3/syncRecordValues', '/api/v3/syncRecordValuesMain'),
                  request
                )
              }
              return request
            }
          ]
        }
      }
    })
  }
  return globalStore.notion
}

async function callNotion(methodName, ...args) {
  const notion = getRawNotion()
  const original = notion[methodName]
  if (typeof original !== 'function') throw new Error(`${methodName} is not a function`)

  const key = `${methodName}-${JSON.stringify(args)}`

  if (globalStore.inflight.has(key)) return globalStore.inflight.get(key)

  const execute = async () => original.apply(notion, args)
  const promise = useRateLimiter
    ? rateLimiter.enqueue(key, execute)
    : execute()

  globalStore.inflight.set(key, promise)
  promise.finally(() => globalStore.inflight.delete(key))
  return promise
}

/**
 * Notion 现在把 block / collection_view 包成 { spaceId, value: { value } }。
 * notion-client 7.7 只认 value.type，于是跳过 queryCollection，构建只能拿到
 * 没有权限的 page_sort。这里在 getPage 之后补上集合查询。
 */
function unwrapRecordValue(record) {
  let current = record?.value ?? record
  for (let i = 0; i < 5 && current; i++) {
    if (
      current.type ||
      current.properties ||
      current.schema ||
      current.page_sort
    ) {
      return current
    }
    if (current.value && typeof current.value === 'object') {
      current = current.value
      continue
    }
    break
  }
  return current
}

const collectionQueryCache = new Map()

function findBlockRecord(recordMap, pageId) {
  if (!recordMap?.block || pageId == null) return null
  const raw = String(pageId)
  const compact = raw.replace(/-/g, '')
  const dashed =
    compact.length === 32
      ? [
          compact.slice(0, 8),
          compact.slice(8, 12),
          compact.slice(12, 16),
          compact.slice(16, 20),
          compact.slice(20)
        ].join('-')
      : raw
  return recordMap.block[raw] || recordMap.block[dashed] || recordMap.block[compact] || null
}

function loadCollectionData(notion, job) {
  const key = `${job.spaceId || ''}:${job.collectionId}:${job.collectionViewId}`
  if (!collectionQueryCache.has(key)) {
    collectionQueryCache.set(
      key,
      notion.getCollectionData(job.collectionId, job.collectionViewId, job.view, {
        limit: 999,
        spaceId: job.spaceId
      })
    )
  }
  return collectionQueryCache.get(key)
}

async function ensureCollectionQueries(recordMap, pageId) {
  if (!recordMap?.block) return recordMap
  if (collectionEnrichment.has(recordMap)) {
    return collectionEnrichment.get(recordMap)
  }

  const pending = (async () => {
    const notion = getRawNotion()
    recordMap.collection = recordMap.collection || {}
    recordMap.collection_view = recordMap.collection_view || {}
    recordMap.notion_user = recordMap.notion_user || {}
    recordMap.collection_query = recordMap.collection_query || {}

    const jobs = []
    const rootRecord = findBlockRecord(recordMap, pageId)
    const records = rootRecord ? [rootRecord] : []
    for (const record of records) {
      const block = unwrapRecordValue(record)
      if (
        block?.type !== 'collection_view_page' &&
        block?.type !== 'collection_view'
      ) {
        continue
      }
      const collectionId =
        block.collection_id || block.format?.collection_pointer?.id
      if (!collectionId) continue
      const spaceId = block.space_id || record?.spaceId
      for (const collectionViewId of block.view_ids || []) {
        if (recordMap.collection_query?.[collectionId]?.[collectionViewId]) {
          continue
        }
        jobs.push({
          collectionId,
          collectionViewId,
          spaceId,
          view: unwrapRecordValue(recordMap.collection_view?.[collectionViewId])
        })
      }
    }

    for (const job of jobs) {
      try {
        const collectionData = await loadCollectionData(notion, job)
        recordMap.block = {
          ...recordMap.block,
          ...(collectionData.recordMap?.block || {})
        }
        recordMap.collection = {
          ...recordMap.collection,
          ...(collectionData.recordMap?.collection || {})
        }
        recordMap.collection_view = {
          ...recordMap.collection_view,
          ...(collectionData.recordMap?.collection_view || {})
        }
        recordMap.notion_user = {
          ...recordMap.notion_user,
          ...(collectionData.recordMap?.notion_user || {})
        }
        recordMap.collection_query[job.collectionId] = {
          ...(recordMap.collection_query[job.collectionId] || {}),
          [job.collectionViewId]: collectionData.result?.reducerResults
        }
      } catch (err) {
        console.warn(
          'NotionAPI collectionQuery error',
          { collectionId: job.collectionId, collectionViewId: job.collectionViewId },
          err?.message || err
        )
      }
    }
    return recordMap
  })()

  collectionEnrichment.set(recordMap, pending)
  return pending
}

export const notionAPI = {
  getPage: async (pageId, ...args) => {
    const recordMap = await callNotion('getPage', pageId, ...args)
    return ensureCollectionQueries(recordMap, pageId)
  },
  getBlocks: (...args) => callNotion('getBlocks', ...args),
  getUsers: (...args) => callNotion('getUsers', ...args),
  __call: callNotion
}

export default notionAPI
