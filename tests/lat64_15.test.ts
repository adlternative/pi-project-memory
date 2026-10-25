import { describe, expect, it } from 'vitest'
import { lat64Fn15 } from '../src/lib/lat64_15'

describe('lat64_15', () => {
  it('returns lat64-15', () => {
    expect(lat64Fn15()).toBe('lat64-15')
  })
})
