import { describe, expect, it } from 'vitest'
import { lat64Fn57 } from '../src/lib/lat64_57'

describe('lat64_57', () => {
  it('returns lat64-57', () => {
    expect(lat64Fn57()).toBe('lat64-57')
  })
})
