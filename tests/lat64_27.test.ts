import { describe, expect, it } from 'vitest'
import { lat64Fn27 } from '../src/lib/lat64_27'

describe('lat64_27', () => {
  it('returns lat64-27', () => {
    expect(lat64Fn27()).toBe('lat64-27')
  })
})
