from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache" / "rainworks"
APP_UA = "Rainworks/0.1 (local WSL2 urban water simulation)"
CACHE.mkdir(parents=True, exist_ok=True)
_geocode_lock = threading.Lock()
_last_geocode = 0.0


def cache_paths(key: str):
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    folder = CACHE / digest[:2]
    folder.mkdir(parents=True, exist_ok=True)
    return folder / (digest + ".body"), folder / (digest + ".json")


def read_cache(key: str):
    body_path, meta_path = cache_paths(key)
    try:
        body = body_path.read_bytes()
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        return body, meta
    except (OSError, ValueError, json.JSONDecodeError):
        return None, None


def write_cache(key: str, body: bytes, content_type: str, ttl: int) -> None:
    body_path, meta_path = cache_paths(key)
    suffix = f".{threading.get_ident()}.tmp"
    body_tmp, meta_tmp = body_path.with_name(body_path.name + suffix), meta_path.with_name(meta_path.name + suffix)
    body_tmp.write_bytes(body)
    meta_tmp.write_text(json.dumps({
        "content_type": content_type,
        "stored_at": time.time(),
        "expires_at": time.time() + ttl,
    }), encoding="utf-8")
    os.replace(body_tmp, body_path)
    os.replace(meta_tmp, meta_path)


def max_age(headers, fallback: int) -> int:
    value = headers.get("Cache-Control", "")
    match = re.search(r"max-age=(\d+)", value, re.IGNORECASE)
    if "no-store" in value.lower() or "no-cache" in value.lower():
        return 0
    return int(match.group(1)) if match else fallback


def cached_request(key: str, fetch, ttl: int):
    body, meta = read_cache(key)
    if body is not None and meta and meta.get("expires_at", 0) > time.time():
        return body, meta.get("content_type", "application/octet-stream"), "HIT", max(0, int(meta.get("expires_at", 0) - time.time()))
    try:
        response_body, content_type, response_ttl = fetch()
        write_cache(key, response_body, content_type, ttl if response_ttl is None else response_ttl)
        return response_body, content_type, "MISS", max(0, int(response_ttl or 0))
    except Exception:
        if body is not None and meta:
            return body, meta.get("content_type", "application/octet-stream"), "STALE", 0
        raise


def upstream_get(url: str, *, referer: Optional[str] = None, fallback_ttl: int = 86400):
    headers = {"User-Agent": APP_UA}
    if referer:
        headers["Referer"] = referer
    request = Request(url, headers=headers)
    with urlopen(request, timeout=45) as response:
        body = response.read()
        content_type = response.headers.get("Content-Type", "application/octet-stream")
        ttl = max_age(response.headers, fallback_ttl)
    return body, content_type, ttl


