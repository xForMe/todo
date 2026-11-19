# 代码入口

## 事件前置与当前行动

REQ-F-020 / PRO-020 / TECH-026 / TEST-023。迁移 0021 新增事件前置关系表，原普通关联和跟进保留。切换本机业务服务前先停写、备份，再显式应用迁移并核对，启动不自动迁移。

验证使用统一检查和 `node code/scripts/verify-event-dependencies.cjs`。浏览器脚本需已有 Playwright 与 Chrome，使用合成数据和模型替身，截图保存至 runtime/event-dependencies-ui。

## 时间变更与工作台延期

REQ-F-016 / PRO-016 / TECH-022 / TEST-019。工作台行动行“延期变更”直接打开日期、原因与历史抽屉；原编辑入口同样校验原因，标题后小标识回看记录。迁移0017新增plan_baselines（旧数据明确历史不完整）和plan_changes，统一写入与原操作回执同事务。已结束对象须先独立重开。未知结果只核对不重发。改期后请检查并重新保存催办配置，Worker的旧版本暂停保护继续有效。

隔离浏览器检查：`node code/scripts/verify-plan-history.cjs`（需Playwright与Chrome），所有HTTP请求均拦截。正式迁移前停写备份，可使用 `uv run --locked python ../scripts/deploy_matter_planning.py --apply --revision 0017 --output <新的备份目录>`，从0016升级；启动不自动迁移。验证边界及本机部署结果以TEST-019为准。

## 当日跟进（REQ-F-017，替代原每日标记入口）
按PRO-017开发，TECH-023 / TEST-020承接。事项旁纯图标打开居中小窗口，右上角保存与关闭，正文直接输入；同日多条追加。保存时调用已配置模型，明确当前事项的延期与日期/原因通过原文核验后，同事务更新计划、跟进和原延期记录。普通跟进不改工作状态；已保存事项仍可继续追加。未知结果只核对，刷新后恢复操作标识；识别失败可明确选择仅保存跟进。

0018新增action_followups，保留旧标记；旧记录无正文时明确提示。其他环境须停写备份，执行 `uv run --locked python ../scripts/deploy_matter_planning.py --apply --revision 0018 --output <新的备份目录>`（code/backend目录，从0017升级），普通启动不迁移。

验证入口：统一检查；`node code/scripts/verify-daily-follow-up.cjs`（全部HTTP拦截，输出runtime/daily-follow-up-ui）；真实模型合成验证需显式 `TODO_VERIFY_REAL_MODEL=1` 执行 `uv run --locked python ../scripts/verify_follow_up_model.py`。旧verify-daily-review.cjs仅适用于归档的旧标记交互，现行前端以verify-daily-follow-up.cjs为准；原有API兼容测试保留。

以下0016记录是历史交付，不能当作0018已部署的证据；本轮部署及当前验证结论见TEST-020。

REQ-F-015 / PRO-015 / TECH-021 / TEST-018。行动分类行右侧提供未梳理/已梳理图标，事件行可手动标记，已梳理仅显示时间，不提供撤销入口。独立保存记录，不改变任务状态或本周评估。按北京时间换日；页面回到前台或跨日会重新核对。保存结果未知时使用页面核对入口，不自动重发。

迁移0016新增action_reviews与action_review_operations，普通启动不迁移。本机业务库已停写备份升级，既有23表234行摘要一致并重启至PID37500，证据见TEST-018。其他环境须先停写备份；可复用 `uv run --locked python ../scripts/deploy_matter_planning.py --apply --revision 0016 --output <新的备份目录>`（code/backend目录；仅允许已配置todo PostgreSQL，从0015升级）。

统一检查包含tests/test_daily_review.py与daily-review.js语法。隔离Chrome检查：`node code/scripts/verify-daily-review.cjs`（项目根目录，需已有Playwright+Chrome，可配置NODE_PATH），所有HTTP拦截，输出runtime/daily-review-ui，不写真实业务记录。

## 事情智能拆解与类型提示词

REQ-F-014 / PRO-014 / TECH-020 / TEST-017。事情事件清单的“智能拆解”自动分类并选用对应提示词；类型可手动修改，候选只在用户确认后创建顶层事件。全局“设置”内维护类型、提示词及启停，原聊天来源由“设置→数据渠道→飞书聊天”进入。未知保存结果先核对回执，不静默重试。

迁移0015新增账号类型配置与生成依据表。普通启动不自动迁移；本次业务库已经停写备份升级并读回核对，详见TEST-017。后续环境需先备份再显式升级。后端默认测试离线；浏览器检查 `node code/scripts/verify-matter-decomposition.cjs` 完全拦截HTTP，不写真实业务库。前端语法包含 matter-decomposition.js。真实模型仅通过显式 `TODO_VERIFY_REAL_MODEL=1` 运行 `uv run --locked python ../scripts/verify_matter_model.py`，工作目录 code/backend，使用纯合成资料和临时数据库。

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

