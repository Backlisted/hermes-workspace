import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./gateway-capabilities', () => ({
  BEARER_TOKEN: '',
  CLAUDE_API: 'https://runtime.example.test',
  dashboardFetch: vi.fn(),
  ensureGatewayProbed: vi.fn(),
  getCapabilities: vi.fn(),
}))
vi.mock('./claude-api', () => ({ listSessions: vi.fn(async () => []) }))
vi.mock('./local-session-store', () => ({
  getLocalMessages: vi.fn(),
  getLocalSession: vi.fn(),
}))
vi.mock('./run-store', () => ({
  getActiveRunForSession: vi.fn(async () => null),
}))

import {
  dashboardFetch,
  ensureGatewayProbed,
  getCapabilities,
} from './gateway-capabilities'
import { getLocalMessages, getLocalSession } from './local-session-store'
import { readContextUsage } from './context-usage'

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('HERMES_MODEL', '  gpt-5.6-sol  ')
  vi.mocked(getCapabilities).mockReturnValue({
    dashboard: { available: false },
  } as any)
  vi.mocked(ensureGatewayProbed).mockResolvedValue({
    dashboard: { available: false },
  } as any)
  vi.mocked(getLocalSession).mockReturnValue(null)
  vi.mocked(getLocalMessages).mockReturnValue([])
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('configured model without a management dashboard', () => {
  it('keeps the configured model for a new chat without claiming a known context limit', async () => {
    expect(await readContextUsage('new')).toMatchObject({
      model: 'gpt-5.6-sol', maxTokens: 0, usedTokens: 0,
    })
    expect(dashboardFetch).not.toHaveBeenCalled()
    expect(getCapabilities().dashboard.available).toBe(false)
  })

  it.each(['local session', 'pending messages'])('keeps the configured model for %s', async (kind) => {
    if (kind === 'local session') {
      vi.mocked(getLocalSession).mockReturnValue({ id: 'local-1', model: null } as any)
    }
    vi.mocked(getLocalMessages).mockReturnValue([{ content: 'x'.repeat(70) }] as any)
    expect(await readContextUsage('local-1')).toMatchObject({
      model: 'gpt-5.6-sol', usedTokens: 20,
    })
  })

  it.each(['unavailable', 'http failure', 'network failure', 'invalid JSON', 'empty response'])(
    'uses the configured model when dashboard model info has %s',
    async (failure) => {
      if (failure !== 'unavailable') {
        vi.mocked(getCapabilities).mockReturnValue({ dashboard: { available: true } } as any)
      }
      if (failure === 'network failure') vi.mocked(dashboardFetch).mockRejectedValue(new Error('timeout'))
      else if (failure === 'http failure') vi.mocked(dashboardFetch).mockResolvedValue(new Response('unavailable', { status: 503 }) as any)
      else if (failure === 'invalid JSON') vi.mocked(dashboardFetch).mockResolvedValue(new Response('not json') as any)
      else vi.mocked(dashboardFetch).mockResolvedValue(Response.json({}) as any)
      expect(await readContextUsage()).toMatchObject({ model: 'gpt-5.6-sol', maxTokens: 0 })
    },
  )

  it('preserves an authoritative dashboard model and context length', async () => {
    vi.mocked(getCapabilities).mockReturnValue({ dashboard: { available: true } } as any)
    vi.mocked(dashboardFetch).mockResolvedValue(Response.json({ model: 'runtime-model', effective_context_length: 32768 }) as any)
    expect(await readContextUsage()).toMatchObject({ model: 'runtime-model', maxTokens: 32768 })
  })

  it('preserves the actual live runtime model over the configured fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ model: 'session-model', context_tokens: 20, context_length: 64000 })))
    expect(await readContextUsage('runtime-1')).toMatchObject({ model: 'session-model', maxTokens: 64000, usedTokens: 20 })
  })

  it('does not rewrite an explicitly recorded local session model', async () => {
    vi.mocked(getLocalSession).mockReturnValue({ id: 'local-1', model: 'historical-model' } as any)
    expect(await readContextUsage('local-1')).toMatchObject({ model: 'historical-model' })
  })

  it.each(['local session', 'pending messages', 'new chat'])('keeps an unconfigured model unknown for %s', async (kind) => {
    vi.stubEnv('HERMES_MODEL', '  ')
    if (kind === 'local session') vi.mocked(getLocalSession).mockReturnValue({ id: 'local-1', model: null } as any)
    if (kind !== 'new chat') vi.mocked(getLocalMessages).mockReturnValue([{ content: 'hello' }] as any)
    expect(await readContextUsage(kind === 'new chat' ? 'new' : 'local-1')).toMatchObject({ model: '', maxTokens: 0 })
  })
})
