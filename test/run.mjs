/**
 * dsh-cross-session 的离宿主测试。
 *
 * 用一个最小假宿主跑四个工具的全部逻辑：别名派生、标识解析、
 * 消息投递路径、归档过滤、工作区过滤。
 *
 * 重点验证：投递**只**经过 sessionController.prompt()，从不自己 resume / mount。
 */

import assert from 'node:assert/strict'

/* ── 假宿主 ─────────────────────────────────────────────── */

function makeHost({ sessions = [], archived = [], promptFails = false } = {}) {
  const calls = { prompt: [], readSession: [], readTitleSnapshots: [] }
  const tools = new Map()

  const service = {
    sessionQuery: {
      async listSessions() {
        // ⚠️ 与真实宿主一致：header **不含 title**。
        //    标题是事件日志里的 session/title 事件，只能经 readTitleSnapshots fold。
        //    初版 mock 把 title 塞进 header，正好掩盖了「读错位置」这个 bug。
        return sessions.map((s) => ({
          header: { id: s.id, cwd: s.cwd ?? '/ws', createdAt: s.createdAt ?? 1, ...(s.parentSession ? { parentSession: s.parentSession } : {}) },
          live: s.live === true,
          persisted: true,
        }))
      },
      /**
       * 模拟宿主的批量标题折叠：返回与入参同序的 settled 结果。
       * title 是 titleSnapshot 对象 {title, ...}，不是裸字符串。
       */
      async readTitleSnapshots(ids) {
        calls.readTitleSnapshots.push([...ids])
        return ids.map((id) => {
          const s = sessions.find((x) => x.id === id)
          if (s === undefined) return { status: 'rejected', reason: new Error(`no such session ${id}`) }
          return {
            status: 'fulfilled',
            value: {
              session: { id },
              ...(s.title ? { title: { title: s.title, source: 'llm', eventSeq: 3 } } : {}),
            },
          }
        })
      },
      async readSession(id) {
        calls.readSession.push(id)
        const s = sessions.find((x) => x.id === id)
        if (!s) throw new Error(`no such session ${id}`)
        return { session: { id }, events: s.events ?? [] }
      },
    },
    sessionController: {
      async prompt(request, signal) {
        calls.prompt.push(request)
        if (promptFails) throw new Error('resume failed for session: agent preset mount failed')
        return { accepted: true }
      },
    },
    workspaceRegistry: { archivedSessionIds: archived },
    agents: {
      list: () => sessions.filter((s) => s.live).map((s) => ({ id: s.id, status: 'running' })),
    },
    tools: {
      register: (def) => { tools.set(def.name, def); return () => {} },
    },
  }

  const ctx = { get: (name) => service[name] }
  return { ctx, calls, tools }
}

/** 造一条执行上下文。 */
function execOf(sessionId = 'session-caller', cwd = '/ws') {
  return {
    agent: { id: sessionId, session: { header: { id: sessionId, cwd } } },
    signal: new AbortController().signal,
  }
}

/* ── 加载被测模块 ───────────────────────────────────────── */

const { apply, name } = await import('../lib/index.js')

/** 装一遍插件，返回注册到的工具表。 */
function mount(host) {
  apply(host.ctx)
  return host.tools
}

let passed = 0
let failed = 0
async function test(label, fn) {
  try {
    await fn()
    console.log(`  ✅ ${label}`)
    passed++
  } catch (error) {
    console.log(`  ❌ ${label}\n     ${error.message}`)
    failed++
  }
}

/* ── 用例 ───────────────────────────────────────────────── */

console.log(`\n插件名: ${name}`)
assert.equal(name, 'cross-session', 'name 必须与 cordis.patch.yml 的 id 一致')

console.log('\n[注册]')
await test('注册恰好 4 个工具，无多余', () => {
  const host = makeHost()
  const tools = mount(host)
  assert.deepEqual([...tools.keys()].sort(), ['session_list', 'session_read', 'session_reply', 'session_send'])
})

