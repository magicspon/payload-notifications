/** Extract a string ID from a Payload relationship field (string | { id? } | null). */
export function extractId(
  value: { id?: number | string } | null | number | string | undefined,
): string | undefined {
  if (!value) {return undefined}
  if (typeof value === 'string') {return value}
  if (typeof value === 'number') {return String(value)}
  if (typeof value === 'object' && value.id != null) {return String(value.id)}
  return undefined
}
