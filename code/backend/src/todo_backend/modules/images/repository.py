"""Durable settings, immutable storage locations and upload reservations."""

from sqlalchemy import Column, ForeignKey, Integer, String, Table, Text

from todo_backend.modules.work.repository import metadata

profiles = Table(
    "image_storage_profiles",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("account", String(120), nullable=False),
    Column("region", String(50), nullable=False),
    Column("bucket", String(100), nullable=False),
    Column("credentials", Text, nullable=False),
)
settings = Table(
    "image_storage_settings",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("profile_id", String(36), ForeignKey(profiles.c.id), nullable=False),
    Column("revision", Integer, nullable=False),
)
receipts = Table(
    "image_operations",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("id", String(36), primary_key=True),
    Column("fingerprint", String(64), nullable=False),
    Column("result", Text, nullable=False),
)
images = Table(
    "event_images",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("account", String(120), nullable=False),
    Column("event_id", String(36), ForeignKey("work_items.id"), nullable=False),
    Column("profile_id", String(36), ForeignKey(profiles.c.id), nullable=False),
    Column("event_version", Integer, nullable=False),
    Column("fingerprint", String(64), nullable=False),
    Column("object_key", String(300), nullable=False),
    Column("name", String(255), nullable=False),
    Column("mime", String(30), nullable=False),
    Column("size", Integer, nullable=False),
    Column("sha256", String(64), nullable=False),
    Column("state", String(20), nullable=False),
    Column("created_at", String(40), nullable=False),
    Column("revision", Integer, nullable=False),
)

action_runs = Table(
    "image_action_runs",
    metadata,
    Column("id", String(36), primary_key=True),
    Column("account", String(120), nullable=False),
    Column("item_id", String(36), ForeignKey("work_items.id"), nullable=False),
    Column("snapshot", String(64), nullable=False),
    Column("model", String(200), nullable=False),
    Column("proposal", Text, nullable=False),
    Column("confirmation", Text),
    Column("result", Text),
)

action_sources = Table(
    "image_action_sources",
    metadata,
    Column("event_id", String(36), ForeignKey("work_items.id"), primary_key=True),
    Column("run_id", String(36), ForeignKey(action_runs.c.id), nullable=False),
    Column("image_id", String(36), ForeignKey(images.c.id), nullable=False),
    Column("evidence", Text, nullable=False),
)

vision_settings = Table(
    "vision_settings",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("model", String(200), nullable=False),
    Column("encrypted_key", Text, nullable=False),
    Column("revision", Integer, nullable=False),
)

vision_receipts = Table(
    "vision_settings_operations",
    metadata,
    Column("account", String(120), primary_key=True),
    Column("id", String(36), primary_key=True),
    Column("fingerprint", String(64), nullable=False),
    Column("result", Text, nullable=False),
)
