import { describe, expect, test } from 'vitest'

import { replaceTemplatePlaceholders } from './replaceTemplatePlaceholders.js'

describe('replaceTemplatePlaceholders', () => {
  test('replaces a single token', () => {
    const replace = replaceTemplatePlaceholders({ name: 'Alice' })
    expect(replace('Hello {{name}}')).toBe('Hello Alice')
  })

  test('replaces multiple tokens', () => {
    const replace = replaceTemplatePlaceholders({ first: 'Alice', last: 'Smith' })
    expect(replace('{{first}} {{last}}')).toBe('Alice Smith')
  })

  test('replaces repeated tokens', () => {
    const replace = replaceTemplatePlaceholders({ x: 'A' })
    expect(replace('{{x}} and {{x}}')).toBe('A and A')
  })

  test('replaces missing keys with empty string', () => {
    const replace = replaceTemplatePlaceholders({})
    expect(replace('Hello {{name}}')).toBe('Hello ')
  })

  test('leaves non-token text unchanged', () => {
    const replace = replaceTemplatePlaceholders({ name: 'Alice' })
    expect(replace('No tokens here')).toBe('No tokens here')
  })

  test('handles empty template', () => {
    const replace = replaceTemplatePlaceholders({ name: 'Alice' })
    expect(replace('')).toBe('')
  })

  test('handles empty data map', () => {
    const replace = replaceTemplatePlaceholders({})
    expect(replace('{{a}} {{b}}')).toBe(' ')
  })
})
