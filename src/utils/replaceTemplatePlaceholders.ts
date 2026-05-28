export type ReplaceOptions = {
  /** HTML-escape substituted values to prevent markup/script injection. */
  escapeHtml?: boolean
}

/**
 * Returns a function that replaces `{{key}}` tokens in a string using the
 * provided data map. Missing keys are replaced with an empty string.
 *
 * When `escapeHtml` is set, substituted values are HTML-escaped so that
 * untrusted context data cannot inject markup or scripts into rendered HTML.
 */
export function replaceTemplatePlaceholders(
  data: Record<string, string>,
  options: ReplaceOptions = {},
): (template: string) => string {
  const transform = options.escapeHtml ? escapeHtml : (v: string) => v

  return (template: string) =>
    template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => transform(data[key] ?? ''))
}

/** Escape the five characters that are significant in HTML text/attribute context. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Decode the basic HTML entities produced by {@link escapeHtml} back to text. */
export function decodeHtml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}
