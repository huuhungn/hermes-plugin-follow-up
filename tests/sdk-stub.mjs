// SDK boundary double, NOT a Hermes core/composer integration harness.
import { createElement } from 'react'

export const calls = []
export const haptics = []
let bundles = {}
let insert = () => Promise.resolve(true)
let submit = () => true

export function resetSdk() {
  calls.length = 0
  haptics.length = 0
  insert = () => Promise.resolve(true)
  submit = () => true
}

export function setComposer({ insertText, submit: send } = {}) {
  if (insertText) insert = insertText
  if (send) submit = send
}

export function registerTranslations(value) { bundles = value }
export const usePluginI18n = () => key => bundles.en?.[key] ?? key
export const cn = (...parts) => parts.filter(Boolean).join(' ')
export const haptic = value => haptics.push(value)
export const Codicon = ({ name, size, style, ...props }) => createElement('i', {
  ...props, 'aria-hidden': true, 'data-icon': name,
  style: { ...(size ? { fontSize: size } : {}), ...style }
})
export const Tip = ({ children }) => children
export const host = {
  composer: {
    insertText(...args) {
      calls.push({ method: 'insertText', args })
      return insert(...args)
    },
    submit(...args) {
      calls.push({ method: 'submit', args })
      return submit(...args)
    }
  }
}
