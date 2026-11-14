# TECH-004 手动工作闭环实现

**类型**：技术方案
**状态**：implemented
**负责人**：待指定
**更新时间**：2026-11-13
**source_requirements**：REQ-F-001
**source_technical**：TECH-002、TECH-003
**关联文档**：PRO-001、TEST-002、PROJECT.md

## 范围与选择

来源：用户确认原型并授权开发，明确开发 SQLite、正式 PostgreSQL。实施选择：SQLAlchemy 2.0 + Alembic，前端原生模块独立存放，复用已确认视觉，不引入前端框架。work 领域共享层级约束与事务，不为四种对象重复四套同构实现。
SQLAlchemy 方言支持 SQLite/PostgreSQL：https://docs.sqlalchemy.org/en/20/dialects/ 。SQLAlchemy/Alembic 为维护中的 MIT 项目，本次核对锁定元数据；无云服务费用，增加依赖与迁移维护成本。未执行全供应链安全审计。

## 数据与接口

work_items 保存 UUID、type、parent 外键、账户标识、名称说明、计划时间、责任人、状态和 version。目标/模块不填写行动字段。时间为 Asia/Shanghai 的无时区计划墙钟时间，API 使用 ISO datetime（不接受带时区），页面明确标记。四状态与空值遵循已确认原型；禁止改变 type、parent、账户。操作表按账户与 operation_id 唯一，保存请求指纹与结果对象 ID。
GET /api/items 返回当前账户对象；POST /api/items 创建；PUT /api/items/{id} 修改需 expected_version；GET /api/operations/{id} 核对操作结果。写后事务提交，再读取对象返回；读取失败返回 503 与操作标识。客户端不自动重试写入，不确定时保留原操作标识并提供查询按钮。已应用操作不再次执行；同标识不同载荷拒绝。更新采用版本条件更新，冲突 409；无变化重复完成保持版本不变。输入 schema 与模型分离，service 事务和业务检查、repository 查询、router 身份与 HTTP 转换。

## 安全与部署

仅个人开发运行，绑定 127.0.0.1。用户明确取消手动访问令牌流程，改为每次进程启动生成随机会话密钥，浏览器自动调用 GET /api/session，获取 HttpOnly、SameSite=Strict 会话 Cookie；不打印、不落盘密钥。会话端点要求 X-Todo-Client: web，检查 Origin/Sec-Fetch-Site；TrustedHost 仅接受本地主机，不启用 CORS。刷新自动建立会话。此边界信任本机用户与进程，不是正式多用户登录。服务端固定 TODO_OWNER_ID，责任人只是文字。自动会话验证所有业务读写；不启用跨域。无自动任务、无飞书调用、无外部写入。正式登录、TLS、生产部署与 PostgreSQL 运行验证仍待后续完成，不能公开暴露开发服务。

## 迁移与恢复

TODO_DATABASE_URL 默认 code/backend/data/todo.sqlite3（绝对解析），业务数据库不放 runtime。Alembic upgrade head 显式建表，启动不隐式建表。不提供破坏性重置；迁移前停写并复制 SQLite 文件备份。PostgreSQL 后续配置连接串与 psycopg 驱动，需先空库升级、数据迁移设计、事务与恢复验证；切连接不会自动搬运 SQLite 数据。

## 异常

空名称、错误父类型、父项不存在/不属于账户、错误时间顺序、无权、过期版本、幂等键冲突均拒绝。SQLAlchemy 事务失败回滚，对外不暴露数据库异常。客户端失败保留表单与操作标识，需人工核对后明确重试。

## 本地启动入口补充

来源：2026-11-12 用户要求启动脚本。code/start.cmd 调用 scripts/start.ps1；入口仅绑定本机，使用默认 SQLite，迁移前保留本地备份。本机自动建立会话，不需要交互输入凭据。自定义连接使用手动流程，避免意外迁移远程库。提供 CheckOnly 和 SkipSync 参数，端口冲突、依赖或迁移失败立即终止。

## REQ-O-002 启动策略更新（2026-11-13）
替代上文默认迁移行为：普通启动只复用原库，不备份或迁移；无库时停止并提示 -Migrate。显式 -Migrate 才备份并执行 upgrade head；失败停止。保留自定义连接拒绝边界，不接入正式 PostgreSQL。

## 日期粒度修订（2026-11-13）

来源：用户明确要求计划开始和结束只到天。事情与事件统一输入、展示 YYYY-MM-DD，可为空，允许同一天；结束日期不得早于开始日期。新写入不接受时分。历史本地日期时间读取时仅返回原日历日期，不做时区换算，不批量改写既有数据；用户再次保存时按日期存储。此规则替代此前时分粒度描述。

## 用户验收记录（2026-11-13）

来源：当前对话用户明确表示“我觉得这个需求可以了，验收通过”。本次验收覆盖 REQ-F-001 手动工作闭环及 REQ-O-001 页面优化，包含事情与事件的计划日期仅到天。本切片标记为 implemented；此前待用户验收描述为历史阶段。PostgreSQL、生产部署及后续切片不包含在本次验收范围内。

## PostgreSQL 兼容更新（2026-11-14）
SRC-DB-001 / REQ-O-002：正式库切换与当前兼容性实现以 TECH-013 为准；替代上文 SQLite 专属拒绝及不接入正式库的阶段限制。验证范围见 TEST-010，不改变原业务验收状态。
