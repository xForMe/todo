# 行间 · 会话草稿 / To Do capture

REQ-F-022 / TECH-029。通过本机 MCP 连接行间。请明确告诉 Harness 要整理哪段文字，例如「帮我记个待办：整理下周的验收清单」。已配置录入模型时，行间只将所选文本和必要的工作归属经该模型整理为草稿。

在行间顶栏「事件识别 → DSH 草稿」核对、编辑并确认创建正式事件。此插件不会扫描历史会话、不发送催办，也不会直接创建工作项。关闭插件不删除已有草稿。

Connects to To Do on this machine. Ask Harness to draft a to-do from selected text, then review it under Event recognition → DSH drafts in To Do. Only the To Do page can confirm a formal event. The connection requires the local `TODO_DSH_CAPTURE_TOKEN` credential; generating new drafts also requires an explicitly selected capture model in To Do.
