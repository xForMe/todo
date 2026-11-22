"""Add isolated, versioned and idempotent DSH capture drafts."""

import sqlalchemy as sa
from alembic import op

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add the capture table without touching existing data or objects."""
    op.create_table(
        "dsh_capture_drafts",
        sa.Column("account", sa.String(120), primary_key=True),
        sa.Column("operation_id", sa.String(36), primary_key=True),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("claim_token", sa.String(36)),
        sa.Column("claim_until", sa.BigInteger(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("candidate", sa.Text()),
        sa.Column("basis", sa.Text()),
    )


def downgrade() -> None:
    """Require backup-based rollback instead of silently deleting drafts."""
    raise RuntimeError("请从备份恢复，不能丢弃 DSH 录入草稿")
