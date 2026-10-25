import { describe, expect, it } from 'vitest'
import { lat64Fn17 } from '../src/lib/lat64_17'

describe('lat64_17', () => {
  it("returns 'lat64-17'", () => {
    expect(lat64Fn17()).toBe('lat64-17')
  })
})
