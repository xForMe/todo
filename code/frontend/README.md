# 前端

2026-11-14 视觉重构：REQ-O-003 / PRO-009 / TECH-014 / TEST-011。仍为原生脚手架，无新增应用依赖；tokens.css 为设计变量，style.css 为骨架与共用组件，workbench.css 为首页，workbench-view.js 为纯展示辅助。旧版位于 archive/frontend/REQ-O-003-before。CSS自适应覆盖桌面侧栏、平板顶部导航和手机单列；事件表仅内部滚动。

来源 REQ-F-001、PRO-001，技术 TECH-004。index.html、style.css、app.js 为正式切片前端，由后端同源托管。请通过 code/README.md 启动，直接打开文件不能调用接口。业务数据只存数据库，不导入原型 localStorage 数据。

事件迁移由 `event-move.js` 实现（REQ-F-011 / TECH-015），复用抽屉、token 与图标；入口在事件详情和编辑中。目标联动选择、影响预览、确认写入、刷新后恢复均由独立迁移端点和回执处理。
