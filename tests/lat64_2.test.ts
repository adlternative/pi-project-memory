import { describe, expect, it } from 'vitest'
import { lat64Fn2 } from '../src/lib/lat64_2'

describe('lat64_2', () => {
  it('returns lat64-2', () => {
    expect(lat64Fn2()).toBe('lat64-2')
  })
})
