import { describe, expect, test } from 'vitest'

import type { FieldConditions } from '../types.js'

import { evaluateFieldConditions } from './evaluateFieldConditions.js'

const prev = { name: 'Alice', empty: '', score: '5', status: 'draft' }
const curr = { name: 'Alice', empty: '', score: '10', status: 'published' }

function make(conditions: FieldConditions['conditions'], logic: FieldConditions['logic'] = 'and'): FieldConditions {
  return { conditions, logic }
}

describe('evaluateFieldConditions — and logic', () => {
  test('empty conditions returns true', () => {
    expect(evaluateFieldConditions(make([]), prev, curr)).toBe(true)
  })

  test('equals — matches current value', () => {
    expect(
      evaluateFieldConditions(make([{ field: 'status', operator: 'equals', value: 'published' }]), prev, curr),
    ).toBe(true)
  })

  test('equals — does not match', () => {
    expect(
      evaluateFieldConditions(make([{ field: 'status', operator: 'equals', value: 'draft' }]), prev, curr),
    ).toBe(false)
  })

  test('not_equals', () => {
    expect(
      evaluateFieldConditions(make([{ field: 'status', operator: 'not_equals', value: 'draft' }]), prev, curr),
    ).toBe(true)
  })

  test('contains', () => {
    expect(
      evaluateFieldConditions(make([{ field: 'status', operator: 'contains', value: 'pub' }]), prev, curr),
    ).toBe(true)
  })

  test('not_contains', () => {
    expect(
      evaluateFieldConditions(make([{ field: 'status', operator: 'not_contains', value: 'xyz' }]), prev, curr),
    ).toBe(true)
  })

  test('greater_than', () => {
    expect(
      evaluateFieldConditions(make([{ field: 'score', operator: 'greater_than', value: 5 }]), prev, curr),
    ).toBe(true)
  })

  test('less_than', () => {
    expect(
      evaluateFieldConditions(make([{ field: 'score', operator: 'less_than', value: 5 }]), prev, curr),
    ).toBe(false)
  })

  test('changed — field did change', () => {
    expect(
      evaluateFieldConditions(make([{ field: 'status', operator: 'changed' }]), prev, curr),
    ).toBe(true)
  })

  test('changed — field did not change', () => {
    expect(
      evaluateFieldConditions(make([{ field: 'name', operator: 'changed' }]), prev, curr),
    ).toBe(false)
  })

  test('not_changed — field did not change', () => {
    expect(
      evaluateFieldConditions(make([{ field: 'name', operator: 'not_changed' }]), prev, curr),
    ).toBe(true)
  })

  test('is_empty — empty string is empty', () => {
    expect(
      evaluateFieldConditions(make([{ field: 'empty', operator: 'is_empty' }]), prev, curr),
    ).toBe(true)
  })

  test('is_empty — non-empty string is not empty', () => {
    expect(
      evaluateFieldConditions(make([{ field: 'status', operator: 'is_empty' }]), prev, curr),
    ).toBe(false)
  })

  test('is_not_empty — non-empty value', () => {
    expect(
      evaluateFieldConditions(make([{ field: 'name', operator: 'is_not_empty' }]), prev, curr),
    ).toBe(true)
  })

  test('all conditions must pass for and logic', () => {
    expect(
      evaluateFieldConditions(
        make([
          { field: 'status', operator: 'equals', value: 'published' },
          { field: 'score', operator: 'greater_than', value: 5 },
        ]),
        prev,
        curr,
      ),
    ).toBe(true)
  })

  test('and logic fails when one condition fails', () => {
    expect(
      evaluateFieldConditions(
        make([
          { field: 'status', operator: 'equals', value: 'published' },
          { field: 'score', operator: 'less_than', value: 5 },
        ]),
        prev,
        curr,
      ),
    ).toBe(false)
  })
})

describe('evaluateFieldConditions — or logic', () => {
  test('passes when at least one condition matches', () => {
    expect(
      evaluateFieldConditions(
        make(
          [
            { field: 'status', operator: 'equals', value: 'draft' },
            { field: 'status', operator: 'equals', value: 'published' },
          ],
          'or',
        ),
        prev,
        curr,
      ),
    ).toBe(true)
  })

  test('fails when no condition matches', () => {
    expect(
      evaluateFieldConditions(
        make(
          [
            { field: 'status', operator: 'equals', value: 'draft' },
            { field: 'status', operator: 'equals', value: 'archived' },
          ],
          'or',
        ),
        prev,
        curr,
      ),
    ).toBe(false)
  })
})
