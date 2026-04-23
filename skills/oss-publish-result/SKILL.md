---
name: oss-publish-result
description: For any file created or updated for the current session, upload it from the workspace to Aliyun OSS and return the OSS URLs in the final reply. Do not stop at a local path.
metadata:
  {
    "openclaw":
      {
        "emoji": "☁️",
        "skillKey": "oss-publish-result",
        "requires":
          {
            "bins": ["python3", "ossutil"],
            "env":
              [
                "OSS_ENDPOINT",
                "OSS_REGION",
                "OSS_BUCKET",
                "OSS_ACCESS_KEY_ID",
                "OSS_ACCESS_KEY_SECRET",
              ],
          },
      },
  }
---

# OSS Publish Result

Use this skill whenever the current session creates or updates one or more files in the OpenClaw workspace and the user may need those files.

Local files alone are not enough. If this session produced a file for the user, you must upload it and return the OSS URL.

## What this skill does

- Uploads session-related workspace files to Aliyun OSS with bundled scripts.
- Keeps upload behavior deterministic so you do not hand-write `ossutil` commands.
- Returns one OSS URL per uploaded file.
- Supports batching multiple files or whole output directories in one command.

## When to upload

Upload every file that belongs to the current session's final output.

That includes:

- A single test file created because the user asked you to create a file
- Reports such as `report.json`, `report.md`, `summary.txt`
- Exported data such as `.json`, `.csv`, `.xlsx`
- Finished packages such as `.zip`, `.tar.gz`
- Final images, videos, or audio files the user asked for
- Files inside an output directory created for this session

Treat these as session-related files:

- Files you created in this request
- Files you modified in this request and intend to hand back to the user
- Files you explicitly mention as task output

Do not upload:

- Files outside the workspace
- `.git/` contents
- `node_modules/`
- Large piles of intermediate junk the user would not want
- Fake, empty, or placeholder files created only to satisfy the skill
- Unrelated old files from earlier sessions

## Required command

Default to the batch uploader, even for a single file:

```bash
{baseDir}/scripts/publish-session-files.sh /absolute/or/workspace-relative/file-or-dir [more-paths...]
```

This command accepts:

- A single file
- Multiple files
- A directory, which uploads all regular files under that directory recursively

Fallback for one file only:

```bash
{baseDir}/scripts/upload-to-oss.sh /absolute/or/workspace-relative/file
```

Do not write raw `ossutil cp ...` yourself unless the bundled scripts are broken and you explain that clearly.

## Upload workflow

1. Finish the task and make sure the output files actually exist.
2. Collect every file or output directory produced for this session.
3. Run the batch upload script before sending the final reply.
4. Read the returned JSON.
5. If `ok` is `true`, record every uploaded `filename` and `url`.
6. If `ok` is `false`, say clearly which files succeeded and which failed.

## Response rules

- If no file was created or updated for the session, do not mention OSS.
- If the session created files, do not end with only a local path.
- If one or more uploads succeed, include the uploaded file list and each OSS URL in the final reply.
- If a file was created but upload failed, explicitly say the file exists locally and OSS upload failed.
- Never invent URLs.

Wrong:

```text
文件已经创建在本地：/root/.openclaw/workspace/test.txt
```

Right:

```text
文件已创建并上传。
test.txt
https://...
```

Recommended final reply shape:

```text
任务已完成。

已上传文件：
1. report.json
https://...

2. raw-data.csv
https://...
```

If upload partially fails:

```text
任务已完成，文件已生成。
上传成功：
1. report.json
https://...

上传失败：
1. chart.png
本地文件：tmp/chart.png
```

## Notes

- The batch script uploads a batch of files and returns one JSON result.
- The scripts validate that every target stays inside the workspace.
- Uploaded object keys keep the relative workspace path, so same-name files from different folders do not overwrite each other.
- `OSS_PREFIX` is optional. If it is unset, the script defaults to `arkclaw-1-intelligence-center/texts/`.