await test('每个工具都有 name/description/parameters/output.render', () => {
  const host = makeHost()
  for (const [key, tool] of mount(host)) {
    assert.equal(tool.name, key)
    assert.ok(tool.description.length > 10, `${key} 描述太短`)
    assert.equal(typeof tool.parameters, 'object')
    assert.equal(typeof tool.output.render, 'function', `${key} 缺 render`)
  }
})

console.log('\n[别名]')
await test('session_list 给出 cs_ 别名，形状合法且互不相同', async () => {
  const host = makeHost({
    sessions: [
      { id: 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'A' },
      { id: 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'B' },
    ],
  })
  const tools = mount(host)
  const out = await tools.get('session_list').execute({}, execOf())
  assert.equal(out.sessions.length, 2)
  for (const s of out.sessions) {
    assert.match(s.alias, /^cs_[0-9A-Za-z]{10}$/)
  }
  assert.notEqual(out.sessions[0].alias, out.sessions[1].alias)
})

await test('别名对同一 ID 确定性稳定（重启不变）', async () => {
  const host = makeHost({ sessions: [{ id: 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'C' }] })
  const tools = mount(host)
  const first = await tools.get('session_list').execute({}, execOf())
  const again = await makeHost({ sessions: [{ id: 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'C' }] })
  const second = await mount(again).get('session_list').execute({}, execOf())
  assert.equal(first.sessions[0].alias, second.sessions[0].alias)
})

console.log('\n[解析]')
await test('用别名能寻址到正确会话', async () => {
  const targetId = 'session-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const host = makeHost({ sessions: [{ id: targetId }] })
  const tools = mount(host)
  const listed = await tools.get('session_list').execute({}, execOf())
  const alias = listed.sessions[0].alias
  const out = await tools.get('session_send').execute({ session_id: alias, message: 'hi' }, execOf())
  assert.equal(host.calls.prompt.length, 1)
  assert.equal(host.calls.prompt[0].sessionId, targetId, '必须投给别名还原出的真实 ID')
  assert.equal(out.session_id, alias)
})

await test('真 ID 原样透传', async () => {
  const targetId = 'session-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const host = makeHost({ sessions: [{ id: targetId }] })
  const tools = mount(host)
  await tools.get('session_send').execute({ session_id: targetId, message: 'hi' }, execOf())
  assert.equal(host.calls.prompt[0].sessionId, targetId)
})

await test('被遮蔽的占位符被拒绝，并提示改用别名', async () => {
  const host = makeHost({ sessions: [] })
  const tools = mount(host)
  await assert.rejects(
    () => tools.get('session_send').execute({ session_id: 'session-00000000-0000-4000-8000-000000000000', message: 'x' }, execOf()),
    /占位符|别名/,
  )
  assert.equal(host.calls.prompt.length, 0, '被拒绝时不得投递')
})

await test('不存在的别名报错，不猜近似匹配', async () => {
  const host = makeHost({ sessions: [{ id: 'session-ffffffff-ffff-4fff-8fff-ffffffffffff' }] })
  const tools = mount(host)
  await assert.rejects(
    () => tools.get('session_send').execute({ session_id: 'cs_zzzzzzzzzz', message: 'x' }, execOf()),
    /找不到别名/,
  )
  assert.equal(host.calls.prompt.length, 0)
})

console.log('\n[投递]')
await test('只经 sessionController.prompt，不碰 agents.resume / presets.mount', async () => {
  const host = makeHost({ sessions: [{ id: 'session-11111111-1111-4111-8111-111111111111' }] })
  // 把不该被用到的接口挂成炸弹：一旦被调用就抛错。
  host.ctx.get = ((original) => (name) => {
    if (name === 'agents') {
      return {
        list: () => [],
        resume: () => { throw new Error('禁止：插件不得自己 resume（会绕过宿主的 preset 组合）') },
      }
    }
    if (name === 'agentPresets') {
      return { mount: () => { throw new Error('禁止：插件不得自己 mount preset') } }
    }
    return original(name)
  })(host.ctx.get)
  const tools = mount(host)
  await tools.get('session_send').execute({ session_id: 'session-11111111-1111-4111-8111-111111111111', message: 'hi' }, execOf())
  assert.equal(host.calls.prompt.length, 1)
})

