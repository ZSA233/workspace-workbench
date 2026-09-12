from __future__ import annotations


class WorkbenchError(RuntimeError):
    """A structured error safe to return over the observer protocol."""

    def __init__(self, message: str, *, code: str = "observer_error", details: object = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details

    def as_dict(self) -> dict[str, object]:
        result: dict[str, object] = {"code": self.code, "message": str(self)}
        if self.details is not None:
            result["details"] = self.details
        return result


class GitCommandError(WorkbenchError):
    """A bounded Git command failed or timed out."""
