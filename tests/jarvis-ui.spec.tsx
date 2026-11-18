// @vitest-environment jsdom
// The read-only JARVIS dashboard.
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { parseRoute } from '../src/client/route.ts'
import { usePanel, mount, all, tab, text, at } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const SECTIONS = ['overview', 'memory', 'agents', 'goals', 'connections', 'analytics', 'voice'] as const
const titles = SECTIONS.map(section => zh[`jarvis.section.${section}`])
// The prefix the unavailable hint renders before the endpoint's own message.
const UNAVAILABLE = zh['jarvis.unavailable'].replace('{error}', '')

it('renders the seven read-only sections on the JARVIS tab from the existing views', async () => {
  at({ page: 'jarvis' })
  await mount()
  expect(parseRoute({ page: 'jarvis' })).toEqual({ page: 'jarvis' })
  expect(tab(zh['tab.jarvis']).getAttribute('aria-selected')).toBe('true')
  expect(all('.dt-section-name').map(name => name.textContent)).toEqual(titles)
  expect(all('[data-jarvis]').map(area => area.getAttribute('data-jarvis'))).toEqual([...SECTIONS])
  expect(text()).toContain(zh['jarvis.intro'])
  const actions = all('[data-assistant-actions] button').map(button => button.textContent)
  expect(actions).toEqual([zh['inbox.new'], zh['mission.new'], zh['openMaster'], zh['pauseProcessing']])
  const pause = all('[data-assistant-actions] button').find(button => button.textContent === zh['pauseProcessing'])!
  await act(async () => { pause.click() })
  expect(text()).toContain(zh['pauseProcessingConfirm'])
  // The overview shows the host's own counts, taken from the overview endpoint.
  expect(all('[data-jarvis="overview"] .dt-stat').map(stat => stat.textContent)).toEqual([
    `${zh.pendingTickets}2`, `${zh.problems}2`, `${zh.executingLabel}2 / 3`, `${zh.queuedLabel}0`,
    `${zh.flowReceivedLabel}12`, `${zh.flowJudgedLabel}5`, `${zh.flowAcceptedLabel}1`])
  // Agents mirror the ordinary state poll: Executor load and the main Session, no more.
  expect(all('[data-jarvis="agents"] .dt-kv dd').map(value => value.textContent)).toEqual(['2 / 3', '0', '3', 'master'])
  // Empty views say so instead of inventing records.
  expect(text()).toContain(zh['jarvis.memoryEmpty'])
  expect(text()).toContain(zh['jarvis.goalsEmpty'])
  expect(text()).toContain(zh['jarvis.providersEmpty'])
  expect(text()).toContain(zh['jarvis.credentialsEmpty'])
  expect(all('[data-jarvis="memory"] .dt-row')).toEqual([])
  expect(all('[data-jarvis="goals"] .dt-row')).toEqual([])
  // An endpoint that refuses is named unavailable; its fixture refuses analytics.
  expect(all('[data-jarvis="analytics"]').at(0)!.textContent).toContain(UNAVAILABLE)
  expect(text()).toContain('Usage fixture not configured')
  // Voice reports configuration only; absent input and output are named.
  const voiceValues = all('[data-jarvis="voice"] .dt-kv dd').map(value => value.textContent)
  expect(voiceValues.slice(0, 3)).toEqual([zh['jarvis.voiceOff'], zh['jarvis.voiceOff'], '0'])
  expect(voiceValues).toHaveLength(8)
  expect(text()).toContain(zh['jarvis.voiceBrowserNote'])
  // Nothing on this page claims verification.
  expect(text()).toContain(zh['jarvis.notVerified'])
  expect(text()).toContain(zh['jarvis.voiceNote'])
  // Every read-only section offers a navigation escape hatch; analytics exposes a period selector.
  expect(all('button').filter(button => button.textContent === zh['jarvis.openAll'])).toHaveLength(6)
  const period = all('select')[0]!
  expect(period.getAttribute('aria-label')).toBe(zh['jarvis.periodLabel'])
  expect(all('option').map(option => option.textContent)).toEqual([
    zh['jarvis.periodDay'], zh['jarvis.periodMonth'], zh['jarvis.periodAll']])
  expect(zh['jarvis.intro']).toContain('不验证')
  // Read-only: the page issued GET requests only.
  expect(server.requests.length).toBeGreaterThan(0)
  expect(server.requests.every(request => request.method === 'GET')).toBe(true)
})

it('names each section unavailable instead of inventing values when the host is not answering', async () => {
  server.down = true
  at({ page: 'jarvis' })
  await mount()
  expect(tab(zh['tab.jarvis']).getAttribute('aria-selected')).toBe('true')
  const areas = all('[data-jarvis]')
  expect(areas.map(area => area.getAttribute('data-jarvis'))).toEqual([...SECTIONS])
  for (const area of areas) expect(area.textContent).toContain(UNAVAILABLE)
  // The sections state the failure rather than rendering partial-looking numbers.
  expect(all('[data-jarvis="overview"] .dt-stat')).toEqual([])
  expect(all('[data-jarvis="agents"] .dt-kv')).toEqual([])
  expect(all('[data-jarvis="voice"] .dt-kv')).toEqual([])
})

