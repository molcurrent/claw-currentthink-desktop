#!/usr/bin/env python3
import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="Offline speech transcription via mlx-whisper")
    parser.add_argument("--input", required=True, help="Path to audio file")
    parser.add_argument("--model", default="mlx-community/whisper-tiny", help="Local path or Hugging Face repo")
    parser.add_argument("--language", default="", help="Optional language code")
    args = parser.parse_args()

    try:
        import mlx_whisper
    except Exception:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "本地离线语音引擎未安装。请先运行: python3 -m pip install mlx-whisper",
                }
            )
        )
        return 2

    options = {}
    if args.model:
      options["path_or_hf_repo"] = args.model
    if args.language:
      options["language"] = args.language

    try:
        result = mlx_whisper.transcribe(args.input, **options)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1

    print(
        json.dumps(
            {
                "ok": True,
                "text": (result or {}).get("text", ""),
                "language": (result or {}).get("language", ""),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
