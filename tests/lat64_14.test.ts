import { describe, expect, it } from 'vitest'
import { lat64Fn14 } from '../src/lib/lat64_14'

describe('lat64_14', () => {
  it('returns lat64-14', () => {
    expect(lat64Fn14()).toBe('lat64-14')
  })
})
