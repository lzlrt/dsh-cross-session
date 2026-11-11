# @lzlrt/dsh-cross-session — 跨会话协同

四个工具，只做一件事：**让 DSH 的会话之间能互相说话**。

| 工具 | 作用 |
|---|---|
| `session_send` | 给另一个会话发消息（该会话关着就自动叫醒它再去送） |
| `session_reply` | 回信给发消息的那个会话 |
| `session_list` | 列出所有会话（名字、状态、别名、模型） |
| `session_read` | 看某个会话最近说了什么（不叫醒它） |

典型用法：一个会话接到大任务，拆开，开几个会话分头做（写代码 / 查资料 / 跑测试），做的过程中可以随时互相问、互相补料，做完回信汇总。

## 安装

```bash
dsh plugin --profile web add @lzlrt/dsh-cross-session
```

装完重启 DSH。bundle patch 会自动把 `cross-session` 这一行插进组合。

## 为什么只有四个工具

没有审批桥，没有危险命令判定，没有权限夹紧——那些属于「安全边界」，不属于「让人和会话之间说话」。本插件只调用宿主自己的 `sessionController`：

- **发消息** → `sessionController.prompt()`，与 GUI 输入框走同一条路
- **冷会话唤醒** → `prompt()` 内部 `resolveAgent()` 自动恢复，preset 由宿主 `composeAgent` 解析

因此宿主怎么给 GUI 会话配能力，就怎么给这里叫醒的会话配能力，本插件没有任何机会拼出一个「只有插件工具、没有读写文件能力」的空壳会话。

## 工具说明

### session_send

```text
session_send({ session_id: "cs_XXXXXXXXXX", message: "帮我把 tools/memctl.py 的 check 命令跑一遍" })
```

- `session_id`：`session_list` 给出的 `cs_` 别名，或真实 `session-<uuid>`
- `message`：要发的内容
- `mode`：`steer`（默认，插队）/ `followup`（等它这轮结束）
- `reply_to`：让它做完回信给谁（默认就是你自己）

目标会话没打开时自动唤醒。**唤醒失败会明确报错**，不会假装发出去了。

### session_reply

```text
session_reply({ to: "cs_XXXXXXXXXX", text: "跑完了，3 个问题，详情如下……" })
```

任务会话干完活用它回话。`to` 一般取自任务消息里附带的「回信给 cs_xxx」。

### session_list

```text
session_list({ limit: 20 })
```

给出别名、标题、是否在运行、模型、所属目录。**用过期的别名会报错并提示重新 list**，不会串到别的会话。

### session_read

```text
session_read({ session_id: "cs_XXXXXXXXXX", tail: 20 })
```

看对方最近的消息，不唤醒。用于「它到底干到哪了」。

## 别名

会话真 ID 是 `session-<uuid>`，在模型可见文本里会被显示层替换成占位符，复制回来没法用。所以每个 ID 派生一个 `cs_` + 10 位 base62 的短别名（FNV-1a 确定性派生，重启不变，不落盘）。

| 输入 | 行为 |
|---|---|
| `cs_XXXXXXXXXX` | 在会话列表里查找并还原成真 ID |
| `session-<uuid>` | 原样透传 |
| 被遮蔽的占位符 | 拒绝，并提示改用别名 |
| 找不到的别名 | 报错，不猜 |

## 已知限制

- **跨工作区**：`session_list` 默认只列当前工作区。要跨项目用 `all_workspaces: true`。别名解析基于全量列表，所以跨工作区也能寻址。
- **归档会话不可写**：归档的会话发消息会被宿主拦住，先取消归档。
- **同名标题不唯一**：只认别名/ID，不认标题。
- 消息正文按 32 KiB UTF-8 截断（防止把上下文撑爆）。
