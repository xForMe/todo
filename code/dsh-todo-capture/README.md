# 行间 · 会话事件 / To Do events

REQ-F-022 / TECH-029、REQ-F-023 / TECH-030。查找已有事情与事件，并在 Harness 中核对后新建一条事件或将已有事件标为已完成。目标不明确时先选择，不跳转页面、不生成草稿、不自动新建上级。完成事件时，批准提示显示事件标题、完整归属和状态变更，并提示可能暂停该事件的催办。

两种写入共用 Harness Desktop 的「允许一次」批准流程和独立的 `TODO_DSH_DIRECT_TOKEN` 签名凭据；查询使用 `TODO_DSH_CAPTURE_TOKEN`。没有可用的人工答复器、当前策略拒绝或凭据缺失时不写入。结果不明只查询原操作回执，不重新提交。插件只连接本机行间，不扫描会话历史。

Find an existing matter or event, then review and approve a single creation or completion in Harness. Both writes use the same one-time approval flow and require a separate local signing credential. If the outcome is uncertain, look up the original operation without resubmitting.
