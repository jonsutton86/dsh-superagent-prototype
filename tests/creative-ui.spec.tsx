// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, all, tab, text, at } from './fixtures/panel.tsx'

usePanel()

it('renders the Creative workspace with its publish form and empty library state', async () => {
  at({ page: 'creative' })
  await mount()
  expect(tab(zh['tab.creative']).getAttribute('aria-selected')).toBe('true')
  expect(all('.dt-section-name').map(name => name.textContent)).toEqual([zh['creative.publish'], zh['creative.recent']])
  expect(all('label').map(label => label.textContent)).toEqual([zh['creative.title'], zh['creative.summary'], zh['creative.content']])
  expect(all('button').some(button => button.textContent === zh['creative.save'])).toBe(true)
  expect(text()).toContain(zh['creative.empty'])
})
