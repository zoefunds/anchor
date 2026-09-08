from typing import Any, Dict


class AnchorApiError(Exception):
    """Raised for any non-2xx response. Mirrors packages/anchor-sdk/types.ts's AnchorApiError."""

    def __init__(self, message: str, status: int, body: Dict[str, Any]):
        super().__init__(message)
        self.status = status
        self.body = body
