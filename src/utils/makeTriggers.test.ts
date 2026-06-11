import { describe, expect, test } from 'vitest'

import { makeTriggers } from './makeTriggers.js'

describe('makeTriggers', () => {
  test('generates three triggers for a slug', () => {
    const triggers = makeTriggers('submissions')
    expect(triggers).toHaveLength(3)
  })

  test('created trigger has correct value', () => {
    const [created] = makeTriggers('submissions')
    expect(created.value).toBe('submissions.created')
    expect(created.supportsFieldConditions).toBeUndefined()
  })

  test('updated trigger has correct value', () => {
    const [, updated] = makeTriggers('submissions')
    expect(updated.value).toBe('submissions.updated')
  })

  test('field_changed trigger has supportsFieldConditions', () => {
    const [, , fieldChanged] = makeTriggers('submissions')
    expect(fieldChanged.value).toBe('submissions.field_changed')
    expect(fieldChanged.supportsFieldConditions).toBe(true)
  })

  test('label is capitalised from slug', () => {
    const [created] = makeTriggers('submissions')
    expect(created.label).toBe('Submissions Created')
  })

  test('hyphenated slug produces readable label', () => {
    const [created] = makeTriggers('form-submissions')
    expect(created.label).toBe('Form submissions Created')
    expect(created.value).toBe('form-submissions.created')
  })
})
