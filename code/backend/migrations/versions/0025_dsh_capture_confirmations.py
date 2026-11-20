"""Record explicit Web approvals and their committed event receipts."""

import sqlalchemy as sa
from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add one receipt per draft and reserve each confirmation UUID globally."""
    op.create_table(
        "dsh_capture_confirmations",
        sa.Column("operation_id", sa.String(36), primary_key=True),
        sa.Column("account", sa.String(120), nullable=False),
        sa.Column("capture_id", sa.String(36), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("event_id", sa.String(36), sa.ForeignKey("work_items.id"), nullable=False),
        sa.Column("result", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(
            ("account", "capture_id"),
            ("dsh_capture_drafts.account", "dsh_capture_drafts.operation_id"),
        ),
        sa.UniqueConstraint("account", "capture_id", name="uq_dsh_capture_confirmation"),
    )


def downgrade() -> None:
    """Avoid removing receipts that guard already accepted formal work."""
    raise RuntimeError("请从备份恢复，不能丢弃 DSH 录入确认回执")
