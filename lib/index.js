/**
 * dsh-cross-session — 跨会话协同 for DeepSeek Harness 0.2.x
 *
 * 四个工具：session_send / session_reply / session_list / session_read。
 * 目标只有一个——让会话之间能互发消息、交接任务、回信。
 *
 * ── 设计原则（这条决定了整个实现）────────────────────────────────
 * **不自己组合 Agent。** 发消息与冷恢复全部交给宿主的
 * `sessionController.prompt()` —— GUI 输入框走的就是这一条路。它内部：
 *   prompt() → resolveAgent() → resolve() → resume() → composeAgent()
 *            → presets.resolve(undefined) 得到默认 preset
 *            → presets.mount(agentCtx, presetId) 挂载工具/提示词
 * 于是「宿主怎么给 GUI 会话配能力，就怎么给这里叫醒的会话配能力」，
 * 插件没有任何机会拼出一个只有全局插件工具、没有 read/write/bash 的空壳。
 *
 * 这是对开源插件 dsh-cross-session-approval 0.3.10 的针对性修正：它自己
 * 实现了 installPreset()，在 presetId 为空或 mount 失败时静默降级为
 * 「只装模型选择」，然后继续投递消息 —— 结果是会话能回话但干不了活。
 *
 * ── 服务依赖 ──────────────────────────────────────────────────
 * 必需（inject，缺任一则插件不加载）：
 *   tools             注册工具
 *   sessionController 宿主会话控制器（发消息/冷恢复/列表）
 *   sessionQuery      读会话日志（session_read 用）
 * 可选（运行时 ctx.get，缺了只降级对应功能）：
 *   workspaceRegistry 归档判定 / 当前工作区
 *   sessions          活跃会话判定
 *
 * @module dsh-cross-session
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/** 插件运行时名，须与 cordis.patch.yml 的 name 一致。 */
export const name = 'cross-session'

/**
 * 必须等到的服务。sessionController 是核心：没有它就没法发消息，
 * 而这个插件存在的唯一理由就是发消息，所以它缺了就不该加载。
 */
export const inject = ['tools', 'sessionController', 'sessionQuery']

/** 单条消息正文上限（UTF-8 字节）——防止一条消息把对方上下文撑爆。 */
const MAX_MESSAGE_BYTES = 32 * 1024

/* ══════════════════════════════ 别名 ══════════════════════════════ */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ALIAS_PREFIX = 'cs_'
const ALIAS_BODY_LEN = 10
/** 派生盐：与其它插件用同一套算法时也不会撞车。 */
const ALIAS_SALT = 'dsh-cross-session:alias:v1:'

/**
 * 从真实会话 ID 派生确定性短别名。
 *
 * 为什么需要：`session-<8-4-4-4-12 UUID>` 这 44 个字符在模型可见文本里
 * 会被显示层整体替换成占位符（形如 session-00000000-0000-4000-8000-...），
 * 模型从这个列表里复制的 ID 喂回去必然查不到。base62 短码不命中那个
 * 形状规则，所以能安全穿过显示层。
 *
 * @param {string} sessionId 真实会话 ID
 * @returns {string} 形如 cs_3fKpQ2mZaB（总长 13）
 */
function makeAlias(sessionId) {
  const input = ALIAS_SALT + String(sessionId)
  // FNV-1a 64 位，用 BigInt 避免 Number 丢精度。
  const FNV_OFFSET = 0xcbf29ce484222325n
  const FNV_PRIME = 0x100000001b3n
  const MASK64 = (1n << 64n) - 1n
  let hash = FNV_OFFSET
  for (let i = 0; i < input.length; i++) {
    hash = ((hash ^ BigInt(input.charCodeAt(i))) * FNV_PRIME) & MASK64
  }
  // 每取一位就再混一轮，避免只用到低位。
  let body = ''
  let h = hash
  for (let i = 0; i < ALIAS_BODY_LEN; i++) {
    body += ALPHABET[Number(h % 62n)]
    h = ((h ^ (h >> 13n)) * FNV_PRIME) & MASK64
    if (h === 0n) h = hash
  }
  return ALIAS_PREFIX + body
}

/** 是否形如本插件派生的别名。 */
function isAlias(value) {
  if (typeof value !== 'string' || !value.startsWith(ALIAS_PREFIX)) return false
  const body = value.slice(ALIAS_PREFIX.length)
  if (body.length !== ALIAS_BODY_LEN) return false
  for (const ch of body) if (!ALPHABET.includes(ch)) return false
  return true
}

