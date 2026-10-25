import { describe, expect, it } from 'vitest'
import { lat64Fn16 } from '../src/lib/lat64_16'

describe('lat64_16', () => {
  it('returns lat64-16', () => {
    expect(lat64Fn16()).toBe('lat64-16')
  })
})
