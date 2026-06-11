import type { CollectionConfig } from 'payload'

import type { CollectionOverride } from '../types.js'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Merges the collection `hooks` maps, concatenating each hook array so the
 * plugin's own hooks are preserved alongside host-app additions.
 */
function mergeHooks(
  base: Record<string, unknown> = {},
  override: Record<string, unknown> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(override)) {
    const baseArr = Array.isArray(base[key]) ? (base[key] as unknown[]) : []
    const overrideArr = Array.isArray(value) ? value : []
    result[key] = [...baseArr, ...overrideArr]
  }

  return result
}

/**
 * Merges host-app overrides into a base CollectionConfig.
 *
 * - Extra `fields` are appended after the base fields.
 * - `hooks` are merged by concatenating each hook array (plugin hooks run first).
 * - Nested plain-object keys (`admin`, `access`, etc.) are shallow-merged so
 *   partial overrides do not wipe out the base configuration.
 * - All other keys overwrite the base.
 */
export function mergeCollection(
  base: CollectionConfig,
  override?: CollectionOverride,
): CollectionConfig {
  if (!override) {return base}

  const { fields: extraFields = [], hooks: overrideHooks, ...rest } = override as {
    fields?: CollectionConfig['fields']
  } & Record<string, unknown>

  const merged: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(rest)) {
    const baseValue = (base as Record<string, unknown>)[key]
    merged[key] =
      isPlainObject(baseValue) && isPlainObject(value)
        ? { ...baseValue, ...value }
        : value
  }

  merged.fields = [...base.fields, ...extraFields]

  if (overrideHooks) {
    merged.hooks = mergeHooks(
      base.hooks as Record<string, unknown> | undefined,
      overrideHooks as Record<string, unknown>,
    )
  }

  return merged as CollectionConfig
}