await test('steer 是默认，followup 可选', async () => {
  const host = makeHost({ sessions: [{ id: 'session-22222222-2222-4222-8222-222222222222' }] })
  const tools = mount(host)
  const id = 'session-22222222-2222-4222-8222-222222222222'
  await tools.get('session_send').execute({ session_id: id, message: 'a' }, execOf())
  await tools.get('session_send').execute({ session_id: id, message: 'b', mode: 'followup' }, execOf())
  assert.equal(host.calls.prompt[0].mode, 'steer')
  assert.equal(host.calls.prompt[1].mode, 'followup')
})

await test('唤醒失败会抛出明确错误，不假装成功', async () => {
  const host = makeHost({
    sessions: [{ id: 'session-33333333-3333-4333-8333-333333333333' }],
    promptFails: true,
  })
  const tools = mount(host)
  await assert.rejects(
    () => tools.get('session_send').execute({ session_id: 'session-33333333-3333-4333-8333-333333333333', message: 'hi' }, execOf()),
    /投递失败.*preset mount failed/,
  )
})

await test('每次投递带唯一 requestId（宿主靠它做幂等去重）', async () => {
  const host = makeHost({ sessions: [{ id: 'session-44444444-4444-4444-8444-444444444444' }] })
  const tools = mount(host)
  const id = 'session-44444444-4444-4444-8444-444444444444'
  await tools.get('session_send').execute({ session_id: id, message: 'a' }, execOf())
  await tools.get('session_send').execute({ session_id: id, message: 'b' }, execOf())
  assert.notEqual(host.calls.prompt[0].requestId, host.calls.prompt[1].requestId)
})

await test('消息里附带回信指引，指向调用者的别名', async () => {
  const callerId = 'session-55555555-5555-4555-8555-555555555555'
  const targetId = 'session-66666666-6666-4666-8666-666666666666'
  const host = makeHost({ sessions: [{ id: callerId }, { id: targetId }] })
  const tools = mount(host)
  const listed = await tools.get('session_list').execute({}, execOf(callerId))
  const callerAlias = listed.sessions.find((s) => s.alias && s.alias.length === 13)
  await tools.get('session_send').execute({ session_id: targetId, message: '干活' }, execOf(callerId))
  const body = host.calls.prompt[0].content[0].text
  assert.match(body, /session_reply/)
  assert.match(body, /cs_[0-9A-Za-z]{10}/)
})

console.log('\n[回信]')
await test('session_reply 投给目标并标注来源', async () => {
  const callerId = 'session-77777777-7777-4777-8777-777777777777'
  const ownerId = 'session-88888888-8888-4888-8888-888888888888'
  const host = makeHost({ sessions: [{ id: callerId }, { id: ownerId }] })
  const tools = mount(host)
  const listed = await tools.get('session_list').execute({}, execOf(callerId))
  const ownerAlias = listed.sessions[0].alias
  // 找到 owner 的别名
  const out = await tools.get('session_reply').execute({ to: ownerId, text: '跑完了' }, execOf(callerId))
  assert.equal(host.calls.prompt[0].sessionId, ownerId)
  assert.match(host.calls.prompt[0].content[0].text, /来自会话 cs_/)
  assert.match(host.calls.prompt[0].content[0].text, /跑完了/)
  assert.equal(out.delivered, true)
})

console.log('\n[列表]')
await test('归档会话不出现在列表里', async () => {
  const host = makeHost({
    sessions: [{ id: 'session-99999999-9999-4999-8999-999999999999', title: '归档的' }],
    archived: ['session-99999999-9999-4999-8999-999999999999'],
  })
  const tools = mount(host)
  const out = await tools.get('session_list').execute({}, execOf())
  assert.equal(out.sessions.length, 0)
})

