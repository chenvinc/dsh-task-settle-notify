/**
 * The one model-facing tool this plugin adds: `answer_card_question`.
 *
 * The relay holds a card's question open; the initiating conversation answers it
 * by calling this tool with the `card_question_id` quoted in the relayed
 * message. Registration is deliberately forgiving: the tool service ships with
 * the Host, `@deepseek-ai/dsh-tools` is only guaranteed to resolve when the
 * plugin was installed with its dependencies, so `defineTool` is used when it is
 * importable and a plain definition (same shape the runtime consumes) is
 * registered when it is not. Either way the answer path is identical.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

/** Tool name the relayed message tells the model to call. */
export const ANSWER_TOOL_NAME = 'answer_card_question'

const DESCRIPTION =
  'Answer a question a running task-board card asked the conversation that dispatched it. ' +
  "Call it only after a 〔看板〕 message reports that a card is asking: pass that message's " +
  'card_question_id and one answers item per question. If you cannot decide, ask the user first.'

const PARAMETER_SPEC = {
  card_question_id: {
    type: 'string',
    required: true,
    description: 'The card_question_id quoted by the relayed 〔看板〕 question message.',
  },
  answers: {
    type: 'array',
    required: true,
    description: 'One item per question of that request, in any order.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true, description: 'Question id from the relayed message.' },
        selected: {
          type: 'array',
          description: 'Selected option labels, verbatim as the card offered them.',
          items: { type: 'string' },
        },
        custom: {
          type: 'string',
          description: 'Free-text answer, used when no option fits or next to a multi-select.',
        },
      },
    },
  },
}

const PARAMETERS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    card_question_id: { type: 'string', description: PARAMETER_SPEC.card_question_id.description },
    answers: {
      type: 'array',
      description: PARAMETER_SPEC.answers.description,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Question id from the relayed message.' },
          selected: { type: 'array', items: { type: 'string' }, description: 'Selected option labels.' },
          custom: { type: 'string', description: 'Free-text answer.' },
        },
      },
    },
  },
  required: ['card_question_id', 'answers'],
}

const OUTPUT_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    taskId: { type: 'string' },
    title: { type: 'string' },
    error: { type: 'string' },
  },
}

const OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    taskId: { type: 'string' },
    title: { type: 'string' },
    error: { type: 'string' },
  },
}

const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

/**
 * Build the tool body shared by both registration paths.
 * @param {() => any} getRelay
 * @returns {(args: any, exec: any) => Promise<object>}
 */
function body(getRelay) {
  return async (args, exec) => {
    const relay = getRelay()
    if (!relay) return { ok: false, error: '卡片提问中继没有挂载（看板或网关不可用）' }
    const sessionId = String(exec?.agent?.session?.id ?? exec?.agent?.id ?? '')
    try {
      const result = relay.answer({
        sessionId,
        callId: args?.card_question_id,
        answers: args?.answers,
      })
      return { ok: true, taskId: result.taskId, title: result.title }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }
}

/**
 * Candidate module urls for `@deepseek-ai/dsh-tools`, most specific first.
 * @param {string | undefined} profileDir
 * @returns {URL[]}
 */
function candidateUrls(profileDir) {
  const urls = []
  if (profileDir) {
    urls.push(pathToFileURL(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')))
  }
  return urls
}

/**
 * Register the answer tool once the tool registry is up.
 * @param {object} options
 * @param {any} options.scoped context that owns the `tools` service
 * @param {() => any} options.getRelay
 * @param {ReturnType<import('./log.js').createLog>} options.log
 * @param {string} [options.profileDir]
 * @returns {() => void} disposer
 */
export function mountAnswerTool({ scoped, getRelay, log, profileDir }) {
  let unregister
  let stopped = false
  const dispose = () => {
    stopped = true
    try {
      unregister?.()
    } catch {
      /* ignore */
    }
    unregister = undefined
  }

  const register = (definition) => {
    if (stopped) return
    unregister = scoped.tools.register(definition)
    log.trace('answer-tool-registered', { name: ANSWER_TOOL_NAME })
  }

  const fallback = () => {
    register({
      name: ANSWER_TOOL_NAME,
      description: DESCRIPTION,
      parameters: PARAMETERS_JSON_SCHEMA,
      output: { schema: OUTPUT_JSON_SCHEMA, render },
      execute: body(getRelay),
    })
  }

  const load = async () => {
    const errors = []
    try {
      const { defineTool } = await import('@deepseek-ai/dsh-tools')
      register(
        defineTool({
          name: ANSWER_TOOL_NAME,
          description: DESCRIPTION,
          parameters: PARAMETER_SPEC,
          output: { schema: OUTPUT_SPEC, render },
          execute: body(getRelay),
        }),
      )
      return
    } catch (error) {
      errors.push(String(error?.message ?? error))
    }
    for (const url of candidateUrls(profileDir)) {
      try {
        const { defineTool } = await import(url.href)
        register(
          defineTool({
            name: ANSWER_TOOL_NAME,
            description: DESCRIPTION,
            parameters: PARAMETER_SPEC,
            output: { schema: OUTPUT_SPEC, render },
            execute: body(getRelay),
          }),
        )
        return
      } catch (error) {
        errors.push(String(error?.message ?? error))
      }
    }
    try {
      fallback()
      log.trace('answer-tool-plain-definition', { errors })
    } catch (error) {
      log.warn('answer-tool-unavailable', String(error?.message ?? error))
    }
  }

  void load()
  return dispose
}
