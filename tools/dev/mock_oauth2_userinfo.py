from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs, urlencode
import json
import secrets


HOST = "0.0.0.0"
PORT = 9000

CLIENT_ID = "pi-container-test"
CLIENT_SECRET = "pi-container-secret"

# 用这个变量快速切换“当前泛微用户”
CURRENT_USER = {
    "workcode": "3333",
    "email": "user3333@example.internal",
    "displayName": "Test User 3333",
    "groupcode": "test-group",
}

issued_codes = {}
issued_tokens = {}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Never let query tokens or callback codes enter ordinary mock-server logs.
        print("[%s] %s %s" % (
            self.address_string(),
            self.command,
            urlparse(self.path).path,
        ))

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/authorize":
            client_id = query.get("client_id", [""])[0]
            redirect_uri = query.get("redirect_uri", [""])[0]
            state = query.get("state", [""])[0]
            response_type = query.get("response_type", [""])[0]
            code_challenge = query.get("code_challenge", [""])[0]
            code_challenge_method = query.get("code_challenge_method", [""])[0]

            print("\n=== AUTHORIZE ===")
            print("client_id:", client_id)
            print("redirect_uri:", redirect_uri)
            print("response_type:", response_type)
            print("code_challenge_method:", code_challenge_method)

            if client_id != CLIENT_ID:
                return self.send_json(400, {"error": "invalid_client"})

            if response_type != "code":
                return self.send_json(400, {"error": "unsupported_response_type"})

            code = secrets.token_urlsafe(24)

            issued_codes[code] = {
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "code_challenge": code_challenge,
                "user": CURRENT_USER.copy(),
            }

            location = redirect_uri + "?" + urlencode({
                "code": code,
                "state": state,
            })

            self.send_response(302)
            self.send_header("Location", location)
            self.end_headers()
            return

        if path in ("/profile", "/sso/oauth2.0/profile"):
            token = query.get("access_token", [""])[0]

            auth = self.headers.get("Authorization", "")
            if not token and auth.lower().startswith("bearer "):
                token = auth[7:].strip()

            print("\n=== PROFILE ===")
            print("token_present:", bool(token))

            user = issued_tokens.get(token)
            if user is None:
                return self.send_json(401, {
                    "error": "invalid_token"
                })

            # 模拟泛微 nested JSON
            return self.send_json(200, {
                "id": "mock-user-id",
                "attributes": {
                    "workcode": user["workcode"],
                    "email": user["email"],
                    "displayName": user["displayName"],
                    "groupcode": user["groupcode"],
                }
            })

        if path == "/":
            return self.send_json(200, {
                "service": "mock-weaver-oauth2",
                "current_user": CURRENT_USER,
            })

        return self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path != "/token":
            return self.send_json(404, {"error": "not_found"})

        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8")
        form = parse_qs(raw)

        grant_type = form.get("grant_type", [""])[0]
        code = form.get("code", [""])[0]
        redirect_uri = form.get("redirect_uri", [""])[0]
        client_id = form.get("client_id", [""])[0]
        client_secret = form.get("client_secret", [""])[0]
        code_verifier = form.get("code_verifier", [""])[0]

        print("\n=== TOKEN ===")
        print("grant_type:", grant_type)
        print("redirect_uri:", redirect_uri)
        print("client_id:", client_id)
        print("client_secret_present:", bool(client_secret))
        print("code_verifier_present:", bool(code_verifier))

        if grant_type != "authorization_code":
            return self.send_json(400, {"error": "unsupported_grant_type"})

        if client_id != CLIENT_ID or client_secret != CLIENT_SECRET:
            return self.send_json(401, {"error": "invalid_client"})

        record = issued_codes.pop(code, None)
        if record is None:
            return self.send_json(400, {"error": "invalid_grant"})

        if record["redirect_uri"] != redirect_uri:
            return self.send_json(400, {"error": "redirect_uri_mismatch"})

        # 这里暂时不严格校验 PKCE；只确认 verifier 存在，不输出其原文。
        if not code_verifier:
            return self.send_json(400, {"error": "missing_code_verifier"})

        access_token = secrets.token_urlsafe(32)
        issued_tokens[access_token] = record["user"]

        return self.send_json(200, {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": 3600,
        })


if __name__ == "__main__":
    print(f"Mock Weaver OAuth2 server listening on http://{HOST}:{PORT}")
    print("Client ID:", CLIENT_ID)
    print("Current user:", CURRENT_USER)
    HTTPServer((HOST, PORT), Handler).serve_forever()
