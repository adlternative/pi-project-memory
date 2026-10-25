import { describe, expect, it } from 'vitest'
import { lat64Fn31 } from '../src/lib/lat64_31'

describe('lat64_31', () => {
  it('returns lat64-31', () => {
    expect(lat64Fn31()).toBe('lat64-31')
  })
})
