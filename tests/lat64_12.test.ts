import { describe, expect, it } from 'vitest'
import { lat64Fn12 } from '../src/lib/lat64_12'

describe('lat64_12', () => {
  it('returns lat64-12', () => {
    expect(lat64Fn12()).toBe('lat64-12')
  })
})
