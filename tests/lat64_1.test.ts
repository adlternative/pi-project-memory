import { describe, expect, it } from 'vitest'
import { lat64Fn1 } from '../src/lib/lat64_1'

describe('lat64_1', () => {
  it('returns lat64-1', () => {
    expect(lat64Fn1()).toBe('lat64-1')
  })
})
