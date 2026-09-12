from __future__ import annotations

import json
from typing import Any, Mapping

from .errors import WorkbenchError


PROTOCOL_VERSION = "workspace.workbench/v1"


def decode_request(line: str | bytes) -> tuple[Any, str, dict[str, Any]]:
    try:
        value = json.loads(line.decode("utf-8") if isinstance(line, bytes) else line)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WorkbenchError("request is not valid JSON", code="request_invalid") from exc
    if not isinstance(value, Mapping):
        raise WorkbenchError("request must be an object", code="request_invalid")
    params = value.get("params")
    if params is None:
        params = {}
    if not isinstance(params, Mapping):
        raise WorkbenchError("params must be an object", code="request_invalid")
    return value.get("id"), str(value.get("method") or ""), dict(params)


def encode_response(request_id: Any, *, result: Any = None, error: WorkbenchError | None = None) -> str:
    if error is not None:
        value = {"id": request_id, "ok": False, "error": error.as_dict()}
    else:
        value = {"id": request_id, "ok": True, "result": result}
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"
