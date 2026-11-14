# TECH-001 Python 工程基础

**类型**：技术方案
**状态**：draft
**负责人**：待指定
**更新时间**：2026-11-12
**source_requirements**：REQ-F-001（后续业务承载，不代表已实施）
**关联文档**：PROJECT.md、TECH-002、TEST-001

## 来源和范围

SRC-TECH-001：2026-11-12 用户明确选择 Python，要求生成脚手架、独立代码规范，并要求编码时必须参考规范；飞书主要考虑 CLI。
本次授权覆盖工程基础和本地检查，不代表 PRO-001 已获确认。仅生成应用工厂、存活探针、依赖锁及检查配置；不实现业务接口、数据库表、认证、前端或外部调用。

## 选型与结构

- Python >=3.11,<3.14；本机验证使用 3.11。其他解释器尚未验证。
- FastAPI 提供 HTTP 层，Uvicorn 为本地运行入口，Pydantic 定义接口结构。
- uv 管理独立虚拟环境与 uv.lock；Ruff、mypy、pytest、HTTPX 用于检查与进程内接口测试。
- 前端预留 code/frontend；框架待确认。后端使用 code/backend/src/todo_backend，按业务模块组织。
- PostgreSQL、SQLAlchemy、Alembic 仍是后续持久化候选，本次不引入未使用的依赖或虚构迁移。
- modules 按 goals、modules、matters、work_events 划分时，每个模块按需新增 router、schemas、service、models、repository，不批量生成空业务实现。
- integrations/feishu_cli 为未来 CLI 边界。本次没有可执行适配器；CLI 名称、版本、认证、JSON 输出和权限范围待验证。

## 接口与安全边界

GET /health/live 仅说明应用能处理请求，不说明数据库、飞书或模型可用。没有业务写接口。默认启动绑定 127.0.0.1，禁止把脚手架当成已具备生产认证的系统公开部署。
后续写入必须通过身份、范围、状态、幂等检查并读回。CLI 仍可能产生外部写操作，不能用“运行命令”绕过确认和权限。
真实凭据只能由受控环境提供，不放入代码、示例或日志。不得在导入模块时启动进程、读取外部账户或连接数据库。

## 依赖评估

2026-11-12 查阅上游 FastAPI 与 Ruff GitHub 仓库及文档，均有当前维护活动。FastAPI、Uvicorn、Pydantic、Ruff、mypy、pytest、HTTPX、Hatchling 使用 MIT/BSD 等宽松许可；交付锁定版本的包元数据用于复核。仅采用所需基础功能，不引入云服务费用；运行环境仍有计算与维护成本。
未完成全量供应链漏洞审计，不能宣称依赖无安全风险。升级须检查发行说明、许可证及安全公告，更新锁文件并运行检查。

## 参考

- https://github.com/fastapi/fastapi
- https://github.com/astral-sh/ruff
- https://github.com/encode/uvicorn
- https://github.com/pydantic/pydantic

验收与检查证据单独记录在 TEST-001，不将探针通过写成业务完成。

锁定包元数据复核：FastAPI 0.162.5 MIT；Uvicorn 0.54.0 BSD-3-Clause；Pydantic 2.14.3 MIT；Ruff 0.17.4 MIT；mypy 1.20.2 MIT；pytest 9.2.0 MIT；HTTPX 0.28.1 BSD-3-Clause。完整解析版本见 code/backend/uv.lock。构建工具 Hatchling 的许可证参考上游声明，未作为已安装运行依赖核验。
