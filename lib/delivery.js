/**
 * Delivery into a DSH session through the Host gateway.
 *
 * The task board itself reaches sessions with `typertGateway.invoke({
 * namespace: 'session', method: 'prompt', args: { request } })`, speaking as an
 * owner peer. The notifier follows the same route: no core patch, no private
 * session store access, just one queued user message.
 */
import { randomUUID } from 'node:crypto'

/** Longest message this plugin will queue, in characters. */
export const MAX_MESSAGE_CHARS = 4000

/**
 * Create the owner peer a gateway call speaks for.
 *
 * The peer carries no credential; `principal: { kind: 'owner' }` is the only
 * identity the session log persists. It is bound to the plugin fiber so a
 * pending request cannot outlive the plugin.
 * @param {any} ctx
 * @returns {any}
 */
export function createOwnerPeer(ctx) {
  const controller = new AbortController()
  let completion
  const peer = {
    id: `task-settle-notify-owner:${randomUUID()}`,
    ctx,
    principal: { kind: 'owner' },
    signal: controller.signal,
    interactions: 'none',
    dispose() {
      if (completion === undefined) {
        controller.abort()
        completion = Promise.resolve()
      }
      return completion
    },
  }
  ctx?.effect?.(() => () => {
    peer.dispose()
  }, 'task-settle-notify: owner peer')
  return peer
}

/**
 * Queue one user message in a session.
 *
 * `mode: 'queue'` is deliberate: a settlement often lands while the initiating
 * session is still finishing its own turn, and a steer would interrupt it.
 *
 * @param {object} options
 * @param {any} options.gateway `ctx.typertGateway`
 * @param {any} options.peer owner peer
 * @param {string} options.sessionId initiating session
 * @param {string} options.text message body
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<unknown>}
 */
export async function deliverPrompt({ gateway, peer, sessionId, text, signal }) {
  if (!gateway || typeof gateway.invoke !== 'function') {
    throw new Error('typert gateway is unavailable')
  }
  const target = String(sessionId ?? '').trim()
  if (!target) throw new Error('no initiating session')
  const body = String(text ?? '').slice(0, MAX_MESSAGE_CHARS)
  if (!body) throw new Error('empty notification')
  const result = await gateway.invoke({
    namespace: 'session',
    method: 'prompt',
    args: {
      request: {
        sessionId: target,
        requestId: `task-settle-notify-${randomUUID()}`,
        mode: 'queue',
        content: [{ type: 'text', text: body }],
      },
    },
    peer,
    ...(signal === undefined ? {} : { signal }),
  })
  if (result && typeof result === 'object' && result.ok === false) {
    throw new Error(String(result.error ?? 'gateway rejected the prompt'))
  }
  return result
}
