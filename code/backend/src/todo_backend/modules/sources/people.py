"""Event-scoped, on-demand recipient identity reads."""

from sqlalchemy.engine import Engine

from todo_backend.integrations.feishu_cli.contacts import search_people
from todo_backend.integrations.feishu_cli.reader import ReadFailure
from todo_backend.modules.sources.follow import list_rules
from todo_backend.modules.work.repository import read_item
from todo_backend.modules.work.service import WorkError


def find_people(
    engine: Engine, account: str, event_id: str, query: str, saved: bool
) -> dict[str, object]:
    """Only resolve a saved recipient belonging to an accessible event."""
    with engine.connect() as conn:
        event = read_item(conn, account, event_id)
        if event is None or event.type != "event":
            raise WorkError(404, "事件不可访问")
    recipient = ""
    if saved:
        rule = next((r for r in list_rules(engine, account) if r["event_id"] == event_id), None)
        recipient = str(rule["recipient"]) if rule else ""
        if not recipient:
            return {"people": [], "has_more": False}
    elif not query.strip() or len(query.strip()) > 50:
        raise WorkError(422, "请输入1—50字的姓名或企业邮箱")
    try:
        return search_people(query.strip(), recipient)
    except ReadFailure as exc:
        raise WorkError(503, "人员查询失败，请核对飞书登录与通讯录权限后重新查询") from exc
