import { describe, expect, it } from 'vitest'
import { lat64Fn34 } from '../src/lib/lat64_34'

describe('lat64_34', () => {
  it('returns lat64-34', () => {
    expect(lat64Fn34()).toBe('lat64-34')
  })
})
