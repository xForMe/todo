# TECH-013 PostgreSQL 切换

**类型**：技术方案
**状态**：implemented
**负责人**：待指定
**更新时间**：2026-11-14
**source_requirements**：REQ-O-002、REQ-F-006、REQ-F-007
**source_technical**：TECH-003、TECH-004、TECH-009、TECH-010

来源 SRC-DB-001。新建 todo 库，所有者 sub2api。环境文件读取 DB_PASSWORD（兼容 db_password）及独立 host/port/name/user 字段，连接 URL 由 SQLAlchemy 构造，密码不打印。继承 TODO_DATABASE_URL 优先；无 PostgreSQL 配置时仍使用 SQLite。

采用 psycopg[binary] 3，官方 https://www.psycopg.org/psycopg3/docs/basic/install.html 支持 Windows/Python 3.11；维护活跃，LGPL-3.0，bundled libpq 无需额外服务或云调用费用。需随安全更新维护，未执行完整供应链审计。现有 SQLAlchemy/Alembic 不变。

PostgreSQL SERIALIZABLE 隔离避免跨表状态检查的并发写偏差；冲突按现有安全错误返回，不自动重试。0011 为 PostgreSQL 补齐 0006/0007 的删除、有效引用和事件范围触发器，SQLite 空操作。PostgreSQL next_run/last_run/created 时间戳升级为 BIGINT，避免 32 位范围差异。删除/事件结构移除 SQLite 专属拒绝，SQLite 保持 BEGIN IMMEDIATE。

先建空库并在随机隔离 schema 验证迁移与业务回归，测试关闭外部读取。停旧服务后通过 SQLite backup API 创建一致备份，按表类型读取并按依赖顺序导入空 public schema；历史删除记录最后写入。全量摘要核对后才启用配置和重启。导入失败整事务回滚；已提交但结果不明先读回。旧 SQLite 不删除不覆盖。回退需先停服务并核对切换后新增数据，不能直接覆盖。

普通启动检查数据库可连接且版本=head，不自动迁移。远程迁移必须显式手工执行；一键 -Migrate 拒绝远程库。应用继续绑定 127.0.0.1，不代表完成生产身份、TLS 或公网部署。服务器当前未启用 SSL，连接采用 prefer，传输未加密；后续开启服务端 TLS 后应切 require/verify-full。
