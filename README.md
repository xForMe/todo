# Super-agent

Super-agent 是以工作对象和全生命周期为主线的任务管理系统。

先阅读：

1. [AGENTS.md](AGENTS.md)：项目级规则和边界。
2. [PROJECT.md](PROJECT.md)：项目目标、当前阶段和关键决策。
3. [需求说明](docs/requirements/PRD-001-mvp.md)：业务需求和验收标准。
4. [技术方案](docs/technical/README.md)：架构、数据库和实现边界。
5. [测试方案](docs/testing/README.md)：测试与验收证据。

所有代码、迁移、脚本和可执行测试统一位于 `code/`。

本地启动需要两个服务：

```powershell
# 终端 1：Python API
python code/scripts/run_mvp.py

# 终端 2：Vue 前端
cd code/frontend
npm install
npm run dev
```

访问 `http://127.0.0.1:5173/`；API 默认在 `http://127.0.0.1:18787/`。

