from contextlib import asynccontextmanager
import asyncio
from dataclasses import dataclass
from sqlalchemy import URL
from sqlalchemy.ext.asyncio import create_async_engine
from .config import settings

@dataclass
class Result:
    rows: list
    affected: int = 0
    inserted: int | None = None

class Database:
    """Driver SQL preserves existing indexes/transactions; no ORM model rewrite."""
    def __init__(self, engine=None, connection=None):
        self.engine = engine or (None if connection else create_async_engine(URL.create(
            'mysql+aiomysql', username=settings.db_user, password=settings.db_password,
            host=settings.db_host, port=settings.db_port, database=settings.db_name),
            pool_pre_ping=True, pool_size=10, max_overflow=0, hide_parameters=True, connect_args={'charset': 'utf8mb4'}))
        self.connection = connection
        self.lock = asyncio.Lock()
        self.transaction_owner = None

    async def execute(self, sql, args=()):
        async def run(connection):
            result = await connection.exec_driver_sql(sql.replace('?', '%s'), tuple(args))
            return Result([dict(r) for r in result.mappings().all()] if result.returns_rows else [],
                          result.rowcount, getattr(result, 'lastrowid', None))
        if self.connection is not None:
            if self.transaction_owner is asyncio.current_task(): return await run(self.connection)
            async with self.lock:return await run(self.connection)
        async with self.engine.begin() as connection:
            return await run(connection)

    @asynccontextmanager
    async def transaction(self):
        if self.connection is not None:
            if self.transaction_owner is asyncio.current_task():yield self
            else:
                async with self.lock:
                    self.transaction_owner=asyncio.current_task()
                    try:yield self
                    finally:self.transaction_owner=None
        else:
            async with self.engine.begin() as connection:
                yield Database(connection=connection)

    async def close(self):
        if self.engine:
            await self.engine.dispose()