await test('默认只列当前工作区，all_workspaces 才跨项目', async () => {
  const host = makeHost({
    sessions: [
      { id: 'session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', cwd: '/ws' },
      { id: 'session-bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', cwd: '/other' },
    ],
  })
  const tools = mount(host)
  const scoped = await tools.get('session_list').execute({}, execOf('session-x', '/ws'))
  assert.equal(scoped.sessions.length, 1)
  const all = await tools.get('session_list').execute({ all_workspaces: true }, execOf('session-x', '/ws'))
  assert.equal(all.sessions.length, 2)
})

await test('limit 生效并夹在 1..100', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `session-${String(i).padStart(8, '0')}-0000-4000-8000-000000000000` }))
  const host = makeHost({ sessions: many })
  const tools = mount(host)
  assert.equal((await tools.get('session_list').execute({ limit: 5 }, execOf())).sessions.length, 5)
  assert.equal((await tools.get('session_list').execute({ limit: -3 }, execOf())).sessions.length, 1)
  assert.equal((await tools.get('session_list').execute({ limit: 9999 }, execOf())).sessions.length, 30)
})

await test('派生子会话（subagent）被排除', async () => {
  const host = makeHost({
    sessions: [
      { id: 'session-top00000-0000-4000-8000-000000000000', title: '顶层' },
      { id: 'session-sub00000-0000-4000-8000-000000000000', title: '子', parentSession: 'session-top00000-0000-4000-8000-000000000000' },
    ],
  })
  const tools = mount(host)
  const out = await tools.get('session_list').execute({}, execOf('x', '/ws'))
  assert.equal(out.sessions.length, 1)
  assert.equal(out.sessions[0].title, '顶层')
})

console.log('\n[标题]')
await test('标题经 readTitleSnapshots fold 出来，不是从 header 读', async () => {
  const host = makeHost({
    sessions: [
      { id: 'session-tt000001-0000-4000-8000-000000000000', title: '注册机' },
      { id: 'session-tt000002-0000-4000-8000-000000000000', title: '你在本机能做什么' },
    ],
  })
  const tools = mount(host)
  const out = await tools.get('session_list').execute({}, execOf('x', '/ws'))
  const titles = out.sessions.map((s) => s.title).sort()
  assert.deepEqual(titles, ['你在本机能做什么', '注册机'], '必须真的取到标题，不能全是空字符串')
  assert.equal(host.calls.readTitleSnapshots.length, 1, '应批量取一次，不是逐条取')
  assert.equal(host.calls.readTitleSnapshots[0].length, 2)
})

await test('无标题的会话留空，不报错也不影响别的条目', async () => {
  const host = makeHost({
    sessions: [
      { id: 'session-nt000001-0000-4000-8000-000000000000', title: '有名字' },
      { id: 'session-nt000002-0000-4000-8000-000000000000' },
    ],
  })
  const tools = mount(host)
  const out = await tools.get('session_list').execute({}, execOf('x', '/ws'))
  const withTitle = out.sessions.find((s) => s.title === '有名字')
  const without = out.sessions.find((s) => s.title === '')
  assert.ok(withTitle, '有标题的必须取到')
  assert.ok(without, '没标题的应该留空')
  // 渲染层对空标题显示「(无标题)」
  const rendered = tools.get('session_list').output.render({}, out)
  assert.match(rendered[0].text, /\(无标题\)/)
})

await test('标题读取失败不拖垮整次列表', async () => {
  const host = makeHost({
    sessions: [{ id: 'session-er000001-0000-4000-8000-000000000000', title: '好的' }],
  })
  // 让 readTitleSnapshots 整个抛错
  host.ctx.get = ((orig) => (name) => {
    const svc = orig(name)
    if (name === 'sessionQuery') {
      return { ...svc, readTitleSnapshots: async () => { throw new Error('fold blew up') } }
    }
    return svc
  })(host.ctx.get)
  const tools = mount(host)
  const out = await tools.get('session_list').execute({}, execOf('x', '/ws'))
  assert.equal(out.sessions.length, 1, '列表本身仍应返回')
  assert.equal(out.sessions[0].title, '')
})

