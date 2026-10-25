import { describe, expect, it } from 'vitest'
import { lat64Fn26 } from '../src/lib/lat64_26'

describe('lat64_26', () => {
  it('returns lat64-26', () => {
    expect(lat64Fn26()).toBe('lat64-26')
  })
})
