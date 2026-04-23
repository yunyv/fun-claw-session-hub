#!/usr/bin/env python3
"""Upload one or more session-related workspace files to Aliyun OSS."""

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
    if len(argv) < 2:
        emit(
            {
                "ok": False,
                "error": "usage: publish-session-files.sh <file-or-dir> [more-files-or-dirs...]",
            },
            1,
        )

    script_path = Path(__file__)
    workspace_root = detect_workspace_root(script_path)

    try:
        config = load_config()
        targets = collect_upload_targets(argv[1:], workspace_root)
        session_segment = choose_session_segment()
        uploaded: list[dict[str, object]] = []
        failed: list[dict[str, object]] = []

        # Use one session segment per batch so the returned links stay grouped together.
        for target in targets:
            try:
                uploaded.append(
                    build_upload_result(
                        config,
                        workspace_root,
                        target,
                        session_segment=session_segment,
                    )
                )
            except Exception as error:  # noqa: BLE001
                failed.append(
                    {
                        "path": str(target),
                        "error": str(error),
                    }
                )

        payload = {
            "ok": len(failed) == 0,
            "session_segment": session_segment,
            "count": len(uploaded),
            "uploaded": uploaded,
            "failed": failed,
        }
        emit(payload, 0 if len(failed) == 0 else 1)
    except Exception as error:  # noqa: BLE001
        emit({"ok": False, "error": str(error)}, 1)


if __name__ == "__main__":
    main(sys.argv)