## 事件识别
REQ-O-005 / TECH-018：页面右侧边缘「事件识别」提示框显示待确认数量，点击后右侧滑出结果列表，包含待确认聊天建议及已关联进展；全部目标范围，不受目标筛选影响。核对关闭或保存后返回列表，定位收起抽屉。无需重启后端或迁移，刷新前端即可加载。浏览器回归：node code/scripts/verify-chat-results.cjs（在项目根目录执行，需现有 Playwright + Chrome，可配置 NODE_PATH），所有请求均被拦截，模拟保存不访问业务服务。截图和报告在 runtime/chat-results-ui。

事件识别入口现位于顶栏铃铛；未找到建议页签可查看当前聊天页中没有匹配历史依据的消息，并显式单条重识别。后端增加 /api/sources/unmatched 与 /api/sources/retry-message，需重启服务，无迁移。来源必须启用并有AI授权，原消息已处理；版本检查拒绝重复请求，不删除消息回执。只生成候选，正式事件仍需人工确认。历史依据匹配不保证精确，当前页以外暂不列入。

SRC-CHAT-RESULTS-004：未找到建议页签与其他页签样式一致。每条支持废弃，确认后删除本地原文并通过最小忽略回执排除以后采集和识别。废弃接口 /api/sources/discard-message，无迁移，更新后需重启。真实飞书消息不删除，历史备份不自动清理。

SRC-CHAT-RESULTS-007：手动整理（铅笔图标）允许来源暂停或AI未授权时创建待确认草稿，不调用模型、不恢复来源；确认归属后才创建正式事件。新增 /api/sources/manual-message，稳定草稿ID保证重复提交不重复生成，沿用现有保存事务。无迁移，需重启后端。长原文超过2000字时提示通过手动新建处理。

## 模块记忆首片（SRC-MEMORY-002）

REQ-F-013 / PRO-013 / TECH-019 / TEST-016。模块编辑→模块记忆：确认职责与简称、停用、显式生成向量索引；事件默认不向量化。迁移0012要求管理员预先在 public 安装 vector 扩展，功能关闭也不绕过迁移检查。升级前停写备份并完成隔离 PostgreSQL 回归；当前本地 PostgreSQL 初始化崩溃，原生向量查询尚未实测，不直接部署到真实库。

配置示例 config/memory.env.example，兼容已有 EMBEDDING_BASE_URL/MODEL/API_KEY；功能、索引提交、来源查询提交分别默认关闭。qwen3-vl-embedding 使用同主机 DashScope 原生端点。模型 profile 变化后须重新生成索引。普通启动不执行迁移、不批量索引历史事件。

统一检查覆盖 tests/test_memory.py；前端语法包含 memory.js；`node code/scripts/verify-memory.cjs` 在项目根执行，需已有 Playwright + Chrome，所有请求拦截，报告 runtime/memory-ui/report.json。默认测试不调用真实模型。真实服务仅用合成文本验证过2560维响应，模块语义召回质量与真实 PostgreSQL 链路仍待验收。

### 当前工作摘要（SRC-MEMORY-003）

迁移0013新增单表派生缓存，无历史回填；开启 TODO_MEMORY_ENABLED 后，事情编辑→当前工作摘要可查看和刷新，来源识别也按需整理至多5件当前事情。每账号1000份、每份4000字符，重复快照不追加，结束后在下次刷新时清除缓存，重开可重建；达到上限返回实时结果并标注未缓存。仅正式业务字段，不复制可能含来源原文的说明，不调用额外模型、不向量化事件。阶段经验/晋升仍未实现。

识别共享30000字符输入上限，业务目录/当前摘要/模块记忆分别有界，部分结果显式提示；原始工作仍完整保留。新增 tests/test_working_memory.py、working-memory.js、`node code/scripts/verify-working-memory.cjs`（全部HTTP拦截，四宽度证据 runtime/working-memory-ui）。代码审阅重点 modules/memory/working.py 与 context.py。

本轮隔离 PostgreSQL16.2 + pgvector0.6.0 全量104项通过（含原生过滤/检索），替代上文原生链路尚未验证的历史结论；不等于目标18.6环境已验证。复测通过显式 TODO_TEST_DATABASE_URL 指向授权测试库 todo，pytest只创建随机 schema；默认仍102项离线通过、2项原生用例跳过。目标库须由管理员安装适配版本扩展，并在备份/停写后验证0012/0013；本轮未升级真实库或重启8000。

