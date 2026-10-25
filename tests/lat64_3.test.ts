import { describe, expect, it } from 'vitest'
import { lat64Fn3 } from '../src/lib/lat64_3'

describe('lat64_3', () => {
  it('returns lat64-3', () => {
    expect(lat64Fn3()).toBe('lat64-3')
  })
})
