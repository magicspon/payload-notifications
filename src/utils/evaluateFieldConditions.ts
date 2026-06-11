import type { FieldCondition, FieldConditions } from '../types.js'

/**
 * Resolves a field value, supporting dot-notation paths for nested objects
 * (e.g. `address.city`). Returns `undefined` if any segment is missing.
 */
function getFieldValue(doc: Record<string, unknown>, field: string): unknown {
  if (!field.includes('.')) {return doc[field]}

  let current: unknown = doc
  for (const segment of field.split('.')) {
    if (current == null || typeof current !== 'object') {return undefined}
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

function evaluateCondition(
  condition: FieldCondition,
  previousDoc: Record<string, unknown>,
  currentDoc: Record<string, unknown>,
): boolean {
  const { field, operator, value } = condition
  const current = getFieldValue(currentDoc, field)
  const previous = getFieldValue(previousDoc, field)

  switch (operator) {
    case 'changed':
      return current !== previous

    case 'contains':
      return typeof current === 'string' && current.includes(String(value ?? ''))

    case 'equals':
      return String(current) === String(value ?? '')

    case 'greater_than':
      return Number(current) > Number(value ?? 0)

    case 'is_empty':
      return isEmpty(current)

    case 'is_not_empty':
      return !isEmpty(current)

    case 'less_than':
      return Number(current) < Number(value ?? 0)

    case 'not_changed':
      return current === previous

    case 'not_contains':
      return typeof current === 'string' && !current.includes(String(value ?? ''))

    case 'not_equals':
      return String(current) !== String(value ?? '')

    default:
      return false
  }
}

/**
 * Evaluates a `fieldConditions` JSON object against the previous and current
 * document state. Returns `true` when all conditions pass (for `and` logic)
 * or at least one passes (for `or` logic).
 *
 * An empty conditions array always returns `true`.
 */
export function evaluateFieldConditions(
  fieldConditions: FieldConditions,
  previousDoc: Record<string, unknown>,
  currentDoc: Record<string, unknown>,
): boolean {
  const { conditions, logic } = fieldConditions

  if (!conditions || conditions.length === 0) {return true}

  if (logic === 'or') {
    return conditions.some((c) => evaluateCondition(c, previousDoc, currentDoc))
  }

  return conditions.every((c) => evaluateCondition(c, previousDoc, currentDoc))
}