### 业务库已部署（2026-11-16）
SRC-MEMORY-004：现有todo库已安装pgvector0.8.7并升级至0013，本机8000已重启。部署前备份和13表160行逐表摘要核对通过；同版本PostgreSQL18.6+pgvector0.8.7全量104项通过。记忆功能已开启，模块索引需明确点击；来源查询向量提交仍关闭。恢复材料与可重建扩展镜像保存在服务器/opt/todo-memory-deploy/20261116。此处替代上文未部署和目标环境未验证的历史状态，详见TEST-016。

### 自动记忆候选（SRC-MEMORY-005，2026-11-16）
REQ-F-013 / PRO-013 / TECH-019 §14 / TEST-016。0014新增memory_candidates、memory_card_origins、memory_suggestion_refs；业务库已备份升级并重启。顶栏“记忆候选”核对职责/简称，确认后才更新模块卡片；候选不向量化、不参与识别，复用下一次已授权来源识别产生，不重扫已处理历史。来源缺少授权、被暂停/换绑或消息废弃时相关记忆不可用，恢复授权不直接恢复旧来源版本；来源原文不在当前页的未确认候选需重新核对。

候选容量500/账号（含拒绝最小回执），引用容量10000/账号，单次5候选、每卡20个依赖。达到上限停止新增或明确丢弃引用记录，保留行动建议；当前未实现周期归档清理。事件建议核对新增“记忆引用”，只显示模型明确报告且实际进入提示词的有效版本，不能当作内部推理的完整记录。保存结果未知先查模块操作回执，拒绝按候选ID幂等。

代码审阅：modules/memory/candidates.py、provenance.py、basis.py及modules/sources/recognition.py；tests/test_memory_candidates.py。浏览器脚本code/scripts/verify-memory-candidates.cjs全HTTP拦截，四宽度/冲突/未知结果刷新恢复/引用失效验证，报告runtime/memory-candidates-ui。完整实现与验证边界见TEST-016末尾，阶段经验与晋升仍未实现。

SRC-MEMORY-006：来源采集与已观察到的证据变更失效在同一事务提交，防止消息编辑后翻页使旧记忆复活；只清除依赖该候选的向量/索引任务。正常翻页保留已确认事实，旧读取结果不能覆盖新快照，关闭记忆生成也继续维护既有依赖。停用或范围失效的简称不再用于新候选归属。审阅 modules/memory/invalidation.py 与 modules/sources/worker.py；同一候选测试文件包含编辑/翻页/恢复、隔离、回滚与迟到结果回归。无需新迁移；本轮修正在本地，未重启8000服务。


## 行动清单分页（SRC-WORKBENCH-004）
REQ-O-007 / PRO-008 / TECH-012 / TEST-009。行动每页10条，底部显示总数、范围及页码，筛选/目标切换归第一页，刷新保页并自动回退有效页；关注与评估仍每页20条。刷新前端即可生效。隔离浏览器回归：`node code/scripts/verify-action-pagination.cjs`（项目根目录，需Playwright + Chrome，可配置NODE_PATH）；全部HTTP拦截，报告与截图位于runtime/action-pagination-ui，不写业务库。


## 行动清单直接编辑（SRC-WORKBENCH-005）
REQ-O-008 / PRO-008 / TECH-012 / TEST-009。首页行动名称直接打开已有编辑事件表单，取消保留目标、筛选与有效页码，保存沿用既有流程并刷新快照；定位仍打开工作页。刷新前端生效，无迁移/后端重启。浏览器验证复用`node code/scripts/verify-action-pagination.cjs`，全部HTTP拦截，包含模拟保存，不写真实业务库。

## 抽屉外侧关闭（2026-11-16）
REQ-O-003 / SRC-UI-012，沿用PRO-009 / TECH-014 / TEST-011。前端新增dialog-dismiss.js统一处理静态及动态右侧抽屉；刷新页面加载，无需后端重启或迁移。居中删除确认不变。隔离浏览器回归：`node code/scripts/verify-drawer-dismiss.cjs`（项目根目录，需既有Playwright + Chrome，可配置NODE_PATH）；全部网络拦截，报告在runtime/drawer-dismiss-ui。统一语法检查须包含该前端脚本。

## 催办负责人姓名选择（2026-11-17）
REQ-O-010 / TECH-008 / TEST-005。自动催办输入姓名或企业邮箱后点击查询，从姓名、部门、企业邮箱候选中选择并核实，再显式开启。已有规则按原身份回显姓名，查询失败仍可暂停。不自动发送，不批量同步通讯录；需重启后端加载查询接口，无数据库迁移。
隔离浏览器检查：node code/scripts/verify-follow-people.cjs（需既有Playwright + Chrome，可配置 NODE_PATH），全部HTTP拦截，报告 runtime/follow-people-ui。统一检查覆盖 tests/test_follow_people.py 及全部前端JS语法。

