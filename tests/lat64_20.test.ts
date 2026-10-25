import { describe, expect, it } from 'vitest'
import { lat64Fn20 } from '../src/lib/lat64_20'

describe('lat64_20', () => {
  it('returns lat64-20', () => {
    expect(lat64Fn20()).toBe('lat64-20')
  })
})
