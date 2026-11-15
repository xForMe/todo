# To Do

以目标组织工作，以事情承载持续推进，以事件承载具体行动的个人工作管理应用。支持手动管理工作、关联飞书资料、通过 AI 整理候选行动，并由用户确认后保存。

当前用于个人本机运行。`1.0.0` 是本仓库的版本标签，不代表已完成生产部署、多人账号体系或所有外部接入场景的验证。

## 功能

- **工作层级**：按「目标 → 模块 → 事情 → 事件」组织工作，维护状态、责任人和计划日期。
- **全局工作台**：查看目标概览、当前行动、后续跟进和持续关注，筛选并定位到具体工作。
- **事件管理**：拆分子事件、建立同一事情下的事件关联、创建后续跟进，以及迁移事件及其子树。
- **优先级与关注**：手动调整事情四象限、独立设置持续关注，进行每周评估。
- **删除与换绑**：确认影响范围后删除；存在下级内容时按规则转移或先处理，保留操作回执。
- **飞书与 AI**：配置指定聊天来源或关联云文档，授权后读取并识别进展与候选行动；通过顶栏通知查看、核对、舍弃或重新识别。
- **事件拆分建议**：打开拆分入口后结合当前事件及已有子事件生成 AI 建议，编辑并确认后创建。
- **私聊催办配置**：默认关闭，需确认接收人、内容和规则后启用；发送结果不明时暂停并核对。

各功能的开发、验收状态见 [PROJECT.md](PROJECT.md)。实现入口和配置说明见 [code/README.md](code/README.md)；其中较新的变更记录替代对应历史限制。

## 技术组成

| 部分 | 实现 |
| --- | --- |
| 前端 | 原生 HTML / CSS / JavaScript，由后端同源托管 |
| 后端 | Python、FastAPI、Pydantic、Uvicorn |
| 数据库 | SQLAlchemy、Alembic、psycopg；日常启动使用 PostgreSQL |
| 外部适配 | 飞书 CLI、服务端 AI 接口 |
| 开发检查 | uv、Ruff、mypy、pytest、Node.js 语法检查 |

底层与离线测试仍支持 SQLite；一键启动仅接受 PostgreSQL。前端无需 `npm install` 或单独启动开发服务。

## 本地启动（Windows / PowerShell）

准备 Git、uv、Python 3.11–3.13 和可访问的 PostgreSQL。执行前确保有目标数据库的使用权限；现有数据库升级前先停写并备份。

```powershell
git clone https://github.com/xForMe/todo.git
Set-Location todo
Copy-Item config/postgresql.env.example code/.env
```

编辑 `code/.env`，填写数据库连接信息：

```dotenv
TODO_DB_HOST=your-db-host
TODO_DB_PORT=5432
TODO_DB_NAME=todo
TODO_DB_USER=your-db-user
TODO_DB_SSLMODE=require
DB_PASSWORD=replace-locally
```

SSL 模式须与数据库配置一致。真实密码不得提交；继承的 `TODO_DATABASE_URL` 优先于上述分项配置，启动前注意核对目标库。

首次初始化空库，或明确升级已有数据库时，单独执行迁移：

```powershell
Set-Location code/backend
uv sync --locked
# 已确认目标库；已有数据须先停写并备份
uv run --locked alembic upgrade head
Set-Location ../..
```

双击 `code/start.cmd`，或在项目根目录执行：

```powershell
./code/scripts/start.ps1
```

打开 [本地应用](http://127.0.0.1:8000/)。页面自动建立本机会话，无需手动输入令牌；保持服务窗口打开，按 `Ctrl+C` 停止。

启动脚本会同步锁定依赖、检查 PostgreSQL 连接和迁移版本；普通启动不会迁移数据库。检查通过后，可替换同一工作副本的旧服务；端口被其他程序占用时停止并提示。

```powershell
# 仅检查启动环境和端口身份，不访问数据库或停止服务
./code/scripts/start.ps1 -CheckOnly
# 已有依赖时跳过同步，并指定端口
./code/scripts/start.ps1 -Port 8001 -SkipSync
```

存活探针为 `/health/live`，API 文档为 `/docs`。本机会话不构成生产账号系统，请保持监听 `127.0.0.1`。

## 飞书与 AI 配置

手动工作管理不需要飞书或模型凭据。启用相关能力前，需另行配置并核实飞书 CLI 登录及资源权限。在 `code/.env` 中按需补充 [AI 配置示例](config/ai.env.example) 中的字段：

```dotenv
TODO_AI_MODEL=deepseek-v4-flash-ga-260731
TODO_UAIAPI_KEY=
# 可选：可信原生 lark-cli 可执行文件的绝对路径
TODO_FEISHU_CLI_EXE=
```

聊天来源在系统设置中管理；云文档从事情或事件内关联。来源读取和 AI 提交需对应授权；聊天识别可在当前账号全部目标内判断归属，正式新建及字段变更需人工确认。明确匹配的进展可在来源授权范围内关联，歧义保留为建议。

当前聊天读取最多最新 20 条一页，完整分页尚未补齐。应用关闭后不会继续读取或催办；持续调度和真实责任人催办发送的完整链路尚未完成验证。模型调用可能产生供应商费用，识别结果仍需核对。

## 开发检查

在 `code/backend` 执行（需 Node.js 检查前端脚本）：

```powershell
uv sync --locked
uv run --locked python ../scripts/check.py
Get-ChildItem ../frontend -Filter '*.js' | ForEach-Object {
    node --check $_.FullName
    if ($LASTEXITCODE) { throw $_.Name }
}
```

统一 Python 检查包含 Ruff lint、格式检查、mypy strict 和 pytest。默认测试使用临时 SQLite，关闭后台来源读取，不调用真实模型或飞书。不要为普通检查设置 `TODO_TEST_DATABASE_URL`；该变量用于另行授权的真实 PostgreSQL 验证。

浏览器回归脚本位于 `code/scripts/verify-*.cjs`，需已有 Playwright 与 Chrome 环境，各脚本的隔离服务要求见代码说明。离线检查通过不代表真实数据库、外部服务或生产环境已验证。

## 仓库结构与贡献

```text
AGENTS.md          项目执行规则与安全边界
PROJECT.md         项目执行总领、决策与交付状态
code/
  frontend/        原生前端
  backend/         后端、迁移、锁定依赖与测试
  scripts/         启动、数据库检查和回归脚本
  start.cmd        Windows 一键启动
config/            无真实凭据的配置示例
```

本地工作区的 `docs/` 保存产品、需求、原型、技术和测试文档，`archive/` 保存历史材料，`runtime/` 保存临时状态。这些目录按现有 Git 规则不发布，GitHub 克隆不包含其中的本地文档和验收证据。

修改前阅读 [AGENTS.md](AGENTS.md) 和 [PROJECT.md](PROJECT.md)，并取得对应需求及技术依据。写操作须校验权限、范围、状态并读回核对；外部写入结果不明时不得静默重试。凭据、业务数据库、备份和运行日志不得提交。

