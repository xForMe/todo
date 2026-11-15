# 代码入口

编码前阅读 TECH-003、TECH-002。当前实现 REQ-F-001，技术方案 TECH-004，验证 TEST-002。

## 本地启动（PowerShell）

```powershell
Set-Location E:\work\demo\todo\code\backend
uv sync --locked
# 仅首次初始化或明确需要更新表结构时执行：uv run --locked alembic upgrade head
uv run --locked uvicorn todo_backend.main:create_app --factory --host 127.0.0.1 --port 8000
```

访问 http://127.0.0.1:8000 ，页面自动连接。本机会话由浏览器自动建立，无需输入令牌。当前业务数据使用 code/.env 配置的 PostgreSQL；旧 backend/data/todo.sqlite3 仅作历史保留。本次浏览器联调写入的名称以「浏览器联调-」标记，不是真实业务数据。

## 检查

前端视觉切片 REQ-O-003 还须检查 `node --check ../frontend/workbench-view.js`。全部前端脚本可在 `code/backend` 执行：`Get-ChildItem ../frontend -Filter '*.js' | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE) { throw $_.Name } }`。

浏览器回归脚本为 `code/scripts/verify-ui.cjs`，在已有 Playwright + Chrome 工具环境运行（必要时设置 NODE_PATH 指向工具环境的 node_modules），不属于应用运行依赖。默认对本机8000做只读页面检查，所有表单失败模拟均由浏览器拦截，禁止真实写入；输出在 runtime/ui-redesign。需要已有目标和未结束事件，空库不会冒充检查通过。可通过 TODO_UI_URL 指定隔离服务。

```powershell
uv run --locked python ../scripts/check.py
node --check ../frontend/app.js
```

后端为 FastAPI/SQLAlchemy/Alembic，前端为独立 HTML/CSS/JS，同源托管。数据库不在 runtime。更换数据库用 TODO_DATABASE_URL，账户标识用 TODO_OWNER_ID，配置示例见 config。正式 PostgreSQL 需安装 psycopg、迁移与独立验证；修改连接串不会搬运 SQLite 数据。停写后备份 SQLite 文件，禁止用降级删业务表。

仅限个人本机开发。当前本机会话不是正式账号系统，不直接公开部署。无外部调用。/health/live 是存活探针，/docs 提供 API 契约。

## 一键启动

双击 `code/start.cmd`。启动后打开网页即可自动连接，无需输入访问令牌。窗口保持打开，Ctrl+C 停止；会话自动管理。

也可在任意工作目录运行：

```powershell
& E:\work\demo\todo\code\scripts\start.ps1
# 修改端口；已安装依赖时跳过同步
& E:\work\demo\todo\code\scripts\start.ps1 -Port 8001 -SkipSync
# 仅检查环境，不安装依赖、迁移或启动
& E:\work\demo\todo\code\scripts\start.ps1 -CheckOnly
```

启动入口只接受 PostgreSQL。依赖同步和数据库连接/版本检查通过后，如端口由本项目旧服务占用，先结束旧进程并确认端口释放，再启动新服务；其他程序占用时停止并提示，不误杀。检查失败保留旧服务。`-CheckOnly` 只检查环境和端口身份，即使已运行也不会结束服务。已移除 `-Migrate` 参数，数据库升级须先停写和备份，再按 TECH-013 显式执行。


## 飞书来源与 AI（2026-11-13）

云文档在事情/事件中关联，聊天在系统设置中配置；保存授权后应用运行期间周期读取。迁移为 0002—0005（0005 解除旧聊天绑定并暂停），普通启动不迁移。AI 只在单独勾选提交授权后调用 UAIAPI，读取 code/.env 的 TODO_UAIAPI_KEY；模型默认 deepseek-v4-flash-ga-260731。真实密钥不得提交。

建议确认后才写事件；铃铛配置私聊催办，默认关闭，需核实责任人 open_id、内容和时间。关闭应用不会后台发送。发送不明暂停，不自动重试。聊天当前最多最新20条一页；完整分页仍待补齐；聊天跨模块识别，归属不确定的新行动待人工选择事情。验证与边界见 TEST-005。

统一检查还需执行 `node --check ../frontend/sources.js`、`node --check ../frontend/suggestions.js`、`node --check ../frontend/follow.js`。


## 删除与换绑（2026-11-14）

迁移 0006 新增删除回执及 SQLite 写入约束，不修改既有业务数据。目标/模块/事情的编辑抽屉中提供删除入口；有下级或关联资料须选择同类接收位置，完整转移后逻辑删除。受影响来源、催办暂停，历史保留。结果不明可点击“核对待确认删除”，同操作不重复执行。统一检查增加 `node --check ../frontend/deletion.js`。验证见 TEST-006；当前仅支持 SQLite。

AI 新事件核对支持目标/模块/事情分别选择及确认新建模块/事情；模型只推荐，确认后一次事务入库。无新迁移，重启服务获取新逻辑。详见 TEST-005 的 SRC-FEISHU-006。

## 事件拆分与关联（2026-11-14）

REQ-F-007，TECH-010，TEST-007。迁移 0007 新增事件父子关系、独立关联及操作回执，既有事件的事情归属不变。升级前停服务并备份，运行 alembic upgrade head，普通启动仍不迁移。

事件行拆分图标打开右抽屉，可手动添加或明确授权提交当前事件及子事件上下文给 UAIAPI；候选编辑勾选确认后入库。详情提供关联和后续跟进。父事件手动完成受后代状态约束，按最末级事件统计；已完成父事件需先手动重开才能继续拆分。

