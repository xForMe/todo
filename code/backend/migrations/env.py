"""Execute explicit schema migrations."""

from alembic import context

from todo_backend.database import build_engine, database_url
from todo_backend.modules.work.repository import metadata

engine = build_engine(database_url())
with engine.connect() as connection:
    context.configure(connection=connection, target_metadata=metadata)
    with context.begin_transaction():
        context.run_migrations()
engine.dispose()
