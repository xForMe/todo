# TECH-014 工作空间视觉重构

**类型**：技术方案
**状态**：review
**负责人**：待指定
**更新时间**：2026-11-14
**source_requirements**：REQ-O-003
**source_technical**：TECH-003、TECH-005、TECH-012
**关联文档**：PRO-009、TEST-011

SRC-UI-006：移除sourceDrawer内静态提示段；sourceContext在聊天模式清空并hidden，在云文档模式恢复实际所属对象。保留节点供既有来源切换使用，不改sourceConsent、aiConsent及写入逻辑。

SRC-UI-005：精简渲染文案，不改统计与北京时间判断规则。新增操作使用toolbarActions整体参与响应式布局；priorityLabel保留原生button语义与评估处理，仅改为标签外观；事件标题和完成控件使用相同首行行高，取消控件顶部偏移。必要授权、失败和结果不明反馈保留；空说明不生成占位段落。样式规则原位更新，不用隐藏页面横溢处理对齐问题。

自适应断点：1280px压缩侧栏与间距；1100px首页行动与辅助区纵向排列、关注和评估并排；1000px侧栏转顶部导航；800px事情与事件区纵向；600px顶部导航分两行、辅助区单列、表单单列。表格自身保留880px最小宽度、手机960px以容纳44px操作按钮，横向滚动限制在tableWrap。所有网格内容设min-width:0，长标题和路径换行，选择器宽度受容器限制。抽屉100dvh且最大宽度100vw，不用页面隐藏overflow掩盖布局问题。

图标遵循 REQ-F-007 的 icon+提示约定，保留无障碍名称；修正旧版编辑/删除/暂停/恢复的图标映射，不改操作语义。新增workbench-view.js仅提供首页展示辅助函数，在workbench.js之前加载。

沿用原生 HTML/CSS/JavaScript 和 FastAPI 同源托管，不迁移框架、不增加运行依赖。tokens.css 定义基础→语义→组件变量，style.css 统一应用骨架和既有组件，workbench.css 定义首页。旧版文件完整保存在 archive/frontend/REQ-O-003-before。

参考 Linear 的低干扰导航、弱化分隔和层级一致性：[官方设计说明](https://linear.app/now/behind-the-latest-design-refresh)。参考 Todoist 的任务标题与元数据分层、快速切换筛选：[官方任务管理页面](https://www.todoist.com/task-management)。只借鉴布局原则，不复制品牌或引入其功能。

保留 main、navGroup 的工作台初始化契约、业务 DOM ID、接口及所有写入流程。仅修改工作台展示模板和展示状态；目标按钮用当前目标 ID 过滤，数量由原快照计算。抽屉继续使用原生 dialog、焦点约束与 Escape。来源设置保留读取和模型授权文案。

当前视觉基线改为浅色工作区、深蓝灰侧栏、蓝色主操作；本机中文字体；正文14–16px、标题28px；4px间距阶梯。状态用文字及色彩共同编码。375px下采用顶部导航、纵向内容和内部滚动表格；尊重 reduced-motion。此节替代 TECH-005 的旧视觉基线，其强制验证流程仍适用。

安全：不改数据库、不执行迁移、不更改来源/催办开关。真实应用仅只读截图与导航；保存/错误/空态等使用隔离的浏览器接口夹具验证，不产生真实记录。共享浏览器占用时使用独立 Chromium，gstack 辅助脚本不可用按 TECH-005 降级使用检查清单并记录真实截图。
