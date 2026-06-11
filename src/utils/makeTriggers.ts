import type { TriggerDefinition } from '../types.js'

/**
 * Generates a standard set of trigger definitions for a given collection slug.
 *
 * @example
 * makeTriggers('submissions')
 * // [
 * //   { label: 'Submission Created', value: 'submissions.created' },
 * //   { label: 'Submission Updated', value: 'submissions.updated' },
 * //   { label: 'Submission Field Changed', value: 'submissions.field_changed', supportsFieldConditions: true },
 * // ]
 */
export function makeTriggers(slug: string): TriggerDefinition[] {
  const label = slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, ' ')

  return [
    { label: `${label} Created`, value: `${slug}.created` },
    { label: `${label} Updated`, value: `${slug}.updated` },
    {
      label: `${label} Field Changed`,
      supportsFieldConditions: true,
      value: `${slug}.field_changed`,
    },
  ]
}
