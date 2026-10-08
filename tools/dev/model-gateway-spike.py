#!/usr/bin/env python3
"""DEV ONLY: verifies the pinned LiteLLM gateway against specs.md Phase 16.3 / 16.15.

Reads LITELLM_MASTER_KEY from the 0600 gateway env file in-process and never prints any key.
Creates a throwaway LiteLLM user and an `llm_api` virtual key, then checks:
  1. the virtual key cannot call management routes;
  2. a streamed two-turn tool call with thinking succeeds for every model given, with the
     assistant `reasoning_content` replayed exactly as Pi 0.85.1 does (thinkingFormat "deepseek");
  3. client-supplied api_base / api_key do not redirect the request;
  4. spend is attributed to the user and spend logs hold no prompt or response text;
  5. a deleted key is rejected immediately.
Real upstream calls cost a few cents.

Usage: tools/dev/model-gateway-spike.py ~/.config/agent-runtime/litellm.env \
         [--url http://127.0.0.1:4400] [--model deepseek-v4-flash ...]
"""

import argparse
import json
import os
import re
import secrets
import stat
import sys
import time
import urllib.error
import urllib.request

SECRET_PATTERN = re.compile(r"sk-[A-Za-z0-9_\-]{6,}")
MARKER = "SPIKE-MARKER-" + secrets.token_hex(6)


def redact(text: str) -> str:
    return SECRET_PATTERN.sub("sk-<redacted>", text)


def load_master_key(path: str) -> str:
    info = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
        sys.exit(f"{path} must be a regular file with mode 0600")
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("LITELLM_MASTER_KEY="):
                return line.split("=", 1)[1].strip()
    sys.exit("LITELLM_MASTER_KEY not found")


