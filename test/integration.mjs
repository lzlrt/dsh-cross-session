/**
 * 宿主级集成验证：用最小 cordis 应用加载插件，确认
 *   1. inject 声明的服务名与真实宿主服务名一致（拼错会静默 pending）
 *   2. apply() 真的被调用、四个工具真的注册进 tools 注册表
 *
 * 这是对「插件装上了但工具没出现」这类静默失败的专项检验。
 */

import { Context } from '/usr/local/lib/node_modules/@deepseek-ai/cordis/lib/index.js'
import { Service } from '/usr/local/lib/node_modules/@deepseek-ai/cordis/lib/index.js'

const registered = []

/* ── 按真实宿主同名注册三个假服务 ───────────────────────── */

class FakeTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
  }
  register(definition) {
    registered.push(definition)
    return () => {}
  }
}

class FakeSessionController extends Service {
  constructor(ctx) {
    super(ctx, 'sessionController')
    this.prompts = []
  }
  async prompt(request) {
    this.prompts.push(request)
    return { accepted: true }
  }
}

class FakeSessionQuery extends Service {
  constructor(ctx) {
    super(ctx, 'sessionQuery')
  }
  async listSessions() {
    return [{
      header: { id: 'session-abcdef01-2345-4678-89ab-cdef01234567', cwd: '/ws', createdAt: 1, title: '样本' },
      live: false,
      persisted: true,
    }]
  }
  async readSession() {
    return { events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }] }
  }
}

const app = new Context()
app.plugin(FakeTools)
app.plugin(FakeSessionController)
app.plugin(FakeSessionQuery)

const mod = await import('../lib/index.js')
app.plugin(mod)

// cordis 的服务注入是异步的，等一拍让它完成 apply。
await new Promise((resolve) => setTimeout(resolve, 300))

console.log('inject 声明:', JSON.stringify(mod.inject))
console.log('注册到的工具:', registered.map((t) => t.name).join(', ') || '(无)')

const expected = ['session_list', 'session_read', 'session_reply', 'session_send']
const got = registered.map((t) => t.name).sort()
const ok = JSON.stringify(got) === JSON.stringify(expected)
console.log(ok ? '\n✅ inject 匹配、apply 已执行、4 个工具全部注册' : `\n❌ 期望 ${expected} 实际 ${got}`)

// 顺带跑一次真实调用，确认拿到的是宿主服务而不是自己的副本。
const send = registered.find((t) => t.name === 'session_send')
if (send) {
  const out = await send.execute(
    { session_id: 'session-abcdef01-2345-4678-89ab-cdef01234567', message: '集成测试' },
    { agent: { id: 'session-caller', session: { header: { id: 'session-caller', cwd: '/ws' } } }, signal: new AbortController().signal },
  )
  const controller = app.get('sessionController')
  console.log('投递结果:', JSON.stringify(out))
  console.log('宿主 sessionController 收到的 prompt 条数:', controller.prompts.length)
  console.log(controller.prompts.length === 1 ? '✅ 确实走了宿主的 prompt()' : '❌ 没有走宿主 prompt()')
}

await app.stop?.()
process.exit(ok ? 0 : 1)