/**
 * 是否是「被显示层遮蔽的占位符 ID」。
 *
 * 遮蔽产物有两种：`00000000-0000-4000-8000-000000000000`（裸 UUID）
 * 与 `session-00000000-0000-4000-8000-000000000000`（带 `session-` 前缀）。
 *
 * ⚠️ UUID 是 8-4-4-4-12 五段，第三段是**版本位** `4000`，第四段是变体位 `8000`，
 *    都不是全零。把判据写成「五段全零」会漏掉真实占位符（本插件初版就这样错过）。
 */
function isMaskedId(value) {
  if (typeof value !== 'string') return false
  return /^(?:session-)?0{8}-0{4}-4000-8000-0{12}$/.test(value)
}

/* ══════════════════════════════ 小工具 ══════════════════════════════ */

/** 取错误的简短文本。 */
function errText(error) {
  if (error === null || error === undefined) return String(error)
  const message = typeof error?.message === 'string' ? error.message : String(error)
  return message.length > 300 ? message.slice(0, 300) + '…' : message
}

/**
 * 按 UTF-8 字节截断（线性，一次编码，不逐字节重扫）。
 *
 * 边界处理：截在 `end` 处是否合法，取决于**第一个被排除的字节** `buf[end]` ——
 * 它若是 10xxxxxx（续接字节），说明正好切在某个多字节字符中间，要退回该字符
 * 的起始处。看 `buf[end-1]` 是错的：那是"最后一个被包含的字节"，判不出字符是否完整。
 */
function clampText(value, maxBytes = MAX_MESSAGE_BYTES) {
  const text = typeof value === 'string' ? value : ''
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return text
  let end = maxBytes
  // 调用方保证 buf.length > maxBytes ⇒ buf[end] 一定存在。
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1
  return buf.subarray(0, end).toString('utf8') + '\n…（已按 32 KiB 截断）'
}

/* ══════════════════════ 会话枚举与别名解析 ══════════════════════ */

/**
 * 从一条宿主会话记录里取真实 ID。
 *
 * 宿主 `sessionQuery.listSessions()` 返回 `{ header, live, persisted }`，
 * `sessionController.list()` 返回 `{ sessionId, ... }`。两种都认。
 */
function idOfRecord(record) {
  const id = record?.sessionId ?? record?.header?.id ?? record?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** 从记录里取 header（sessionController.list 的条目没有 header，只有平铺字段）。 */
function headerOfRecord(record) {
  return record?.header ?? record
}

/**
 * 枚举当前宿主可见的顶层会话。
 *
 * 优先用 `sessionQuery.listSessions()`：它同时给出活跃 + 磁盘上的会话，
 * 且不需要激活任何东西。派生子会话（`parentSession` 非空）排除——它们是
 * subagent，不该被跨会话寻址。
 *
 * ⚠️ 标题**不在 header 里**。宿主把标题存成事件日志里的 `session/title` 事件，
 *    要 fold 出来才算数；`listSessions()` 返回的 header 没有 title 字段。
 *    直接读 `header.title` 会让所有条目都显示「(无标题)」（本插件初版就这样错过）。
 *    正确取法：`sessionQuery.readTitleSnapshots(ids)`，它内部 fold 每条日志。
 *
 * @returns {Promise<Array<{id: string, title: string, live: boolean, cwd: string, record: object}>>}
 */
async function listSessions(ctx, { withTitles = false } = {}) {
  const query = ctx.get('sessionQuery')
  const records = (await query.listSessions()) ?? []
  const out = []
  for (const record of records) {
    const id = idOfRecord(record)
    if (id === undefined) continue
    const header = headerOfRecord(record)
    if (header?.parentSession !== undefined) continue
    out.push({
      id,
      title: '',
      live: record?.live === true,
      cwd: typeof header?.cwd === 'string' ? header.cwd : '',
      createdAt: typeof header?.createdAt === 'number' ? header.createdAt : 0,
      record,
    })
  }

  // ── 批量 fold 标题 ──
  // 返回与入参同序的 settled 结果；单条失败不该拖垮整次列表。
  if (withTitles && out.length > 0 && typeof query.readTitleSnapshots === 'function') {
    try {
      const settled = await query.readTitleSnapshots(out.map((s) => s.id))
      for (const item of settled ?? []) {
        if (item?.status === 'rejected') continue
        const value = item?.value
        const id = value?.session?.id
        if (typeof id !== 'string') continue
        // titleSnapshot 是 {title, messageSeqs, source, eventSeq, updatedAt} 对象，
        // 不是字符串；也兼容宿主直接返回字符串的实现。
        const raw = value?.title
        const text = typeof raw === 'string' ? raw : raw?.title
        if (typeof text !== 'string' || text === '') continue
        const target = out.find((s) => s.id === id)
        if (target !== undefined) target.title = text
      }
    } catch { /* 标题读不到就留空，不影响寻址与投递 */ }
  }

  return out
}

/**
 * 把会话标识解析成真实 ID。
 *
 * - `cs_` 别名 → 在会话列表里找派生结果相等的那一个
 * - `session-<uuid>` 真 ID → 原样透传
 * - 被遮蔽的占位符 → 抛错并提示改用别名
 * - 找不到的别名 → 抛错，**绝不猜最近似的那一个**
 *
 * @param {string} input 用户给的标识
 * @param {Array<{id: string}>} sessions 会话列表
 * @returns {string} 真实会话 ID
 */
function resolveId(input, sessions) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw === '') throw new Error('会话标识不能为空：请传 session_list 给出的 cs_ 别名。')

  if (isMaskedId(raw)) {
    throw new Error(
      `这个 ID 是被显示层替换过的占位符（${raw}），不是真实 ID。`
      + '请改用 session_list 返回的 cs_ 短别名——别名不会被遮蔽。',
    )
  }

  if (isAlias(raw)) {
    for (const session of sessions) {
      if (makeAlias(session.id) === raw) return session.id
    }
    throw new Error(
      `找不到别名 ${raw} 对应的会话：可能已归档、已删除，或不在当前可见范围。`
      + '请重新调用 session_list 确认。',
    )
  }

  // 其余一律透传（含真 ID 与非标准 ID）。形状校验是宿主的事；
  // 本插件只负责「别名还原」和「挡住已确认的遮蔽产物」两件事。
  return raw
}