def request(base, path, key, body=None, method=None, timeout=180):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        base + path,
        data=data,
        method=method or ("POST" if body is not None else "GET"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def stream_chat(base, key, body):
    """Returns (status, content, reasoning, tool_calls, usage, error_text)."""
    data = json.dumps({**body, "stream": True, "stream_options": {"include_usage": True}}).encode()
    req = urllib.request.Request(
        base + "/v1/chat/completions",
        data=data,
        method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    content, reasoning, usage, calls = [], [], None, {}
    try:
        with urllib.request.urlopen(req, timeout=600) as response:
            for raw in response:
                line = raw.decode().strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                chunk = json.loads(payload)
                usage = chunk.get("usage") or usage
                for choice in chunk.get("choices", []):
                    delta = choice.get("delta") or {}
                    content.append(delta.get("content") or "")
                    reasoning.append(delta.get("reasoning_content") or "")
                    for call in delta.get("tool_calls") or []:
                        slot = calls.setdefault(call.get("index", 0), {"id": "", "name": "", "arguments": ""})
                        slot["id"] = call.get("id") or slot["id"]
                        function = call.get("function") or {}
                        slot["name"] = function.get("name") or slot["name"]
                        slot["arguments"] += function.get("arguments") or ""
            return response.status, "".join(content), "".join(reasoning), calls, usage, ""
    except urllib.error.HTTPError as error:
        return error.code, "", "", {}, None, error.read().decode()


results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {redact(detail)[:300]}" if detail else ""))


TOOLS = [{
    "type": "function",
    "function": {
        "name": "read_marker",
        "description": "Returns the content of the marker file. Always call it before answering.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
}]


def two_turn(base, key, model, effort):
    messages = [
        {"role": "system", "content": "You are a test agent. Use tools when asked."},
        {"role": "user", "content": "Call read_marker, then reply with exactly the marker it returns."},
    ]
    common = {"model": model, "tools": TOOLS, "max_tokens": 2048,
              "thinking": {"type": "enabled"}, "reasoning_effort": effort}
    status, content, reasoning, calls, _, error = stream_chat(base, key, {**common, "messages": messages})
    check(f"{model}: turn 1 status 200", status == 200, error)
    if status != 200:
        return
    # The model may legitimately skip thinking on a trivial step; turn 2 still replays the field.
    print(f"      (info) {model}: turn 1 reasoning_content {len(reasoning)} chars")
    check(f"{model}: turn 1 called read_marker", any(c["name"] == "read_marker" for c in calls.values()),
          json.dumps([c["name"] for c in calls.values()]))
    if not calls:
        return
    assistant = {
        "role": "assistant",
        "content": content or None,
        "reasoning_content": reasoning,
        "tool_calls": [{"id": c["id"], "type": "function",
                        "function": {"name": c["name"], "arguments": c["arguments"] or "{}"}}
                       for c in calls.values()],
    }
    tool_results = [{"role": "tool", "tool_call_id": c["id"], "content": MARKER} for c in calls.values()]
    turn2 = messages + [assistant] + tool_results
    status, content, _, _, usage, error = stream_chat(base, key, {**common, "messages": turn2})
    check(f"{model}: turn 2 (reasoning_content replayed) status 200", status == 200, error)
    check(f"{model}: turn 2 answer contains the marker", MARKER in content, content[:120])
    check(f"{model}: streamed usage present", bool(usage and usage.get("total_tokens")), json.dumps(usage)[:200])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("env_file")
    parser.add_argument("--url", default="http://127.0.0.1:4400")
    parser.add_argument("--model", action="append")
    parser.add_argument("--effort", default="high")
    args = parser.parse_args()
    base = args.url.rstrip("/")
    master = load_master_key(os.path.expanduser(args.env_file))
    models = args.model or ["deepseek-v4-flash", "mimo-v2.5-pro"]

    status, body = request(base, "/model/info", master)
    names = sorted({m["model_name"] for m in json.loads(body).get("data", [])}) if status == 200 else []
    check("master key reads model list", status == 200, ", ".join(names))
    check("model info hides upstream keys", "os.environ" not in body and not SECRET_PATTERN.search(
        json.dumps([m.get("litellm_params", {}).get("api_key") for m in json.loads(body).get("data", [])])))

    user_id = "spike-" + secrets.token_hex(4)
    alias = f"arw-spike-{secrets.token_hex(4)}"
    status, body = request(base, "/user/new", master, {"user_id": user_id, "user_role": "internal_user_viewer"})
    check("create gateway user", status == 200, "" if status == 200 else body)
    status, body = request(base, "/key/generate", master, {
        "user_id": user_id, "key_alias": alias, "key_type": "llm_api", "models": models,
        "metadata": {"platform_workspace_id": "spike"}, "rpm_limit": 60,
    })
    check("generate llm_api virtual key", status == 200, "" if status == 200 else body)
    if status != 200:
        return finish()
    generated = json.loads(body)
    vkey = generated["key"]
    check("generate response exposes no upstream key", "DEEPSEEK" not in body and "XIAOMI" not in body)
    print("      generate response fields:", ", ".join(sorted(generated.keys()))[:400])

    for method, path, payload in [
        ("POST", "/key/generate", {"user_id": user_id}),
        ("GET", "/key/list", None),
        ("POST", "/key/delete", {"key_aliases": [alias]}),
        ("GET", "/user/list", None),
        ("POST", "/user/new", {"user_id": "spike-evil"}),
        ("POST", "/model/new", {"model_name": "x", "litellm_params": {"model": "openai/x"}}),
        ("GET", "/spend/logs", None),
        ("GET", "/global/spend", None),
        ("GET", f"/user/info?user_id={user_id}", None),
    ]:
        status, body = request(base, path, vkey, payload, method)
        check(f"virtual key denied {method} {path.split('?')[0]}", status in (401, 403, 404), f"status {status}")
    # Read-only routes LiteLLM leaves open to llm_api keys. The Worker relay never forwards them
    # (path allow-list, Phase 16.4); here we only confirm they leak nothing beyond the key's models.
    status, body = request(base, "/model/info", vkey)
    data = json.loads(body).get("data", []) if status == 200 else []
    params = [m.get("litellm_params", {}) for m in data]
    check("virtual key /model/info shows only its models and no credentials",
          status in (401, 403) or ({m["model_name"] for m in data} <= set(models)
                                   and all(p.get("api_key") is None for p in params)),
          f"status {status}; api_base values: {sorted({str(p.get('api_base')) for p in params})}")
    status, _ = request(base, "/v1/models", vkey)
    print(f"      (info) virtual key GET /v1/models -> {status}; GET /ui serves the static UI shell (login-gated)")

    for model in models:
        two_turn(base, vkey, model, args.effort)

    status, body = request(base, "/v1/chat/completions", vkey, {
        "model": models[0], "max_tokens": 16, "messages": [{"role": "user", "content": "Say ok."}],
        "api_base": "http://127.0.0.1:9/v1", "base_url": "http://127.0.0.1:9/v1", "api_key": "sk-bogus-client-key",
        "thinking": {"type": "disabled"},
    })
    check("client api_base/api_key rejected or ignored (no redirect)",
          status in (200, 400, 401, 403) and "127.0.0.1:9" not in body and "Connection refused" not in body,
          f"status {status} {body[:200]}")
    print(f"      (info) client-override request status {status}")

    print("      waiting 25 s for spend to flush ...")
    time.sleep(25)
    status, body = request(base, f"/user/info?user_id={user_id}", master)
    spend = json.loads(body).get("user_info", {}).get("spend") if status == 200 else None
    check("spend attributed to the gateway user", status == 200 and (spend or 0) > 0, f"spend={spend}")
    status, body = request(base, f"/spend/logs?user_id={user_id}", master)
    check("spend logs readable", status == 200, f"status {status}")
    check("spend logs contain no prompt or response text", MARKER not in body and "read_marker, then reply" not in body)
    if status == 200:
        rows = json.loads(body)
        rows = rows if isinstance(rows, list) else rows.get("data", [])
        print(f"      (info) spend log rows: {len(rows)}; fields: {', '.join(sorted(rows[0].keys()))[:400] if rows else '-'}")

    status, body = request(base, "/key/delete", master, {"key_aliases": [alias]})
    check("delete key by alias", status == 200, "" if status == 200 else body)
    status, body = request(base, "/v1/chat/completions", vkey,
                           {"model": models[0], "max_tokens": 8, "messages": [{"role": "user", "content": "hi"}]})
    check("deleted key rejected", status in (401, 403), f"status {status}")
    status, body = request(base, "/key/delete", master, {"key_aliases": [alias]})
    print(f"      (info) deleting an already deleted alias -> {status} {redact(body)[:160]}")
    request(base, "/user/delete", master, {"user_ids": [user_id]})
    return finish()


def finish():
    passed = sum(results)
    print(f"\n{passed}/{len(results)} checks passed")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
