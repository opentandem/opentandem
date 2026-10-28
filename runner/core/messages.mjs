// Runner text is written in English: t('Codex could not load the session: {detail}', { detail }).
// Users are currently shown the Chinese wording, so every template maps to it through
// locales/messages.zh.json (keys are the English templates). When you add or change a t(...)
// template, add the matching entry there; tests/runner-adapters.test.ts checks that every
// adapter template has one.
import messagesZh from './locales/messages.zh.json' with { type: 'json' }

export const ADAPTER_MESSAGES_ZH = messagesZh

export function createAdapterTranslator(table = ADAPTER_MESSAGES_ZH) {
  return (template, params = {}) => {
    const text = Object.prototype.hasOwnProperty.call(table, template) ? table[template] : template
    return text.replace(/\{(\w+)\}/g, (all, key) => (Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : all))
  }
}
