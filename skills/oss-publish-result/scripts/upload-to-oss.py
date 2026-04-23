#!/usr/bin/env python3
"""Upload one workspace file to Aliyun OSS and print a one-line JSON result."""

from __future__ import annotations

import sys
from pathlib import Path
from oss_publish_common import (
    build_upload_result,
    choose_session_segment,
    collect_upload_targets,
    detect_workspace_root,
    emit,
    load_config,
)


def main(argv: list[str]) -> None:
    if len(argv) != 2:
        emit(
            {
                "ok": False,
                "error": "usage: upload-to-oss.sh <absolute-or-workspace-relative-file-path>",
            },
            1,
        )

    script_path = Path(__file__)
    workspace_root = detect_workspace_root(script_path)

    try:
        config = load_config()
        targets = collect_upload_targets([argv[1]], workspace_root)
        if len(targets) != 1:
            raise ValueError("upload-to-oss.sh accepts exactly one file path")
        session_segment = choose_session_segment()
        payload = build_upload_result(
            config,
            workspace_root,
            targets[0],
            session_segment=session_segment,
        )
        emit({"ok": True, "session_segment": session_segment, **payload}, 0)
    except Exception as error:  # noqa: BLE001
        emit({"ok": False, "error": str(error)}, 1)


if __name__ == "__main__":
    main(sys.argv)
