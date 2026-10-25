import { describe, expect, it } from 'vitest'
import { lat64Fn28 } from '../src/lib/lat64_28'

describe('lat64_28', () => {
  it('returns lat64-28', () => {
    expect(lat64Fn28()).toBe('lat64-28')
  })
})
