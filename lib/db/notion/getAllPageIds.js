import BLOG from '@/blog.config'

/**
 * 从 Notion collection 中取出页面 id。
 * 旧实现在 catch 里引用了 try 块内的 `ids`，Notion 数据结构对不上时
 * 会把原本可恢复的异常变成 ReferenceError: ids is not defined，导致 yarn export 失败。
 * @param {*} collectionQuery
 * @param {*} collectionId
 * @param {*} collectionView
 * @param {*} viewIds
 */
export default function getAllPageIds(
  collectionQuery,
  collectionId,
  collectionView,
  viewIds
) {
  const pageSet = new Set()
  const groupIndex = Number(BLOG.NOTION_INDEX) || 0
  const targetViewId = viewIds?.[groupIndex]

  const viewQuery = resolveViewQuery(collectionQuery, collectionId)
  const selectedViewData = getRecordById(viewQuery, targetViewId)
  let hasQueryData = false

  if (selectedViewData) {
    const { found, ids } = readBlockIds(selectedViewData)
    hasQueryData = found
    ids.forEach(id => pageSet.add(id))
  } else if (!targetViewId && viewQuery) {
    Object.values(viewQuery).forEach(viewData => {
      const { found, ids } = readBlockIds(viewData)
      if (found) hasQueryData = true
      ids.forEach(id => pageSet.add(id))
    })
  }

  // 选中视图没有查询结果时，才回退到 page_sort。
  // 查询结果显式为空表示视图过滤后没有文章，不能再把 page_sort 并进去。
  if (!hasQueryData) {
    const selectedPageSort = readPageSort(
      resolveViewEntry(collectionView, targetViewId)
    )
    if (selectedPageSort) {
      selectedPageSort.forEach(id => pageSet.add(id))
    }
  }

  if (pageSet.size === 0 && !hasQueryData && viewQuery) {
    Object.values(viewQuery).forEach(viewData => {
      readBlockIds(viewData).ids.forEach(id => pageSet.add(id))
    })
  }

  if (pageSet.size === 0 && !hasQueryData && collectionView) {
    Object.values(collectionView).forEach(viewEntry => {
      const pageSort = readPageSort(viewEntry)
      if (pageSort) pageSort.forEach(id => pageSet.add(id))
      if (viewEntry && typeof viewEntry === 'object') {
        Object.values(viewEntry).forEach(nested => {
          const nestedSort = readPageSort(nested)
          if (nestedSort) nestedSort.forEach(id => pageSet.add(id))
        })
      }
    })
  }

  return [...pageSet]
}

function readBlockIds(viewData) {
  if (!viewData || typeof viewData !== 'object') {
    return { found: false, ids: [] }
  }

  const ordered = [
    viewData.collection_group_results?.blockIds,
    viewData.reducerResults?.collection_group_results?.blockIds,
    viewData.results?.blockIds,
    viewData.blockIds
  ]
  const present = ordered.find(ids => Array.isArray(ids))
  if (!present) return { found: false, ids: [] }
  return { found: true, ids: present }
}

function readPageSort(viewEntry) {
  if (!viewEntry || typeof viewEntry !== 'object') return null
  const candidates = [
    viewEntry.value?.value?.page_sort,
    viewEntry.value?.page_sort,
    viewEntry.page_sort
  ]
  return candidates.find(ids => Array.isArray(ids)) || null
}

function resolveViewQuery(collectionQuery, collectionId) {
  const direct = getRecordById(collectionQuery, collectionId)
  if (direct) return direct
  if (!collectionQuery || typeof collectionQuery !== 'object') return null

  for (const value of Object.values(collectionQuery)) {
    const nested = getRecordById(value, collectionId)
    if (nested && typeof nested === 'object') return nested
  }
  return null
}

function resolveViewEntry(collectionView, viewId) {
  const direct = getRecordById(collectionView, viewId)
  if (direct) return direct
  if (!collectionView || !viewId || typeof collectionView !== 'object') {
    return null
  }
  for (const value of Object.values(collectionView)) {
    const nested = getRecordById(value, viewId)
    if (nested) return nested
  }
  return null
}

function getRecordById(record, id) {
  if (!record || id == null || typeof record !== 'object') return null
  for (const candidate of getIdCandidates(id)) {
    if (record[candidate]) return record[candidate]
  }
  return null
}

function getIdCandidates(id) {
  const raw = String(id)
  const compact = raw.replace(/-/g, '')
  return [...new Set([raw, compact, toUuid(compact)])]
}

function toUuid(compactId) {
  if (!/^[0-9a-fA-F]{32}$/.test(compactId)) return compactId
  return [
    compactId.slice(0, 8),
    compactId.slice(8, 12),
    compactId.slice(12, 16),
    compactId.slice(16, 20),
    compactId.slice(20)
  ].join('-')
}
