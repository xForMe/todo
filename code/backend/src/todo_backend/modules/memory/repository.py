"""Relational memory cards, bounded receipts and native vector storage."""

from sqlalchemy import BigInteger, Boolean, Column, Integer, String, Table, Text, text
from sqlalchemy.engine import Connection

from todo_backend.modules.work.repository import metadata

cards = Table(
    "memory_cards",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("module_id", String(36), primary_key=True),
    Column("version", Integer, nullable=False),
    Column("scope_version", String(64), nullable=False),
    Column("description", Text, nullable=False),
    Column("aliases", Text, nullable=False),
    Column("enabled", Boolean, nullable=False),
)
receipts = Table(
    "memory_operations",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("id", String(36), primary_key=True),
    Column("fingerprint", String(64), nullable=False),
    Column("result", Text, nullable=False),
)
jobs = Table(
    "memory_index_jobs",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("id", String(36), primary_key=True),
    Column("module_id", String(36), nullable=False),
    Column("revision", Integer, nullable=False),
    Column("profile", String(64), nullable=False),
    Column("state", String(16), nullable=False),
    Column("started", BigInteger, nullable=False),
)

working_summaries = Table(
    "memory_working_summaries",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("thing_id", String(36), primary_key=True),
    Column("fingerprint", String(64), nullable=False),
    Column("policy", String(32), nullable=False),
    Column("body", Text, nullable=False),
    Column("generated_at", BigInteger, nullable=False),
)

candidates = Table(
    "memory_candidates",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("id", String(36), primary_key=True),
    Column("module_id", String(36), nullable=False),
    Column("fact_hash", String(64), nullable=False),
    Column("source_id", String(36), nullable=False),
    Column("source_version", Integer, nullable=False),
    Column("source_scope", String(64), nullable=False),
    Column("message_id", String(200), nullable=False),
    Column("content_hash", String(64), nullable=False),
    Column("body", Text, nullable=False),
    Column("state", String(16), nullable=False),
)
origins = Table(
    "memory_card_origins",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("module_id", String(36), primary_key=True),
    Column("candidate_id", String(36), primary_key=True),
)
suggestion_refs = Table(
    "memory_suggestion_refs",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("suggestion_id", String(36), primary_key=True),
    Column("module_id", String(36), primary_key=True),
    Column("revision", Integer, nullable=False),
)


def create_vector_table(conn: Connection) -> None:
    """Create native pgvector storage; SQLite is an offline test substitute only."""
    if conn.dialect.name == "postgresql":
        schema = conn.execute(
            text(
                "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n "
                "ON n.oid=e.extnamespace WHERE e.extname='vector'"
            )
        ).scalar()
        if schema != "public":
            raise RuntimeError("请先由数据库管理员将 pgvector 安装至 public；迁移不会自动安装扩展")
        vector_type = "public.vector"
    else:
        vector_type = "TEXT"
    conn.exec_driver_sql(
        "CREATE TABLE memory_vectors (account VARCHAR(120) NOT NULL, "
        "module_id VARCHAR(36) NOT NULL, revision INTEGER NOT NULL, "
        "profile VARCHAR(64) NOT NULL, embedding " + vector_type + " NOT NULL, "
        "PRIMARY KEY (account, module_id))"
    )