/* ══════════════════════════ 投递原语 ══════════════════════════ */

/**
 * 给一个会话送一条用户消息。这是本插件唯一的投递实现。
 *
 * 关键：走宿主的 `sessionController.prompt()`，而不是自己 `agents.resume()`
 * + 自己 `presets.mount()`。宿主内部会：
 *   1. `resolveAgent()` —— 冷会话自动 resume，并发 resume 去重
 *   2. `composeAgent(presetForObservation(observation))` —— 从投影读该会话
 *      当初用的 preset；读不到时 `presets.resolve(undefined)` 回落宿主默认
 *   3. `presets.mount()` —— 挂上工具与提示词
 *   4. `agent.steer()` / `agent.followup()` —— 投递
 * 因此恢复出来的会话能力集与 GUI 打开的完全一致。
 *
 * @param {object} ctx 插件上下文
 * @param {string} sessionId 目标会话真实 ID
 * @param {string} text 消息正文
 * @param {'steer'|'followup'} mode steer=插队；followup=等这轮结束
 * @param {AbortSignal} [signal] 调用方的取消信号
 * @returns {Promise<{ok: true} | {ok: false, error: string}>} 从不抛出
 */
async function deliver(ctx, sessionId, text, mode, signal) {
  const controller = ctx.get('sessionController')
  if (!controller || typeof controller.prompt !== 'function') {
    return { ok: false, error: '宿主未提供 sessionController.prompt：无法投递（本插件不会自行拼装 Agent）。' }
  }
  // prompt() 要求一个 AbortSignal；调用方没给就造一个不会取消的。
  const useSignal = signal ?? new AbortController().signal
  try {
    await controller.prompt({
      sessionId,
      // requestId 用于幂等：宿主见到重复的 rpcId 会直接返回 accepted 而不重复投递。
      requestId: `css-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      content: [{ type: 'text', text }],
      mode,
    }, useSignal)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errText(error) }
  }
}

/* ═══════════════════════════ 消息正文提取 ═══════════════════════════ */

/** 从内容块数组里拼出纯文本（只取 text 块）。 */
function textOfBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/* ══════════════════════════════ 插件主体 ══════════════════════════════ */

/**
 * 注册四个工具。
 * @param {object} ctx Cordis 插件上下文（inject 已保证 tools/sessionController/sessionQuery 可解析）
 */
export function apply(ctx) {
  const tools = ctx.get('tools')
  if (!tools || typeof tools.register !== 'function') {
    throw new Error('[dsh-cross-session] 需要 tools 服务（register）。')
  }

  /* ────────────────────── session_list ────────────────────── */
  tools.register(defineTool({
    name: 'session_list',
    description: '列出工作区里的会话（别名/标题/是否在运行/模型/目录）。用它拿到 cs_ 别名，再传给 session_send / session_reply / session_read。',
    parameters: {
      limit: { type: 'number', description: '最多列几个（默认 20，上限 100）。' },
      all_workspaces: { type: 'boolean', description: 'true 时跨项目列出全部会话（默认只看当前工作区）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: (value.sessions.length === 0
          ? '没有找到会话。'
          : value.sessions.map((s) => (
              `- 「${s.title || '(无标题)'}」 alias=${s.alias}`
              + `${s.is_self ? ' · **（你自己）**' : ''}`
              + `${s.running ? ' · 运行中' : ''}`
              + `${s.model ? ` · ${s.model}` : ''}`
              + `${value.showWorkspace && s.cwd ? ` · [${s.cwd}]` : ''}`
            )).join('\n'))
          + (value.self_alias
            ? `\n\n**你自己的别名是 ${value.self_alias}** —— 要别人给你回信，就把这串写进消息里（例如「回 cs_xxx」）。`
            : '')
          + '\n用 alias（cs_ 开头）当 session_id 传给其它工具即可。',
      }],
    },
    async execute(args, exec) {
      const limit = typeof args.limit === 'number'
        ? Math.min(Math.max(1, Math.floor(args.limit)), 100)
        : 20
      const allWorkspaces = args.all_workspaces === true

      // 调用者自己的会话 ID 与 cwd。
      const callerId = typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
      const callerCwd = exec?.agent?.session?.header?.cwd

      // 只有这里需要标题：其余三个工具只为解析别名，不必 fold 每条会话日志。
      const sessions = await listSessions(ctx, { withTitles: true })

      // 归档的不列（发了也送不进去）。
      let archived = new Set()
      try {
        const registry = ctx.get('workspaceRegistry')
        if (Array.isArray(registry?.archivedSessionIds)) archived = new Set(registry.archivedSessionIds)
      } catch { /* 归档信息不可用时全部当作未归档 */ }

      // 运行状态：agents 服务有活跃对象即 running。
      const runningIds = new Set()
      try {
        const agents = ctx.get('agents')
        if (agents && typeof agents.list === 'function') {
          for (const agent of agents.list()) {
            if (typeof agent?.id === 'string' && agent.status === 'running') runningIds.add(agent.id)
          }
        }
      } catch { /* 状态不可用时标为未运行 */ }

      // 自己的别名：渲染层用它提醒「要别人回信，就写这个」。
      const selfAlias = callerId !== '' ? makeAlias(callerId) : ''

      const rows = sessions
        .filter((s) => !archived.has(s.id))
        .filter((s) => allWorkspaces || typeof callerCwd !== 'string' || s.cwd === callerCwd)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map((s) => ({
          alias: makeAlias(s.id),
          title: s.title,
          running: runningIds.has(s.id),
          cwd: s.cwd,
          is_self: callerId !== '' && s.id === callerId,
          model: typeof s.record?.projections?.values?.modelSelection?.lastUsed?.model === 'string'
            ? s.record.projections.values.modelSelection.lastUsed.model
            : '',
        }))

      return { sessions: rows, showWorkspace: allWorkspaces, self_alias: selfAlias }
    },
  }))

  /* ────────────────────── session_send ────────────────────── */
  tools.register(defineTool({
    name: 'session_send',
    description: '给另一个会话发消息。目标关着会自动叫醒它再投递，唤醒失败会明确报错（不会假装发出去）。用于交接任务、追问进度、补充材料。',
    parameters: {
      session_id: { type: 'string', required: true, description: '目标会话：session_list 给出的 cs_ 别名，或真实 session-<uuid>。' },
      message: { type: 'string', required: true, description: '要发的内容。' },
      mode: { type: 'string', description: 'steer（默认，插队：对方当前步骤结束后立即处理）或 followup（等它这一整轮跑完）。' },
      reply_to: { type: 'string', description: '可选：让对方做完回信给谁（默认就是你自己）。传 cs_ 别名。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: `消息已投递给会话 ${value.session_id}（${value.was_running ? '原本就活跃' : '未打开，已叫醒'}）。`,
      }],
    },
    async execute(args, exec) {
      const caller = exec?.agent
      if (!caller) throw new Error('session_send 需要在一个会话里调用（exec.agent 缺失）。')

      const sessions = await listSessions(ctx)
      const targetId = resolveId(args.session_id, sessions)
      // 自己发给自己会形成回环（自己唤醒自己、自己回复自己），浪费一轮还容易死循环。
      if (targetId === caller.id) {
        throw new Error(`目标是调用者自己（${makeAlias(caller.id)}），拒绝自发自收。要记录想法请直接说，不用发消息。`)
      }

      const mode = args.mode === 'followup' ? 'followup' : 'steer'
      // 回信指引：默认回给调用者；显式 reply_to 时按别名解析后附上。
      let replyAlias = makeAlias(caller.id)
      if (args.reply_to !== undefined && args.reply_to !== '') {
        replyAlias = makeAlias(resolveId(args.reply_to, sessions))
      }
      const wasRunning = sessions.find((s) => s.id === targetId)?.live === true

      const body = clampText(args.message)
        + `\n\n—— 以上消息来自会话 ${makeAlias(caller.id)}。`
        + `\n若需要把结果回给发起方，调用 session_reply({ to: "${replyAlias}", text: "..." })。`

      const sent = await deliver(ctx, targetId, body, mode, exec.signal)
      if (!sent.ok) throw new Error(`投递失败：${sent.error}`)

      return {
        session_id: makeAlias(targetId),
        mode,
        was_running: wasRunning,
        status: 'delivered',
      }
    },
  }))

  /* ────────────────────── session_reply ────────────────────── */
  tools.register(defineTool({
    name: 'session_reply',
    description: '把结果回给发消息的那个会话。任务会话干完活用它回话；目标关着也会叫醒。',
    parameters: {
      to: { type: 'string', required: true, description: '回给谁：cs_ 别名（通常取自任务消息里附带的「回信给 cs_xxx」）或真实 ID。' },
      text: { type: 'string', required: true, description: '结果摘要、结论或失败原因。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: `回复已送达会话 ${value.to}（${value.was_running ? '原本就活跃' : '未打开，已叫醒'}）。`,
      }],
    },
    async execute(args, exec) {
      const caller = exec?.agent
      if (!caller) throw new Error('session_reply 需要在一个会话里调用（exec.agent 缺失）。')

      const sessions = await listSessions(ctx)
      const toId = resolveId(args.to, sessions)
      if (toId === caller.id) {
        throw new Error(`回信目标是调用者自己（${makeAlias(caller.id)}），拒绝自发自收。`)
      }
      const wasRunning = sessions.find((s) => s.id === toId)?.live === true

      const body = `[来自会话 ${makeAlias(caller.id)} 的回复]\n${clampText(args.text)}`
      const sent = await deliver(ctx, toId, body, 'steer', exec.signal)
      if (!sent.ok) throw new Error(`回复失败：${sent.error}`)

      return { to: makeAlias(toId), was_running: wasRunning, delivered: true }
    },
  }))

  /* ────────────────────── session_read ────────────────────── */
  tools.register(defineTool({
    name: 'session_read',
    description: '看某个会话最近的消息（不叫醒它）。用于确认对方进度，或回顾它说过什么。',
    parameters: {
      session_id: { type: 'string', required: true, description: '目标会话：cs_ 别名或真实 ID。' },
      tail: { type: 'number', description: '最近几条（默认 10，上限 50）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0
          ? `会话 ${value.session_id} 还没有消息。`
          : value.messages.map((m) => `${m.role === 'assistant' ? '[助手]' : '[用户]'} ${m.text}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      if (!exec?.agent) throw new Error('session_read 需要在一个会话里调用（exec.agent 缺失）。')

      const sessions = await listSessions(ctx)
      const targetId = resolveId(args.session_id, sessions)
      const tail = typeof args.tail === 'number'
        ? Math.min(Math.max(1, Math.floor(args.tail)), 50)
        : 10

      // 活跃会话读内存快照；其余从磁盘读（sessionQuery.readSession 两者都能处理）。
      const query = ctx.get('sessionQuery')
      let events = []
      try {
        const result = await query.readSession(targetId)
        events = Array.isArray(result) ? result : (result?.events ?? [])
      } catch (error) {
        throw new Error(`会话 ${targetId} 不存在或日志无法读取（${errText(error)}）。`)
      }

      const messages = []
      for (let i = events.length - 1; i >= 0 && messages.length < tail; i--) {
        const event = events[i]
        if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue
        const text = textOfBlocks(event?.data?.content)
        if (text.trim() === '') continue
        messages.push({
          role: event.type === 'assistant/message' ? 'assistant' : 'user',
          text,
        })
      }
      messages.reverse()

      return { session_id: makeAlias(targetId), messages }
    },
  }))
}