await test('单条标题 rejected 只影响该条', async () => {  const host = makeHost({
    sessions: [
      { id: 'session-pr000001-0000-4000-8000-000000000000', title: '正常' },
      { id: 'session-pr000002-0000-4000-8000-000000000000', title: '坏的' },
    ],
  })
  host.ctx.get = ((orig) => (name) => {
    const svc = orig(name)
    if (name === 'sessionQuery') {
      return {
        ...svc,
        async readTitleSnapshots(ids) {
          const all = await svc.readTitleSnapshots(ids)
          // 把第二条改成 rejected
          return all.map((r, i) => (i === 1 ? { status: 'rejected', reason: new Error('boom') } : r))
        },
      }
    }
    return svc
  })(host.ctx.get)
  const tools = mount(host)
  const out = await tools.get('session_list').execute({}, execOf('x', '/ws'))
  const titles = out.sessions.map((s) => s.title).sort()
  assert.deepEqual(titles, ['', '正常'], '一条坏不该清空另一条')
})

await test('send/reply/read 不取标题（只有 list 需要，避免白跑 fold）', async () => {
  const id = 'session-pf000001-0000-4000-8000-000000000000'
  const host = makeHost({ sessions: [{ id, title: '有名字' }], archived: [] })
  const tools = mount(host)

  await tools.get('session_send').execute({ session_id: id, message: 'x' }, execOf())
  assert.equal(host.calls.readTitleSnapshots.length, 0, 'send 不该取标题')

  await tools.get('session_reply').execute({ to: id, text: 'y' }, execOf())
  assert.equal(host.calls.readTitleSnapshots.length, 0, 'reply 不该取标题')

  await tools.get('session_read').execute({ session_id: id }, execOf())
  assert.equal(host.calls.readTitleSnapshots.length, 0, 'read 不该取标题')

  await tools.get('session_list').execute({}, execOf())
  assert.equal(host.calls.readTitleSnapshots.length, 1, '只有 list 取标题')
})

await test('session_list 标出「你自己」并给出自己的别名', async () => {
  const selfId = 'session-self0001-0000-4000-8000-000000000000'
  const otherId = 'session-othr0001-0000-4000-8000-000000000000'
  const host = makeHost({
    sessions: [
      { id: selfId, title: '我', cwd: '/ws', createdAt: 2 },
      { id: otherId, title: '别人', cwd: '/ws', createdAt: 1 },
    ],
  })
  const tools = mount(host)
  const out = await tools.get('session_list').execute({}, execOf(selfId, '/ws'))
  const me = out.sessions.find((s) => s.is_self === true)
  const other = out.sessions.find((s) => s.is_self !== true)
  assert.ok(me, '必须有一条被标成自己')
  assert.equal(me.title, '我')
  assert.ok(other, '别人不该被标成自己')
  assert.equal(other.title, '别人')
  assert.match(out.self_alias, /^cs_[0-9A-Za-z]{10}$/)
  assert.equal(out.self_alias, me.alias, 'self_alias 必须等于自己那行的别名')
  const rendered = tools.get('session_list').output.render({}, out)[0].text
  assert.match(rendered, /你自己/)
  assert.match(rendered, new RegExp(out.self_alias), '渲染里要写出自己的别名')
})

await test('自己不在列表范围内时也不崩（self_alias 仍给出）', async () => {
  const host = makeHost({ sessions: [{ id: 'session-othr0002-0000-4000-8000-000000000000', title: '别人', cwd: '/ws' }] })
  const tools = mount(host)
  const out = await tools.get('session_list').execute({}, execOf('session-nothere-0000-4000-8000-000000000000', '/ws'))
  assert.equal(out.sessions.length, 1)
  assert.equal(out.sessions[0].is_self, false)
  assert.match(out.self_alias, /^cs_/)
})