it('renders records when the existing views return them, still without showing credential values or claiming verification', async () => {
  const fallback = globalThis.fetch, at2 = '2026-09-22T00:00:00Z'
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(String(url), 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
    if ((init?.method ?? 'GET') === 'GET') {
      if (path === 'memory/search') return Response.json({ items: [{ id: 'm1', kind: 'goal', scope: { type: 'personal' },
        scopeKey: 'personal', subject: 'Ship the dashboard', content: 'content', summary: 'A stored summary', tags: [],
        sensitivity: 'normal', provenance: { source: 'operator', at: at2 }, revision: 1, createdAt: at2, updatedAt: at2,
        contentHash: 'hash' }], nextCursor: null })
      if (path === 'missions') return Response.json({ items: [{ id: 'mi1', title: 'Dashboard mission', objective: 'Objective',
        status: 'active', updatedAt: at2, completed: 2, total: 3, needsReview: true }], nextOffset: null })
      if (path === 'providers') return Response.json({ items: [{ id: 'deepseek', baseUrl: 'https://api.deepseek.com',
        models: ['deepseek-flash'], defaultModel: 'deepseek-flash', credential: { name: 'deepseek-key', present: true },
        verified: false }], verified: false })
      if (path === 'credentials') return Response.json({ items: [{ name: 'deepseek-key', bytes: 12, updatedAt: at2 }] })
      if (path === 'usage') return Response.json({ configuration: { revision: 1, at: at2, prices: [], budgets: [], trackingSince: at2 },
        from: at2, scope: { kind: 'workspace' },
        totals: { calls: 3, tokens: 1200, cost: 5000, reservedTokens: 0, reservedCost: 0, unknownTokens: 0, unknownCost: 0, pending: 1 },
        budgets: [], calls: [], nextOffset: null })
    }
    return fallback(url, init)
  })
  at({ page: 'jarvis' })
  await mount()
  expect(all('[data-jarvis="memory"] .dt-row-title').map(title => title.textContent)).toEqual(['Ship the dashboard'])
  expect(all('[data-jarvis="memory"] .dt-row-meta')[0]!.textContent).toContain(zh['jarvis.memoryKind.goal'])
  expect(all('[data-jarvis="memory"] .dt-row-meta')[0]!.textContent).toContain('personal')
  expect(all('[data-jarvis="goals"] .dt-row-title').map(title => title.textContent)).toEqual(['Dashboard mission'])
  const progress = zh['jarvis.goalProgress'].replace('{completed}', '2').replace('{total}', '3')
  expect(all('[data-jarvis="goals"] .dt-row-meta')[0]!.textContent).toContain(progress)
  expect(all('[data-jarvis="goals"] .dt-row-meta')[0]!.textContent).toContain(zh['jarvis.needsReview'])
  expect(all('[data-jarvis="connections"] .dt-row-title').map(title => title.textContent)).toEqual(['deepseek', 'deepseek-key'])
  const providerMeta = all('[data-jarvis="connections"] .dt-row-meta')[0]!
  expect(providerMeta.textContent).toContain('https://api.deepseek.com')
  expect(providerMeta.textContent).toContain(zh['jarvis.credentialStored'])
  // The credential view carries metadata only, and the page renders only that.
  expect(all('[data-jarvis="connections"] .dt-row-meta')[1]!.textContent).toContain('12')
  expect(all('[data-jarvis="analytics"] .dt-kv dt').map(label => label.textContent)).toHaveLength(7)
  expect(all('[data-jarvis="analytics"] .dt-kv dt').map(label => label.textContent)).toContain(zh['usage.calls'])
  expect(all('[data-jarvis="analytics"]')[0]!.textContent).not.toContain(UNAVAILABLE)
  expect(text()).toContain(zh['jarvis.notVerified'])
})


it('stores, reports and clears the administration token in this browser only', async () => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) }, removeItem: (key: string) => { store.delete(key) } })
  at({ page: 'jarvis' })
  await mount()
  const input = all('input[type="password"]')[0]!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'test-admin-token')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const save = all('button').find(button => button.textContent === zh['access.save'])!
  await act(async () => { save.click() })
  expect(localStorage.getItem('dsh-admin-token')).toBe('test-admin-token')
  expect(text()).toContain(zh['access.configured'])
  const clear = all('button').find(button => button.textContent === zh['access.clear'])!
  await act(async () => { clear.click() })
  expect(localStorage.getItem('dsh-admin-token')).toBeNull()
  expect(text()).toContain(zh['access.notConfigured'])
})
