import { describe, it, expect } from 'vitest'
import { lat64Fn24 } from '../src/lib/lat64_24'

describe('lat64Fn24', () => {
  it('returns lat64-24', () => {
    expect(lat64Fn24()).toBe('lat64-24')
  })
})
