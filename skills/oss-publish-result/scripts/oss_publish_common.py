#!/usr/bin/env python3
"""Shared helpers for publishing workspace files to Aliyun OSS."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlparse

REQUIRED_ENV_VARS = (
    "OSS_ENDPOINT",
    "OSS_REGION",
    "OSS_BUCKET",
    "OSS_ACCESS_KEY_ID",
    "OSS_ACCESS_KEY_SECRET",
)
DEFAULT_PREFIX = "arkclaw-1-intelligence-center/texts/"
BLOCKED_DIR_NAMES = {".git", "node_modules"}
SESSION_HINT_ENV_VARS = (
    "OPENCLAW_REQUEST_ID",
    "OPENCLAW_SESSION_KEY",
    "OPENCLAW_SESSION_ID",
)


@dataclass(frozen=True)
class UploadConfig:
    endpoint: str
    region: str
    bucket: str
    access_key_id: str
    access_key_secret: str
    prefix: str


def emit(payload: dict[str, object], exit_code: int) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n")
    raise SystemExit(exit_code)


def sanitize_segment(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())
    cleaned = normalized.strip(".-_")
    return cleaned[:120] or "unknown"


def detect_workspace_root(script_path: Path) -> Path:
    env_root = os.environ.get("OPENCLAW_WORKSPACE_DIR", "").strip()
    if env_root:
        return Path(env_root).expanduser().resolve()
    try:
        return script_path.resolve().parents[3]
    except IndexError:
        return Path.home().joinpath(".openclaw", "workspace").resolve()


def resolve_target_path(raw_arg: str, workspace_root: Path) -> Path:
    candidate = Path(raw_arg).expanduser()
    if candidate.is_absolute():
        return candidate.resolve()
    return (workspace_root / candidate).resolve()


def require_path_in_workspace(target_path: Path, workspace_root: Path) -> Path:
    try:
        return target_path.relative_to(workspace_root)
    except ValueError as error:
        raise ValueError(f"file is outside workspace: {target_path}") from error


def assert_uploadable_file(target_path: Path, workspace_root: Path) -> Path:
    if not target_path.exists():
        raise ValueError(f"file does not exist: {target_path}")
    if not target_path.is_file():
        raise ValueError(f"path is not a regular file: {target_path}")
    relative_path = require_path_in_workspace(target_path, workspace_root)
    for part in relative_path.parts[:-1]:
        if part in BLOCKED_DIR_NAMES:
            raise ValueError(f"files under {part}/ are not uploadable: {target_path}")
    return relative_path


def load_config() -> UploadConfig:
    missing = [name for name in REQUIRED_ENV_VARS if not os.environ.get(name, "").strip()]
    if missing:
        raise ValueError(f"missing required env vars: {', '.join(missing)}")
    prefix = os.environ.get("OSS_PREFIX", "").strip() or DEFAULT_PREFIX
    prefix = prefix.lstrip("/")
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    return UploadConfig(
        endpoint=os.environ["OSS_ENDPOINT"].strip(),
        region=os.environ["OSS_REGION"].strip(),
        bucket=os.environ["OSS_BUCKET"].strip(),
        access_key_id=os.environ["OSS_ACCESS_KEY_ID"].strip(),
        access_key_secret=os.environ["OSS_ACCESS_KEY_SECRET"].strip(),
        prefix=prefix,
    )


def choose_session_segment() -> str:
    for env_name in SESSION_HINT_ENV_VARS:
        raw = os.environ.get(env_name, "").strip()
        if raw:
            return sanitize_segment(raw)
    return f"manual-{datetime.now().strftime('%Y%m%dT%H%M%S')}"


def sanitize_relative_path(relative_path: Path) -> str:
    segments = [sanitize_segment(part) for part in relative_path.parts]
    return "/".join(segments)


def build_object_key(
    config: UploadConfig,
    relative_path: Path,
    *,
    session_segment: str,
) -> str:
    date_part = datetime.now().strftime("%Y-%m-%d")
    relative_key = sanitize_relative_path(relative_path)
    return f"{config.prefix}{date_part}/{session_segment}/{relative_key}"


def compute_sha256(target_path: Path) -> str:
    digest = hashlib.sha256()
    with target_path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_public_url(config: UploadConfig, object_key: str) -> str:
    parsed = urlparse(config.endpoint)
    scheme = parsed.scheme or "https"
    netloc = parsed.netloc or parsed.path
    if not netloc:
        raise ValueError(f"invalid OSS endpoint: {config.endpoint}")
    return f"{scheme}://{config.bucket}.{netloc}/{quote(object_key, safe='/')}"


def upload_file(config: UploadConfig, target_path: Path, object_key: str) -> None:
    destination = f"oss://{config.bucket}/{object_key}"
    command = [
        "ossutil",
        "cp",
        str(target_path),
        destination,
        "--force",
        "--no-progress",
        "--endpoint",
        config.endpoint,
        "--region",
        config.region,
        "--access-key-id",
        config.access_key_id,
        "--access-key-secret",
        config.access_key_secret,
    ]
    content_type, _ = mimetypes.guess_type(target_path.name)
    if content_type:
        command.extend(["--content-type", content_type])
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        details = completed.stderr.strip() or completed.stdout.strip() or "ossutil cp failed"
        raise RuntimeError(details)


def build_upload_result(
    config: UploadConfig,
    workspace_root: Path,
    target_path: Path,
    *,
    session_segment: str,
) -> dict[str, object]:
    relative_path = assert_uploadable_file(target_path, workspace_root)
    object_key = build_object_key(config, relative_path, session_segment=session_segment)
    upload_file(config, target_path, object_key)
    return {
        "filename": target_path.name,
        "path": str(target_path),
        "relative_path": str(relative_path).replace("\\", "/"),
        "url": build_public_url(config, object_key),
        "bucket": config.bucket,
        "key": object_key,
        "size_bytes": target_path.stat().st_size,
        "sha256": compute_sha256(target_path),
    }


def iter_directory_files(target_dir: Path, workspace_root: Path) -> list[Path]:
    require_path_in_workspace(target_dir, workspace_root)
    if not target_dir.is_dir():
        raise ValueError(f"path is not a directory: {target_dir}")

    files: list[Path] = []
    for current_root, dir_names, file_names in os.walk(target_dir):
        dir_names[:] = sorted(
            name for name in dir_names if name not in BLOCKED_DIR_NAMES
        )
        for file_name in sorted(file_names):
            candidate = Path(current_root, file_name).resolve()
            assert_uploadable_file(candidate, workspace_root)
            files.append(candidate)
    return files


def collect_upload_targets(raw_args: list[str], workspace_root: Path) -> list[Path]:
    if not raw_args:
        raise ValueError("at least one file or directory path is required")

    unique: dict[str, Path] = {}
    for raw_arg in raw_args:
        target_path = resolve_target_path(raw_arg, workspace_root)
        if not target_path.exists():
            raise ValueError(f"path does not exist: {target_path}")
        if target_path.is_dir():
            discovered = iter_directory_files(target_path, workspace_root)
            if not discovered:
                raise ValueError(f"directory has no uploadable files: {target_path}")
            for candidate in discovered:
                unique[str(candidate)] = candidate
            continue
        assert_uploadable_file(target_path, workspace_root)
        unique[str(target_path)] = target_path
    return list(unique.values())