class RainworksHandler(SimpleHTTPRequestHandler):
    server_version = "RainworksLocal/0.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        print(f"[http] {self.address_string()} - {fmt % args}")

    def send_payload(self, status: int, body: bytes, content_type: str, cache_state: str = "BYPASS", ttl: int = 0):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Rainworks-Cache", cache_state)
        self.send_header("Cache-Control", f"private, max-age={min(max(ttl, 0), 30 * 86400)}")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status: int, message: str):
        body = json.dumps({"error": message}, ensure_ascii=False).encode("utf-8")
        self.send_payload(status, body, "application/json; charset=utf-8")

    def serve_cached(self, key: str, fetch, ttl: int):
        try:
            body, content_type, state, remaining_ttl = cached_request(key, fetch, ttl)
            print(f"[cache] {state} {key.partition(':')[0]} {hashlib.sha256(key.encode()).hexdigest()[:12]}")
            self.send_payload(200, body, content_type, state, remaining_ttl)
        except HTTPError as error:
            self.send_error_json(502, f"Upstream returned HTTP {error.code}")
        except (URLError, TimeoutError, OSError, ValueError) as error:
            self.send_error_json(502, f"Upstream request failed: {error}")
        except Exception as error:
            self.send_error_json(502, f"Data request failed: {error}")

    def do_GET(self):
        global _last_geocode
        parsed = urlsplit(self.path)
        path = parsed.path

        if path.startswith("/api/cache/gsi/"):
            match = re.fullmatch(r"/api/cache/gsi/(dem5a_png|dem5b_png|dem5c_png|dem_png)/(\d{1,2})/(\d{1,6})/(\d{1,6})\.png", path)
            if not match:
                return self.send_error_json(400, "Invalid GSI tile path")
            layer, z, x, y = match.groups()
            upstream = f"https://cyberjapandata.gsi.go.jp/xyz/{layer}/{z}/{x}/{y}.png"
            return self.serve_cached("gsi:" + upstream, lambda: upstream_get(upstream, fallback_ttl=30 * 86400), 30 * 86400)

        if path.startswith("/api/cache/osm/"):
            match = re.fullmatch(r"/api/cache/osm/(\d{1,2})/(\d{1,7})/(\d{1,7})\.png", path)
            if not match:
                return self.send_error_json(400, "Invalid OSM tile path")
            z, x, y = match.groups()
            upstream = f"https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            return self.serve_cached("osm:" + upstream, lambda: upstream_get(upstream, referer="http://" + self.headers.get("Host", "localhost:8000") + "/", fallback_ttl=7 * 86400), 7 * 86400)

        if path == "/api/cache/elevation":
            params = parse_qs(parsed.query)
            latitudes = params.get("latitude", [""])[0]
            longitudes = params.get("longitude", [""])[0]
            if not latitudes or not longitudes or len(latitudes.split(",")) != len(longitudes.split(",")) or len(latitudes.split(",")) > 100:
                return self.send_error_json(400, "Elevation requests need 1–100 matching latitude/longitude pairs")
            upstream = "https://api.open-meteo.com/v1/elevation?" + urlencode({"latitude": latitudes, "longitude": longitudes})
            return self.serve_cached("elevation:" + upstream, lambda: upstream_get(upstream, fallback_ttl=30 * 86400), 30 * 86400)

        if path == "/api/cache/search":
            params = parse_qs(parsed.query)
            query = params.get("q", [""])[0].strip()
            if not query or len(query) > 200:
                return self.send_error_json(400, "Enter a place name")
            upstream = "https://nominatim.openstreetmap.org/search?" + urlencode({"format": "json", "limit": "1", "q": query, "accept-language": "ja"})
            key = "search:" + query.casefold()
            def geocode_fetch():
                global _last_geocode
                with _geocode_lock:
                    delay = 1.1 - (time.monotonic() - _last_geocode)
                    if delay > 0:
                        time.sleep(delay)
                    _last_geocode = time.monotonic()
                return upstream_get(upstream, referer="http://" + self.headers.get("Host", "localhost:8000") + "/", fallback_ttl=30 * 86400)
            return self.serve_cached(key, geocode_fetch, 30 * 86400)

        if path.startswith("/api/cache/"):
            return self.send_error_json(404, "Unknown cache endpoint")
        return super().do_GET()

    def do_POST(self):
        if urlsplit(self.path).path != "/api/cache/overpass":
            return self.send_error_json(404, "Unknown cache endpoint")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 200_000:
                return self.send_error_json(400, "Invalid Overpass request size")
            form = parse_qs(self.rfile.read(length).decode("utf-8", errors="replace"))
            query = form.get("data", [""])[0]
            if not query or len(query) > 150_000:
                return self.send_error_json(400, "Missing or oversized Overpass query")
            key = "overpass:" + hashlib.sha256(query.encode("utf-8")).hexdigest()
            endpoints = [
                "https://overpass.private.coffee/api/interpreter",
                "https://overpass-api.de/api/interpreter",
                "https://overpass.kumi.systems/api/interpreter",
            ]
            def fetch_overpass():
                last_error = None
                payload = urlencode({"data": query}).encode("utf-8")
                for endpoint in endpoints:
                    try:
                        request = Request(endpoint, data=payload, headers={
                            "User-Agent": APP_UA,
                            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                        })
                        with urlopen(request, timeout=90) as response:
                            body = response.read()
                            content_type = response.headers.get("Content-Type", "application/json")
                            return body, content_type, 24 * 3600
                    except Exception as error:
                        last_error = error
                raise RuntimeError(f"All Overpass instances failed: {last_error}")
            return self.serve_cached(key, fetch_overpass, 24 * 3600)
        except (ValueError, UnicodeError) as error:
            return self.send_error_json(400, str(error))


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Rainworks local server with persistent data cache")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port (default: 8000)")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), RainworksHandler)
    print(f"Rainworks server: http://{args.host}:{args.port}/")
    print(f"Persistent cache: {CACHE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nRainworks server stopped")
    finally:
        server.server_close()






