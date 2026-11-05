// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const chatState = vi.hoisted(() => ({
  registerSendStreamRun: vi.fn(),
  unregisterSendStreamRun: vi.fn(),
  processEvent: vi.fn(),
  clearStreamingSession: vi.fn(),
  setHeartbeatActivity: vi.fn(),
}))
vi.mock('@/stores/chat-store', () => ({
  useChatStore: Object.assign((selector: (state: typeof chatState) => unknown) => selector(chatState), {
    getState: () => chatState,
  }),
}))
vi.mock('@/components/inspector/activity-store', () => ({ pushActivity: vi.fn() }))

import { useSessionModelStore } from '@/stores/session-model-store'
import { useStreamingMessage } from './use-streaming-message'

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useSessionModelStore.setState({ models: {} })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    'event: done\ndata: {"state":"final"}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  )))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function sendWithHook(sessionKey: string, model?: string) {
  const { result } = renderHook(() => useStreamingMessage())
  await act(async () => {
    await result.current.startStreaming({
      sessionKey, friendlyId: sessionKey, message: 'test', model,
    })
  })
  const [url, request] = vi.mocked(fetch).mock.calls.at(-1)!
  expect(url).toBe('/api/send-stream')
  return JSON.parse(String(request?.body))
}

describe('selected model reaches the chat request', () => {
  it('sends the picker selection instead of stale session-status metadata', async () => {
    useSessionModelStore.getState().setModel('session-a', 'gpt-5.6-sol')
    expect(await sendWithHook('session-a', 'gpt-5.4')).toMatchObject({ model: 'gpt-5.6-sol' })
  })

  it('reads a changed selection at send time without waiting for a status poll', async () => {
    const { result } = renderHook(() => useStreamingMessage())
    useSessionModelStore.getState().setModel('session-a', 'latest-selection')
    await act(async () => {
      await result.current.startStreaming({ sessionKey: 'session-a', friendlyId: 'session-a', message: 'test', model: 'stale-status' })
    })
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).model).toBe('latest-selection')
  })

  it('preserves historical/default model behavior when no selection exists for this session', async () => {
    useSessionModelStore.getState().setModel('another-session', 'other-model')
    expect(await sendWithHook('session-a', 'historical-model')).toMatchObject({ model: 'historical-model' })
    expect(useSessionModelStore.getState().getModel('session-a')).toBeUndefined()
  })

  it('does not invent a model when neither configuration nor a selection is available', async () => {
    expect(await sendWithHook('session-a')).not.toHaveProperty('model')
  })

  it('carries the new-chat choice to its concrete session exactly once', async () => {
    useSessionModelStore.getState().setModel('new', 'draft-selected-model')
    useSessionModelStore.getState().moveModel('new', 'created-session')
    expect(await sendWithHook('created-session', 'default-model')).toMatchObject({ model: 'draft-selected-model' })
    expect(useSessionModelStore.getState().getModel('new')).toBeUndefined()
    expect(useSessionModelStore.getState().getModel('created-session')).toBe('draft-selected-model')
    useSessionModelStore.getState().moveModel('new', 'next-session')
    expect(await sendWithHook('next-session', 'default-model')).toMatchObject({ model: 'default-model' })
  })

  it('does not clear or replace existing preferences when there is no draft choice', () => {
    useSessionModelStore.getState().setModel('main', 'existing-model')
    useSessionModelStore.getState().moveModel('new', 'main')
    useSessionModelStore.getState().moveModel('main', 'main')
    expect(useSessionModelStore.getState().getModel('main')).toBe('existing-model')
  })
})
