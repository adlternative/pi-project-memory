import { describe, expect, it } from 'vitest'
import { lat64Fn18 } from '../src/lib/lat64_18'

describe('lat64_18', () => {
  it('returns lat64-18', () => {
    expect(lat64Fn18()).toBe('lat64-18')
  })
})
