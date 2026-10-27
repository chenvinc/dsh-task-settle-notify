/**
 * Same-origin JSON routes for the settings card and diagnostics.
 *
 * Routes are `ctx.webServer.register` descriptors; the page fetches them as a
 * relative path, so no CORS handling is involved. Every route answers JSON and
 * never throws into the Host.
 */

/** Root-absolute prefix registered on the Host web server. */
export const API_PREFIX = '/api/task-settle-notify'

/** Largest accepted request body, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
export function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try {
      res.destroy()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read and parse a JSON body with a hard size cap.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, status: number, error: string }>}
 */
export async function readJsonBody(req) {
  return await new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, status: 413, error: 'body-too-large' })
        try {
          req.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => finish({ ok: false, status: 400, error: 'read-failed' }))
    req.on('end', () => {
      if (!chunks.length) return finish({ ok: true, value: {} })
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        finish({ ok: false, status: 400, error: 'invalid-json' })
      }
    })
  })
}

/**
 * Build the plugin's routes.
 * @param {object} options
 * @param {() => Record<string, unknown>} options.readSettings
 * @param {(patch: Record<string, unknown>) => Record<string, unknown>} options.writeSettings
 * @param {() => Record<string, unknown>} options.readStatus
 * @param {{ warn?: (message: string) => void }} [options.logger]
 * @returns {object[]}
 */
export function createRoutes(options) {
  return [
    {
      kind: 'exact',
      path: `${API_PREFIX}/settings`,
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            writeJson(res, 200, { ok: true, settings: options.readSettings() })
            return
          }
          if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
          const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
          if (!contentType.startsWith('application/json')) {
            return writeJson(res, 415, { ok: false, error: 'json-required' })
          }
          const body = await readJsonBody(req)
          if (!body.ok) return writeJson(res, body.status, { ok: false, error: body.error })
          const payload = body.value && typeof body.value === 'object' ? body.value : {}
          const patch = payload.settings ?? payload
          const settings = options.writeSettings(patch && typeof patch === 'object' ? patch : {})
          writeJson(res, 200, { ok: true, settings })
        } catch (error) {
          options.logger?.warn?.(`task-settle-notify: settings route failed: ${String(error)}`)
          writeJson(res, 500, { ok: false, error: 'internal-error' })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/status`,
      handler: (req, res) => {
        try {
          if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
          writeJson(res, 200, { ok: true, status: options.readStatus() })
        } catch (error) {
          options.logger?.warn?.(`task-settle-notify: status route failed: ${String(error)}`)
          writeJson(res, 500, { ok: false, error: 'internal-error' })
        }
      },
    },
  ]
}
