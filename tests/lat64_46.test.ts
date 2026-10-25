import { describe, expect, it } from 'vitest'
import { lat64Fn46 } from '../src/lib/lat64_46'

describe('lat64Fn46', () => {
  it("returns 'lat64-46'", () => {
    expect(lat64Fn46()).toBe('lat64-46')
  })
})
