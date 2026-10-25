import { describe, expect, it } from 'vitest'
import { lat64Fn25 } from '../src/lib/lat64_25'

describe('lat64_25', () => {
  it('returns lat64-25', () => {
    expect(lat64Fn25()).toBe('lat64-25')
  })
})
