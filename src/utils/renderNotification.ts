import { convertLexicalToHTML } from '@payloadcms/richtext-lexical/html'

import type { NotificationRuleShape, RenderedNotification } from '../types.js'

import { attemptAsync } from './attemptAsync.js'
import { decodeHtml, replaceTemplatePlaceholders } from './replaceTemplatePlaceholders.js'

export type RenderResult = { renderFailed: boolean } & RenderedNotification

/**
 * Renders a notification rule's subject and Lexical message against contextData.
 *
 * Returns `renderFailed: true` if Lexical → HTML conversion throws. Callers
 * must treat this as a hard error and not deliver blank-bodied notifications.
 */
export async function renderNotification(
  rule: NotificationRuleShape,
  contextData: Record<string, string>,
): Promise<RenderResult> {
  // Subject is delivered as plain text, so values are substituted verbatim.
  // The HTML body substitutes HTML-escaped values to prevent untrusted context
  // data from injecting markup or scripts.
  const replaceText = replaceTemplatePlaceholders(contextData)
  const replaceHtml = replaceTemplatePlaceholders(contextData, { escapeHtml: true })
  const subject = replaceText(rule.subject)

  if (!rule.message) {
    return { html: '', renderFailed: false, subject, text: '' }
  }

  const [htmlErr, rawHtml] = await attemptAsync(() =>
    Promise.resolve(
      convertLexicalToHTML({
        data: rule.message as Parameters<typeof convertLexicalToHTML>[0]['data'],
      }),
    ),
  )

  if (htmlErr || rawHtml == null) {
    return { html: '', renderFailed: true, subject, text: '' }
  }

  const html = replaceHtml(rawHtml)
  const text = decodeHtml(html.replace(/<[^>]*>/g, '')).trim()

  return { html, renderFailed: false, subject, text }
}