await test('给自己发消息被拒绝（防回环）', async () => {
  const selfId = 'session-self0003-0000-4000-8000-000000000000'
  const host = makeHost({ sessions: [{ id: selfId, title: '我', cwd: '/ws' }] })
  const tools = mount(host)
  await assert.rejects(
    () => tools.get('session_send').execute({ session_id: selfId, message: 'hi' }, execOf(selfId, '/ws')),
    /自己/,
  )
  assert.equal(host.calls.prompt.length, 0, '被拒时不得投递')
})

await test('给自己回信也被拒绝', async () => {
  const selfId = 'session-self0004-0000-4000-8000-000000000000'
  const host = makeHost({ sessions: [{ id: selfId, title: '我', cwd: '/ws' }] })
  const tools = mount(host)
  await assert.rejects(
    () => tools.get('session_reply').execute({ to: selfId, text: 'hi' }, execOf(selfId, '/ws')),
    /自己/,
  )
  assert.equal(host.calls.prompt.length, 0)
})

console.log('\n[读取]')
await test('session_read 取最近 N 条用户/助手消息', async () => {
  const host = makeHost({
    sessions: [{
      id: 'session-rd000000-0000-4000-8000-000000000000',
      events: [
        { type: 'user/message', data: { content: [{ type: 'text', text: '第一条' }] } },
        { type: 'assistant/message', data: { content: [{ type: 'text', text: '回一' }] } },
        { type: 'tool/call', data: {} },
        { type: 'user/message', data: { content: [{ type: 'text', text: '第二条' }] } },
        { type: 'assistant/message', data: { content: [{ type: 'text', text: '回二' }] } },
      ],
    }],
  })
  const tools = mount(host)
  const out = await tools.get('session_read').execute({ session_id: 'session-rd000000-0000-4000-8000-000000000000', tail: 2 }, execOf())
  assert.deepEqual(out.messages.map((m) => m.text), ['第二条', '回二'])
  assert.deepEqual(out.messages.map((m) => m.role), ['user', 'assistant'])
})

await test('session_read 不触发投递、不唤醒', async () => {
  const host = makeHost({ sessions: [{ id: 'session-ro000000-0000-4000-8000-000000000000', events: [] }] })
  const tools = mount(host)
  await tools.get('session_read').execute({ session_id: 'session-ro000000-0000-4000-8000-000000000000' }, execOf())
  assert.equal(host.calls.prompt.length, 0, 'read 绝不该唤醒目标')
})

await test('read 的 tail 夹在 1..50', async () => {
  const events = Array.from({ length: 80 }, (_, i) => ({ type: 'user/message', data: { content: [{ type: 'text', text: `m${i}` }] } }))
  const host = makeHost({ sessions: [{ id: 'session-tl000000-0000-4000-8000-000000000000', events }] })
  const tools = mount(host)
  const out = await tools.get('session_read').execute({ session_id: 'session-tl000000-0000-4000-8000-000000000000', tail: 999 }, execOf())
  assert.equal(out.messages.length, 50)
})

console.log('\n[截断]')
await test('超长消息按 32 KiB 截断，且不切碎多字节字符', async () => {
  const host = makeHost({ sessions: [{ id: 'session-cl000000-0000-4000-8000-000000000000' }] })
  const tools = mount(host)
  // 用 3 字节字符构造，确保截断点会落在字符中间，检验边界回退
  const big = '中'.repeat(20000)
  await tools.get('session_send').execute({ session_id: 'session-cl000000-0000-4000-8000-000000000000', message: big }, execOf())
  const body = host.calls.prompt[0].content[0].text
  assert.ok(Buffer.byteLength(body, 'utf8') < 40 * 1024, '必须真的截断了')
  assert.match(body, /已按 32 KiB 截断/)
  assert.ok(!body.includes('\ufffd'), '不得出现替换字符（说明切碎了 UTF-8）')
})

console.log(`\n${'─'.repeat(50)}`)
console.log(`通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