自动催办现支持打开时按事件负责人自动查询，完整唯一精确匹配才预选，仍需身份核实。新正文结合事情背景、祖先事件、当前工作与截止日期整理；已有批准正文保留，可点击“按当前上下文重新整理”。仅前端更新，刷新页面生效。验证：node code/scripts/verify-follow-people.cjs（仓库根目录；需已有 Playwright/Chrome 工具环境），所有 HTTP 拦截，无真实发送。

2026-11-18 SRC-FOLLOW-CONTEXT-002：催办取消身份核实勾选和单独开启确认，点击“保存催办配置”即可启用；收件人、日期和状态仍校验。后端需重启，无数据库迁移。


## 工作台目标卡片筛选（2026-11-18）
REQ-O-011 / PRO-008 / TECH-012 / TEST-009。点击概览卡片筛选下方行动、关注和评估，所有目标保持可见，已选高亮，再点已选卡片恢复全部；下拉同步，分页归零。行动行移除定位，名称直接编辑与每日梳理保留。仅前端刷新生效，无需后端重启或迁移。


2026-11-18 当日跟进已更新本机8000，0018停写备份并核对原27表312行摘要一致。刷新可加载小窗口；172项测试通过、2项既有pgvector测试跳过，PostgreSQL隔离与真实模型合成用例通过，详见TEST-020；2026-11-19用户验收通过（SRC-ACCEPT-DAILY-FOLLOW-001）。


## 事件图片与存储配置
REQ-F-018 / PRO-018 / TECH-024 / TEST-021。设置→图片存储，默认ap-shanghai / cc-1300161961，填写SecretId/SecretKey后点右上角保存图标；已有密钥留空保留，私有访问无展示标签和开关。连接图标只检查存储桶访问，不证明上传下载权限。事件行图片图标打开选择/明确上传/预览/移除及未知结果核对。单张10MiB、每事件20张（含占位），只支持静态JPEG/PNG/WebP，不把图片提交模型。

迁移0019追加四表，启动不迁移。部署先停止本项目8000服务并验证端口释放，再运行uv run --locked python ../scripts/deploy_matter_planning.py --apply --revision 0019 --output <新的备份目录>（code/backend目录），备份和既有行摘要核对后重启。TODO_STORAGE_ENCRYPTION_KEY为稳定服务端Fernet主密钥，放code/.env，不可提交或打印；新环境先安全生成一次，恢复时必须保留原密钥，否则不能解密已保存配置。真实密钥不放config示例或浏览器存储。

隔离浏览器：node code/scripts/verify-event-images.cjs（项目根目录，既有Playwright+Chrome，可配置NODE_PATH），全部HTTP拦截，无真实云或业务写入，报告runtime/event-images-ui。移除只解除关联，COS原文件暂保留；签名访问链接最长5分钟，删除关联不保证即时撤销已发出的链接。

## 剪贴板图片与下一步事件

REQ-F-019 / PRO-019 / TECH-025 / TEST-022。当前事情、事件详情与事件行图片按钮可粘贴或选文件。当日跟进和新建表单的附图入口分别在正文与说明后。保存新对象后关联草稿图片。已有图片可选中分析，确认所选候选后生成顶层事件或子事件，并保留图片来源。

设置 → 大模型，填写 UAIAPI 账户可用且支持图片输入和 JSON 输出的模型 ID。API Key 可选，已有独立密钥时留空保留，首次留空沿用服务端密钥。保存后即时生效。服务端默认值见 `config/image-vision.env.example`。右上角检查图标只读取 UAIAPI 模型目录。分析显式提交选中的图片与当前工作上下文，最多4张且合计不超过12MiB。

迁移0020在0019之上增加分析批次及来源表。验证使用 `node code/scripts/verify-image-actions.cjs`，对所有 HTTP 请求进行拦截。图片清单和模型能力的业务验收分别记录在TEST-022。

模型设置随迁移0022增加两张表。备份升级脚本的 `--revision 0022` 支持从0021升级，也可从0020顺序应用前置迁移0021。设置页回归使用 `node code/scripts/verify-matter-decomposition.cjs`。

## 多模型与场景分配

REQ-F-021 / PRO-021 / TECH-027 / TEST-024。设置 → 大模型维护显示名称、OpenAI 兼容 URL、模型 ID、可选 API Key 和图片能力，再分配到各场景。未分配的场景沿用上一段配置。应用不复用其他提供方的密钥，场景变更在下一次调用生效。备份升级脚本支持 `--revision 0023`，从0022追加目录与回执表。
