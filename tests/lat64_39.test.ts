import { describe, expect, it } from 'vitest'
import { lat64Fn39 } from '../src/lib/lat64_39'

describe('lat64_39', () => {
  it('returns lat64-39', () => {
    expect(lat64Fn39()).toBe('lat64-39')
  })
})
