import getAllPageIds from '@/lib/db/notion/getAllPageIds'

describe('getAllPageIds', () => {
  it('does not throw ReferenceError when the collection id is missing', () => {
    expect(() => getAllPageIds({}, 'collection_1', {}, ['view_1'])).not.toThrow()
    expect(getAllPageIds({}, 'collection_1', {}, ['view_1'])).toEqual([])
  })

  it('reads legacy collection_group_results block ids', () => {
    const pageIds = getAllPageIds(
      {
        collection_1: {
          view_1: {
            collection_group_results: { blockIds: ['page_1', 'page_2'] }
          }
        }
      },
      'collection_1',
      {},
      ['view_1']
    )

    expect(pageIds).toEqual(['page_1', 'page_2'])
  })

  it('reads reducerResults and direct notion-client reducer payloads', () => {
    expect(
      getAllPageIds(
        {
          collection_1: {
            view_1: {
              reducerResults: {
                collection_group_results: { blockIds: ['page_1', 'page_2'] }
              }
            }
          }
        },
        'collection_1',
        {},
        ['view_1']
      )
    ).toEqual(['page_1', 'page_2'])

    expect(
      getAllPageIds(
        {
          collection_1: {
            view_1: {
              collection_group_results: { blockIds: ['page_3'] }
            }
          }
        },
        'collection_1',
        {},
        ['view_1']
      )
    ).toEqual(['page_3'])
  })

  it('does not merge page_sort when the selected view query is explicitly empty', () => {
    const pageIds = getAllPageIds(
      {
        collection_1: {
          view_1: {
            collection_group_results: { blockIds: [] },
            reducerResults: {
              collection_group_results: { blockIds: ['filtered_out_page'] }
            }
          }
        }
      },
      'collection_1',
      {
        view_1: {
          value: { value: { page_sort: ['filtered_out_page'] } }
        }
      },
      ['view_1']
    )

    expect(pageIds).toEqual([])
  })

  it('falls back to nested page_sort and matches ids with or without dashes', () => {
    const collectionId = '02ab3b86-7800-4aa6-9e9e-415905ef32a5'
    const compactId = collectionId.replace(/-/g, '')

    expect(
      getAllPageIds(
        {},
        collectionId,
        {
          view_1: {
            value: { page_sort: ['sorted_page'] }
          }
        },
        ['view_1']
      )
    ).toEqual(['sorted_page'])

    expect(
      getAllPageIds(
        {
          [compactId]: {
            view_1: {
              collection_group_results: { blockIds: ['dashed_match'] }
            }
          }
        },
        collectionId,
        {},
        ['view_1']
      )
    ).toEqual(['dashed_match'])
  })
})
