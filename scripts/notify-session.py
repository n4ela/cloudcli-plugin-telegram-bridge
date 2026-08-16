#!/usr/bin/env python3
"""Deliver a local file to the Telegram chat bound to a CloudCLI session."""

import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen


CONFIG_PATH = Path("/root/.cloudcli/telegram-bridge/config.json")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("session_id")
    parser.add_argument("message_file", type=Path)
    parser.add_argument("--title", default="")
    parser.add_argument("--silent", action="store_true")
    args = parser.parse_args()

    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    websocket_url = urlsplit(config["cloudcliWsUrl"])
    rpc_url = urlunsplit((
        "https" if websocket_url.scheme == "wss" else "http",
        websocket_url.netloc,
        "/api/plugins/telegram-bridge/rpc/notify",
        "",
        "",
    ))

    message = args.message_file.read_text(encoding="utf-8").strip()
    if args.title:
        message = f"{args.title.strip()}\n\n{message}"

    payload = json.dumps({
        "sessionId": args.session_id,
        "text": message,
        "silent": args.silent,
    }).encode("utf-8")
    request = Request(
        rpc_url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {config['cloudcliJwt']}",
            "Content-Type": "application/json",
        },
    )
    with urlopen(request, timeout=30) as response:
        result = json.loads(response.read().decode("utf-8"))

    if not result.get("success"):
        raise RuntimeError(f"Telegram Bridge rejected notification: {result}")
    print(f"Telegram notification delivered to {result.get('deliveredTo', 0)} binding(s)")


if __name__ == "__main__":
    main()
