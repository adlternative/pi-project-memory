import { describe, expect, it } from 'vitest'
import { lat64Fn35 } from '../src/lib/lat64_35'

describe('lat64_35', () => {
  it('returns lat64-35', () => {
    expect(lat64Fn35()).toBe('lat64-35')
  })
})
