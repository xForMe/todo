# 需求索引

- [REQ-O-003 工作空间视觉重构](optimization/REQ-O-003-workspace-redesign.md)：review；PRO-009、TECH-014、TEST-011；开发版待视觉验收。

| ID | 类别 | 需求 | 状态 | 原型 | 技术 | 测试 |
|---|---|---|---|---|---|---|
| REQ-F-001 | 功能 | [手动组织工作与完成事件](functional/REQ-F-001-manual-work-loop.md) | implemented，2026-11-13 用户验收通过 | PRO-001、PRO-002 | [TECH-004](../technical/TECH-004-manual-work-loop.md) | [TEST-002](../testing/TEST-002-manual-work-loop.md) |

性能需求暂未建立，后续按 PROJECT.md 分类及来源规则新增。


- [REQ-O-001 视觉优化](optimization/REQ-O-001-frontend-polish.md)：implemented，2026-11-13 用户验收通过；PRO-002 / TECH-005 / TEST-003。

- REQ-O-002 | 本地数据保留 | optimization/REQ-O-002-local-data-preservation.md | approved | PRO-001（页面不变） | TECH-004 | TEST-002

## 飞书与 AI 闭环草案

| ID | 功能需求 | 状态 | 下游状态 |
|---|---|---|---|
| REQ-F-002 | [飞书来源读取与关联](functional/REQ-F-002-feishu-source-intake.md) | draft | 原型、技术、正式测试待建；独立证据 TEST-004 |
| REQ-F-003 | [AI 识别与候选行动确认](functional/REQ-F-003-ai-action-review.md) | implemented（2026-11-14，本次分层归属切片验收） | PRO-006、TECH-007、TEST-005；范围以 SRC-ACCEPT-AI-001 为准 |
| REQ-F-004 | [责任人私聊自动催办](functional/REQ-F-004-private-follow-up.md) | draft | 原型、技术、正式测试待建；独立证据 TEST-004 |
| REQ-F-005 | [事件完成率](functional/REQ-F-005-event-completion-rate.md) | draft | 原型、技术、测试待建 |

2026-11-13 原型状态更新：REQ-F-002 至 REQ-F-005 对应 [PRO-003](../prototype/PRO-003-feishu-ai-loop.md)（review），取代上表原型待建状态；其余下游状态不变。

- [REQ-F-006 删除与下级换绑](functional/REQ-F-006-delete-rebind.md)（review）

- [REQ-F-007 事件拆分与同事情关联](functional/REQ-F-007-event-decomposition-links.md)（draft）：需求分析中，原型、技术、测试待确认后建立。

- [REQ-F-008 事情优先级与周期评估](functional/REQ-F-008-attention-review.md)（review）：每周一次应用内提醒已确认；PRO-007 已确认；TECH-011 / TEST-008，开发版已交付待验收。

2026-11-14：REQ-F-007 已交付开发版（review），PRO-005 / TECH-010 / TEST-007；REQ-F-005 的最末级统计修订同步本切片，待业务验收。



## 全局首页与持续关注（2026-11-14）

| ID | 需求 | 状态 | 下游 |
|---|---|---|---|
| REQ-F-009 | [事情持续关注](functional/REQ-F-009-continuous-attention.md) | implemented，2026-11-14 用户验收通过 | PRO-008；TECH-012 / TEST-009 |
| REQ-F-010 | [全局工作台](functional/REQ-F-010-global-workbench.md) | implemented，2026-11-14 用户验收通过 | PRO-008；TECH-012 / TEST-009 |

顺序：先 REQ-F-009，再 REQ-F-010；两片当前 SQLite 开发版均已于2026-11-14获用户验收通过。