统一检查新增 node --check ../frontend/events.js 与 node --check ../frontend/icons.js。运行测试不会调用真实模型。8000 旧缓存可使用 /?revision=events-0007 入口。当前仍为本机开发版，生产与 PostgreSQL 未验证。

SRC-EVENT-005：拆分入口现自动生成 AI 建议，使用当前事件及已有子事件上下文；无需再次勾选授权。用户确认后才创建子事件。补充要求可选，失败需手动重试。

## 事情优先级与每周评估
REQ-F-008 / TECH-011 / TEST-008；迁移 0008 新增优先级表，普通启动不迁移。事情旁标签打开右抽屉，保存调整与确认本周评估分开；北京时间周一换周，仅应用内提醒。统一检查增加 node --check ../frontend/priorities.js。升级前停止服务并备份。

## 持续关注与全局工作台
REQ-F-009、REQ-F-010 / TECH-012 / TEST-009。迁移0009仅新增thing_attention表；普通启动仍不迁移。首页为全局工作台，可切回目标与事情；关注与优先级独立，完成/取消后保留标记，活跃关注默认收起已结束事情。首页支持目标筛选、行动分页与只读详情定位，优先级评估使用原入口。跟进取关系source（新事件），target为历史事件。

统一检查新增 `node --check ../frontend/workbench.js`，仍须核对全部既有脚本。工作快照不触发外部适配器；关注结果未知先查询回执，不自动重试。当前接口全量读取账号快照、前端每页20条；超大规模性能尚未验证。升级前停止服务并备份，核对既有数据后重启。

## 飞书消息去重（2026-11-14）
SRC-FEISHU-007 / REQ-F-002、REQ-F-003 / TECH-007 / TEST-005。迁移0010新增消息处理回执，按账号、聊天、消息ID去重；旧消息成功识别后不会因新增消息、乱序、重启或重新关联再次生成。识别成功但无建议也记录，失败不记录。升级前停服务备份，再运行 `uv run --locked alembic upgrade head`；普通启动不迁移。迁移只回填与成功hash一致的现存快照，无法还原未保存的历史处理记录；已有重复建议保留。

## PostgreSQL 切换（2026-11-14）

SRC-DB-001 / TECH-013 / TEST-010。本节替代上文“PostgreSQL 待安装”“仅 SQLite”和启动入口拒绝远程库的历史限制。应用继续仅本机访问。

`code/.env` 配置 TODO_DB_HOST、TODO_DB_PORT、TODO_DB_NAME、TODO_DB_USER、TODO_DB_SSLMODE 和 DB_PASSWORD（兼容小写 db_password）；继承 TODO_DATABASE_URL 优先。驱动已锁定，不需要手工安装。示例见 config/postgresql.env.example。

普通 `code/start.cmd` 读取已配置数据库，检查连接和迁移版本，不自动迁移。启动入口不提供 -Migrate；显式升级前先停写和备份，再运行 `uv run --locked alembic upgrade head` 并核对数据。迁移 0011 补齐 PostgreSQL 写入约束和大整数时间戳。

默认统一检查只使用临时 SQLite，关闭后台来源读取。显式设置 TODO_TEST_DATABASE_URL 后运行 pytest，会在 todo 数据库创建随机 todo_validation_ 前缀 schema，测试后删除，只用于明确授权的数据库验证；不会读取或清空 public。不要将密码写入命令历史。

已归档的一次性导入脚本 `archive/scripts/20261115-postgresql/transfer_sqlite.py` 仅接受授权目标且 public 为空；需先停服务并配置目标，通过 SQLite backup API 备份后导入、逐表核对并保存 verification.json。拒绝非空目标，不自动重试。旧 SQLite 保留；切换后如需回退，须先核对新写入，不能直接切回丢失增量。

## 事件迁移（Issue #1）
REQ-F-011 / TECH-015 / TEST-012。事件详情或编辑抽屉的“迁移事件”入口支持选择目标、模块、事情，确认后移动事件及全部子事件。跨迁移范围的关联须先解除；相关文档读取及催办暂停，待确认建议作废保留记录。版本与回执复用现有表，无需数据库迁移，重启后端并刷新页面生效。未知结果可通过全局栏“核对待确认迁移”查询。

统一检查覆盖 `tests/test_event_move.py`，前端语法检查包含 `event-move.js`。浏览器回归为 `code/scripts/verify-event-move.cjs`，须在关闭来源读取的临时数据库服务上显式设置 `TODO_MOVE_TEST_URL` 后运行；禁止指向真实业务服务，脚本拒绝8000端口。需要现有 Playwright + Chrome 环境，可使用 NODE_PATH 指向工具 node_modules。截图与报告输出至 runtime/issue1-ui。

## 常用脚本与归档（2026-11-15）

`code/scripts` 保留启动、数据库检查、统一检查及两份浏览器回归脚本。`migrate_events.py`、`transfer_sqlite.py` 和 `capture-ui.cjs` 已移至 `archive/scripts/20261115-postgresql/`，不属于当前操作入口。应用底层及离线测试仍支持 SQLite；日常一键启动只使用 PostgreSQL。


## 事情与事件删除（Issue #2）
REQ-F-012 / TECH-017 / TEST-014。事情详情、事件行及事件详情/编辑提供删除入口；居中弹窗确认（无侧滑），事情有内容须换绑，事件有子事件须先迁移或处理。事件资料转至所属事情并暂停读取，催办暂停，待处理建议作废，关联历史保存在删除回执。无需迁移表结构，重启后端并刷新页面生效；未知结果通过全局栏核对，不自动重试。浏览器验证脚本 verify-deletion.cjs 只接受显式 TODO_DELETE_TEST_URL 指定的隔离本机非8000服务。
