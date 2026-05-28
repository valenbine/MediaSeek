import asyncio
import html
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request
from starlette.background import BackgroundTask
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, HttpUrl

try:
    import yt_dlp
except ImportError:  # pragma: no cover - handled at runtime for clear UI errors
    yt_dlp = None


APP_DIR = Path(__file__).resolve().parent
TOKEN_TTL_SECONDS = int(os.getenv("TOKEN_TTL_SECONDS", str(6 * 60 * 60)))
PARSE_TTL_SECONDS = int(os.getenv("PARSE_TTL_SECONDS", str(30 * 60)))
COOKIE_SESSION_TTL_SECONDS = int(os.getenv("COOKIE_SESSION_TTL_SECONDS", str(6 * 60 * 60)))
MAX_FORMATS = 80
MAX_COOKIE_FILE_BYTES = int(os.getenv("MAX_COOKIE_FILE_BYTES", str(16 * 1024 * 1024)))
PORT = int(os.getenv("PORT", "5000"))
ALLOWED_COOKIE_SUFFIXES = {".txt", ".sqlite"}
FFMPEG_PACKAGE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

SUPPORTED_ENGINES = {"you-get", "yt-dlp", "lux"}
DEFAULT_ENGINE = "you-get"

app = FastAPI(title="MediaSeek")

parsed_cache: dict[str, dict[str, Any]] = {}
stream_tokens: dict[str, dict[str, Any]] = {}
ffmpeg_worker_cache: str | None = None
session_cookie_file: Path | None = None
session_cookie_updated_at: float | None = None
session_cookie_name: str | None = None


class DownloadRequest(BaseModel):
    parseId: str
    asset: str
    formatId: str | None = None
    language: str | None = None
    subtitleKind: str | None = None


class SearchRequest(BaseModel):
    keyword: str
    engine: str | None = None
    limit: int | None = None


def bilibili_result_url(entry: dict[str, Any]) -> str | None:
    candidate = entry.get("arcurl") or entry.get("bvid") or entry.get("url")
    if isinstance(candidate, str) and candidate.startswith(("http://", "https://")):
        return browser_safe_url(candidate)
    if isinstance(candidate, str) and candidate.upper().startswith("BV"):
        return f"https://www.bilibili.com/video/{candidate}"
    return None


def parse_duration_value(value: Any) -> int | None:
    if isinstance(value, (int, float)):
        numeric = int(value)
        return numeric if numeric >= 0 else None
    if not isinstance(value, str) or not value:
        return None
    parts = value.split(":")
    if not all(part.isdigit() for part in parts):
        return None
    numbers = [int(part) for part in parts]
    if len(numbers) == 2:
        return numbers[0] * 60 + numbers[1]
    if len(numbers) == 3:
        return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
    return None


def cookie_domain_matches(cookie_domain: str, hostname: str) -> bool:
    domain = cookie_domain.lstrip(".").lower()
    host = hostname.lower()
    return host == domain or host.endswith(f".{domain}")


def build_cookie_header_for_host(cookie_path: Path | None, hostname: str) -> tuple[str | None, Path | None]:
    if cookie_path is None:
        return None, None

    source_path = cookie_path
    converted_path: Path | None = None
    if cookie_path.suffix.lower() == ".sqlite":
        converted_path = convert_firefox_cookie_db(cookie_path)
        source_path = converted_path

    cookie_pairs: list[str] = []
    seen_names: set[str] = set()
    current_time = int(time.time())
    with source_path.open("r", encoding="utf-8", errors="ignore") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) != 7:
                continue
            domain, _include_subdomains, path, _secure, expires, name, value = parts
            if not name or name in seen_names:
                continue
            if not cookie_domain_matches(domain, hostname):
                continue
            if expires.isdigit() and int(expires) not in {0} and int(expires) < current_time:
                continue
            if not path.startswith("/"):
                continue
            seen_names.add(name)
            cookie_pairs.append(f"{name}={value}")

    return ("; ".join(cookie_pairs) if cookie_pairs else None), converted_path


def decode_js_string(value: str) -> str:
    try:
        return json.loads(f'"{value}"')
    except Exception:
        return value


def search_with_bilibili_page(keyword: str, limit: int) -> list[dict[str, Any]]:
    url = f"https://search.bilibili.com/all?keyword={quote(keyword)}"
    headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Referer": "https://www.bilibili.com/",
    }
    cookie_header, converted_cookie_path = build_cookie_header_for_host(active_session_cookie(), "search.bilibili.com")
    if cookie_header:
        headers["Cookie"] = cookie_header
    try:
        with httpx.Client(timeout=20.0, headers=headers, follow_redirects=True) as client:
            response = client.get(url)
            response.raise_for_status()
            body = response.text
    finally:
        if converted_cookie_path is not None:
            converted_cookie_path.unlink(missing_ok=True)

    pattern = re.compile(
        r'author:(?P<author>"(?:\\.|[^"])*"|[^,]+),.*?'
        r'arcurl:"(?P<arcurl>(?:\\.|[^"])*)".*?'
        r'bvid:"(?P<bvid>[^"]+)".*?'
        r'title:"(?P<title>(?:\\.|[^"])*)".*?'
        r'pic:"(?P<pic>(?:\\.|[^"])*)".*?'
        r'duration:"(?P<duration>[^"]+)"',
        re.DOTALL,
    )

    results = []
    seen_urls = set()
    for match in pattern.finditer(body):
        raw_author = match.group("author").strip()
        author = decode_js_string(raw_author[1:-1]) if raw_author.startswith('"') and raw_author.endswith('"') else raw_author
        webpage_url = browser_safe_url(decode_js_string(match.group("arcurl")))
        if not webpage_url or webpage_url in seen_urls:
            continue
        seen_urls.add(webpage_url)
        title = html.unescape(re.sub(r"<[^>]+>", "", decode_js_string(match.group("title"))))
        thumbnail = browser_safe_url(decode_js_string(match.group("pic")))
        if thumbnail and thumbnail.startswith("//"):
            thumbnail = f"https:{thumbnail}"
        duration_raw = decode_js_string(match.group("duration"))
        duration_value = parse_duration_value(duration_raw)
        results.append({
            "id": match.group("bvid"),
            "title": title,
            "source": "Video Site",
            "duration": duration_value,
            "durationText": duration_text(duration_value) if duration_value is not None else duration_raw,
            "thumbnail": thumbnail,
            "webpageUrl": webpage_url,
            "uploader": html.unescape(author) or "--",
            "engine": "site-search",
            "recommendedEngine": "you-get",
        })
        if len(results) >= limit:
            break
    return results


def search_with_bilibili(keyword: str, limit: int) -> list[dict[str, Any]]:
    url = "https://api.bilibili.com/x/web-interface/search/type"
    headers = {
        "User-Agent": DEFAULT_USER_AGENT,
        "Referer": "https://www.bilibili.com/",
    }
    params = {
        "search_type": "video",
        "keyword": keyword,
        "page": 1,
        "page_size": limit,
    }
    cookie_header, converted_cookie_path = build_cookie_header_for_host(active_session_cookie(), "api.bilibili.com")
    if cookie_header:
        headers["Cookie"] = cookie_header
    try:
        try:
            with httpx.Client(timeout=20.0, headers=headers, follow_redirects=True) as client:
                response = client.get(url, params=params)
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPStatusError as error:
            if error.response is not None and error.response.status_code == 412:
                return search_with_bilibili_page(keyword, limit)
            raise
    finally:
        if converted_cookie_path is not None:
            converted_cookie_path.unlink(missing_ok=True)

    data = payload.get("data") or {}
    result_items = data.get("result") or []
    results = []
    for item in result_items:
        if not isinstance(item, dict):
            continue
        webpage_url = bilibili_result_url(item)
        if not webpage_url:
            continue
        title = re.sub(r"<[^>]+>", "", str(item.get("title") or "未命名结果"))
        thumbnail = browser_safe_url(item.get("pic"))
        if thumbnail and thumbnail.startswith("//"):
            thumbnail = f"https:{thumbnail}"
        duration_value = parse_duration_value(item.get("duration"))
        results.append({
            "id": item.get("bvid") or item.get("aid") or secrets.token_urlsafe(6),
            "title": title,
            "source": "Video Site",
            "duration": duration_value,
            "durationText": duration_text(duration_value) if duration_value is not None else str(item.get("duration") or "--"),
            "thumbnail": thumbnail,
            "webpageUrl": webpage_url,
            "uploader": item.get("author") or "--",
            "engine": "site-search",
            "recommendedEngine": "you-get",
        })
    return results


def now() -> float:
    return time.time()


def cleanup_expired() -> None:
    current = now()
    expired_parse_ids = [
        parse_id for parse_id, entry in parsed_cache.items()
        if current - entry["createdAt"] > PARSE_TTL_SECONDS
    ]
    for parse_id in expired_parse_ids:
        parsed_cache.pop(parse_id, None)

    expired_tokens = [
        token for token, entry in stream_tokens.items()
        if current - entry["createdAt"] > TOKEN_TTL_SECONDS
    ]
    for token in expired_tokens:
        stream_tokens.pop(token, None)

    if session_cookie_file is not None and session_cookie_updated_at is not None:
        if current - session_cookie_updated_at > COOKIE_SESSION_TTL_SECONDS:
            set_session_cookie(None)


def validate_public_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=400, detail="请输入有效的 http 或 https 视频页面地址。")
    return value


def cookie_suffix(filename: str | None) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix not in ALLOWED_COOKIE_SUFFIXES:
        raise HTTPException(status_code=400, detail="Cookie 文件仅支持 cookies.txt 或 cookies.sqlite。")
    return suffix


def engine_cookie_compatibility(suffix: str) -> dict[str, bool]:
    return {
        "you-get": suffix == ".sqlite",
        "yt-dlp": suffix in {".txt", ".sqlite"},
        "lux": suffix in {".txt", ".sqlite"},
    }


def validate_cookie_for_engine(cookie_path: Path, engine: str) -> None:
    suffix = cookie_path.suffix.lower()
    compatibility = engine_cookie_compatibility(suffix)
    if compatibility.get(engine):
        return
    if engine == "you-get":
        raise HTTPException(status_code=400, detail="you-get 仅支持 Firefox cookies.sqlite，请改传 cookies.sqlite。")
    raise HTTPException(status_code=400, detail=f"{engine} 仅支持 cookies.txt 或 Firefox cookies.sqlite。")


def netscape_bool(value: Any) -> str:
    return "TRUE" if bool(value) else "FALSE"


def convert_firefox_cookie_db(cookie_path: Path) -> Path:
    converted = tempfile.NamedTemporaryFile(prefix="mediaseek-cookie-converted-", suffix=".txt", delete=False)
    converted_path = Path(converted.name)
    converted.close()

    try:
        connection = sqlite3.connect(f"file:{cookie_path}?mode=ro", uri=True)
        try:
            rows = connection.execute(
                """
                SELECT host, path, isSecure, expiry, name, value
                FROM moz_cookies
                WHERE name IS NOT NULL AND value IS NOT NULL
                """
            ).fetchall()
        finally:
            connection.close()

        with converted_path.open("w", encoding="utf-8") as cookie_file:
            cookie_file.write("# Netscape HTTP Cookie File\n")
            for host, path, is_secure, expiry, name, value in rows:
                if not host or not name:
                    continue
                include_subdomains = str(host).startswith(".")
                cookie_file.write(
                    "\t".join([
                        str(host),
                        netscape_bool(include_subdomains),
                        str(path or "/"),
                        netscape_bool(is_secure),
                        str(int(expiry or 0)),
                        str(name),
                        str(value),
                    ]) + "\n"
                )
    except Exception as error:
        converted_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="无法读取 Firefox cookies.sqlite，请确认文件来自 Firefox 配置目录。") from error

    return converted_path


async def save_cookie_upload(upload: Any) -> Path | None:
    if upload is None or not getattr(upload, "filename", None):
        return None

    suffix = cookie_suffix(upload.filename)
    temp_file = tempfile.NamedTemporaryFile(prefix="mediaseek-cookie-", suffix=suffix, delete=False)
    cookie_path = Path(temp_file.name)
    size = 0

    try:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_COOKIE_FILE_BYTES:
                raise HTTPException(status_code=400, detail="Cookie 文件不能超过 16 MB。")
            temp_file.write(chunk)
    except Exception:
        cookie_path.unlink(missing_ok=True)
        raise
    finally:
        temp_file.close()
        await upload.close()

    if size == 0:
        cookie_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Cookie 文件不能为空。")

    return cookie_path


def set_session_cookie(cookie_path: Path | None, original_name: str | None = None) -> None:
    global session_cookie_file, session_cookie_updated_at, session_cookie_name
    if session_cookie_file is not None and session_cookie_file != cookie_path:
        session_cookie_file.unlink(missing_ok=True)
    session_cookie_file = cookie_path
    session_cookie_updated_at = now() if cookie_path is not None else None
    session_cookie_name = original_name if cookie_path is not None else None


def active_session_cookie() -> Path | None:
    cleanup_expired()
    if session_cookie_file is None:
        return None
    if session_cookie_file.exists():
        return session_cookie_file
    set_session_cookie(None)
    return None


def session_cookie_status() -> dict[str, Any]:
    cookie_file = active_session_cookie()
    if cookie_file is None:
        return {
            "active": False,
            "fileType": None,
            "originalName": None,
            "updatedAt": None,
            "expiresAt": None,
            "expired": False,
            "engineCompatibility": {engine: False for engine in SUPPORTED_ENGINES},
        }

    suffix = cookie_file.suffix.lower()
    return {
        "active": True,
        "fileType": "cookies.sqlite" if suffix == ".sqlite" else "cookies.txt",
        "originalName": session_cookie_name or cookie_file.name,
        "updatedAt": session_cookie_updated_at,
        "expiresAt": (session_cookie_updated_at or 0) + COOKIE_SESSION_TTL_SECONDS,
        "expired": False,
        "engineCompatibility": engine_cookie_compatibility(suffix),
    }


def cookie_session_hint(engine: str) -> str:
    status = session_cookie_status()
    if not status["active"]:
        return f"当前没有已加载的 Cookie 会话。请先上传 {cookie_requirement_text(engine)}。"
    if status.get("expired"):
        return "当前 Cookie 会话已过期，请重新加载最新登录态。"
    if not status["engineCompatibility"].get(engine):
        return f"当前 Cookie 会话与 {engine} 不兼容，请改传 {cookie_requirement_text(engine)}。"
    return f"当前 Cookie 会话可直接用于 {engine}。"


def prepare_cookie_for_engine(cookie_path: Path | None, engine: str) -> Path | None:
    if cookie_path is None:
        return None
    validate_cookie_for_engine(cookie_path, engine)
    if cookie_path.suffix.lower() == ".sqlite" and engine in {"yt-dlp", "lux"}:
        return convert_firefox_cookie_db(cookie_path)
    return cookie_path


def validate_engine(value: str | None) -> str:
    engine = (value or DEFAULT_ENGINE).strip().lower()
    if engine not in SUPPORTED_ENGINES:
        raise HTTPException(status_code=400, detail="解析器仅支持 you-get、yt-dlp 或 lux。")
    return engine


async def read_parse_input(request: Request) -> tuple[str, str, Path | None]:
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        target_url = str(form.get("url") or "").strip()
        engine = validate_engine(str(form.get("engine") or DEFAULT_ENGINE))
        cookie_upload = form.get("cookieFile")
        cookie_file = await save_cookie_upload(cookie_upload)
        return target_url, engine, cookie_file

    payload = await request.json()
    return str(payload.get("url") or "").strip(), validate_engine(str(payload.get("engine") or DEFAULT_ENGINE)), None


def sanitized_error(error: Exception, cookie_file: Path | None) -> str:
    text = str(error)
    if cookie_file is not None:
        text = text.replace(str(cookie_file), "[cookie-file]")
    text = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def host_name(target_url: str) -> str:
    return (urlparse(target_url).hostname or "").lower()


def is_bilibili_url(target_url: str) -> bool:
    host = host_name(target_url)
    return host.endswith("bilibili.com") or host.endswith("b23.tv")


def cookie_requirement_text(engine: str) -> str:
    if engine == "you-get":
        return "Firefox cookies.sqlite"
    return "cookies.txt 或 Firefox cookies.sqlite"


def safe_filename(value: str, fallback: str = "download") -> str:
    cleaned = re.sub(r"[^\w.\-\u4e00-\u9fff]+", "-", value, flags=re.UNICODE).strip("-.")
    return cleaned[:120] or fallback


def validate_search_keyword(value: str) -> str:
    keyword = value.strip()
    if not keyword:
        raise HTTPException(status_code=400, detail="请输入搜索关键词。")
    return keyword[:120]


def validate_search_limit(value: int | None) -> int:
    if value is None:
        return 8
    return max(1, min(int(value), 12))


def duration_text(seconds: Any) -> str:
    if not isinstance(seconds, (int, float)) or seconds <= 0:
        return "--"
    minutes, sec = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{sec:02d}"
    return f"{minutes}:{sec:02d}"


def parse_bitrate_text(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if value > 0 else None
    text = str(value).lower()
    match = re.search(r"(\d+(?:\.\d+)?)\s*(k|kbps|m|mbps)?", text)
    if not match:
        return None
    bitrate = float(match.group(1))
    unit = match.group(2) or "k"
    if unit.startswith("m"):
        bitrate *= 1000
    return bitrate if bitrate > 0 else None


def looks_like_resolution_text(value: Any) -> bool:
    if value is None:
        return False
    text = str(value).lower()
    return bool(re.search(r"\b(240|360|480|540|720|1080|1440|2160)p\b", text))


def normalized_audio_bitrate(item: dict[str, Any]) -> float | None:
    direct = (
        parse_bitrate_text(item.get("abr"))
        or parse_bitrate_text(item.get("audio_bitrate"))
    )
    if direct is not None:
        return direct
    note = item.get("format_note")
    if note and not looks_like_resolution_text(note):
        parsed = parse_bitrate_text(note)
        if parsed is not None:
            return parsed
    quality = item.get("quality")
    if quality and not looks_like_resolution_text(quality):
        return parse_bitrate_text(quality)
    return None


def normalized_video_bitrate(item: dict[str, Any]) -> float | None:
    return (
        parse_bitrate_text(item.get("vbr"))
        or parse_bitrate_text(item.get("tbr"))
        or parse_bitrate_text(item.get("format_note"))
        or parse_bitrate_text(item.get("quality"))
    )


def format_bitrate_text(value: float | None) -> str | None:
    if value is None:
        return None
    return f"{int(round(value))} kbps"


def parse_resolution_text(value: Any) -> tuple[int | None, int | None]:
    if value is None:
        return None, None
    text = str(value).lower()
    match = re.search(r"(\d{3,4})\s*[x*]\s*(\d{3,4})", text)
    if match:
        return int(match.group(1)), int(match.group(2))
    match = re.search(r"\b(240|360|480|540|720|1080|1440|2160)p\b", text)
    if match:
        return None, int(match.group(1))
    return None, None


def infer_video_codec(item: dict[str, Any]) -> str:
    codec = str(item.get("vcodec") or "")
    if codec and codec != "unknown":
        return codec
    text = str(item.get("format_note") or item.get("quality") or "").lower()
    if "avc" in text or "h264" in text:
        return "avc1"
    if "hev" in text or "h265" in text or "hevc" in text or "hvc1" in text:
        return "hvc1"
    if "av01" in text or re.search(r"\bav1\b", text):
        return "av01"
    if "vp9" in text:
        return "vp9"
    return "unknown"


def infer_audio_codec(item: dict[str, Any]) -> str:
    codec = str(item.get("acodec") or "")
    if codec and codec != "unknown":
        return codec
    ext = str(item.get("ext") or "").lower()
    text = str(item.get("format_note") or item.get("quality") or "").lower()
    if "mp4a" in text or "aac" in text or ext in {"m4a", "aac", "mp4"}:
        return "mp4a"
    if "opus" in text:
        return "opus"
    if "vorbis" in text or ext == "ogg":
        return "vorbis"
    if ext == "mp3" or "mp3" in text:
        return "mp3"
    return "unknown"


def parse_stream_quality_details(value: Any) -> dict[str, Any]:
    width, height = parse_resolution_text(value)
    text = str(value or "")
    lower = text.lower()
    video_codec = "unknown"
    audio_codec = "unknown"
    if "avc" in lower or "h264" in lower:
        video_codec = "avc1"
    elif "hev" in lower or "h265" in lower or "hevc" in lower or "hvc1" in lower:
        video_codec = "hvc1"
    elif "av01" in lower or re.search(r"\bav1\b", lower):
        video_codec = "av01"
    elif "vp9" in lower:
        video_codec = "vp9"
    if "mp4a" in lower or "aac" in lower:
        audio_codec = "mp4a"
    elif "opus" in lower:
        audio_codec = "opus"
    elif "vorbis" in lower:
        audio_codec = "vorbis"
    elif "mp3" in lower:
        audio_codec = "mp3"
    return {
        "width": width,
        "height": height,
        "videoCodec": video_codec,
        "audioCodec": audio_codec,
    }


def audio_like_ext(ext: str | None) -> bool:
    return str(ext or "").lower() in {"m4a", "aac", "mp3", "ogg", "opus", "wav", "flac", "webm"}


def normalize_thumbnail(value: Any) -> str | None:
    if isinstance(value, list):
        for item in reversed(value):
            if isinstance(item, dict):
                candidate = item.get("url") or item.get("src")
                normalized = browser_safe_url(candidate)
                if normalized:
                    return normalized
        return None
    if isinstance(value, dict):
        return browser_safe_url(value.get("url") or value.get("src"))
    return browser_safe_url(value)


def split_mux_sources(raw_value: Any) -> tuple[list[str], list[str] | None]:
    if isinstance(raw_value, list) and len(raw_value) >= 2:
        first = raw_value[0]
        second = raw_value[1]
        if isinstance(first, list) and isinstance(second, list):
            return stream_urls(first), stream_urls(second)
        if isinstance(first, dict) and isinstance(second, dict):
            groups = []
            for entry in raw_value:
                if not isinstance(entry, dict):
                    continue
                urls = stream_urls(entry)
                if not urls:
                    continue
                entry_type = str(entry.get("type") or entry.get("kind") or entry.get("media_type") or "").lower()
                ext = str(entry.get("ext") or entry.get("container") or "").lower()
                is_audio = "audio" in entry_type or audio_like_ext(ext)
                groups.append((is_audio, urls))
            video_group = next((urls for is_audio, urls in groups if not is_audio), None)
            audio_group = next((urls for is_audio, urls in groups if is_audio), None)
            if video_group and audio_group:
                return video_group, audio_group
        flat_urls = stream_urls(raw_value)
        midpoint = len(flat_urls) // 2
        if len(flat_urls) >= 2 and midpoint > 0 and len(flat_urls) % 2 == 0:
            return flat_urls[:midpoint], flat_urls[midpoint:]
    urls = stream_urls(raw_value)
    return urls, None


def enrich_metadata_with_ytdlp(target_url: str, cookie_file: Path | None, info: dict[str, Any]) -> dict[str, Any]:
    if yt_dlp is None:
        return info
    needs_metadata = not any(info.get(key) for key in ("thumbnail", "description", "uploader", "duration"))
    if not needs_metadata:
        return info
    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "extract_flat": False,
    }
    converted_cookie_file: Path | None = None
    if cookie_file is not None:
        cookie_for_ytdlp = cookie_file
        if cookie_file.suffix.lower() == ".sqlite":
            converted_cookie_file = convert_firefox_cookie_db(cookie_file)
            cookie_for_ytdlp = converted_cookie_file
        options["cookiefile"] = str(cookie_for_ytdlp)
    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            metadata = downloader.extract_info(target_url, download=False)
    except Exception:
        return info
    finally:
        if converted_cookie_file is not None:
            converted_cookie_file.unlink(missing_ok=True)
    merged = dict(metadata)
    merged.update(info)
    for key in ("thumbnail", "description", "uploader", "duration", "channel"):
        if not merged.get(key) and metadata.get(key):
            merged[key] = metadata.get(key)
    if not merged.get("thumbnail") and metadata.get("thumbnails"):
        merged["thumbnail"] = normalize_thumbnail(metadata.get("thumbnails"))
    return merged


def compact_format(item: dict[str, Any]) -> dict[str, Any]:
    ext = item.get("ext") or "unknown"
    width_hint, height_hint = parse_resolution_text(item.get("format_note") or item.get("quality") or item.get("resolution"))
    height = item.get("height") or height_hint
    width = item.get("width") or width_hint
    acodec = item.get("acodec") or "none"
    vcodec = item.get("vcodec") or "none"
    filesize = item.get("filesize") or item.get("filesize_approx")
    format_note = item.get("format_note") or item.get("resolution") or ""
    note_text = str(format_note).lower()
    abr = normalized_audio_bitrate(item)
    vbr = normalized_video_bitrate(item)
    if acodec == "none":
        abr = None
    if vcodec == "none":
        vbr = None
    codec_audio_confirmed = acodec not in {"none", "unknown"}
    codec_video_confirmed = vcodec not in {"none", "unknown"}
    has_audio = acodec != "none" or abr is not None or "audio" in note_text
    has_video = vcodec != "none" or height is not None or width is not None
    if vcodec == "none" or "audio only" in note_text:
        has_video = False
    if acodec == "none" and "video only" in note_text:
        has_audio = False
    audio_confirmed = has_audio and (codec_audio_confirmed or abr is not None)
    video_confirmed = has_video and (codec_video_confirmed or height is not None or width is not None)
    declared_format_type = item.get("format_type")
    if declared_format_type == "audio":
        has_audio = True
        has_video = False
        audio_confirmed = True
        video_confirmed = False
    elif declared_format_type == "video":
        has_audio = False
        has_video = True
        audio_confirmed = False
        video_confirmed = True
    elif declared_format_type == "combined":
        has_audio = True
        has_video = True
        audio_confirmed = True
        video_confirmed = True
    if has_video and vcodec == "unknown":
        vcodec = infer_video_codec(item)
    if has_audio and acodec == "unknown":
        acodec = infer_audio_codec(item)
    if declared_format_type == "audio" and looks_like_resolution_text(item.get("format_note") or item.get("quality")):
        abr = None
        vbr = None
    if declared_format_type == "video" and looks_like_resolution_text(item.get("format_note") or item.get("quality")):
        vbr = None
    format_confidence = "confirmed"
    if (has_audio and not audio_confirmed) or (has_video and not video_confirmed):
        format_confidence = "uncertain"
    format_type = "combined"
    if has_video and not has_audio:
        format_type = "video"
    elif has_audio and not has_video:
        format_type = "audio"
    label_parts = [item.get("format_id") or "default"]
    if format_type != "audio" and height:
        label_parts.append(f"{height}p")
    if format_type == "audio":
        bitrate_text = format_bitrate_text(abr)
        if bitrate_text:
            label_parts.append(bitrate_text)
    elif format_note:
        label_parts.append(str(format_note))
    label_parts.append(ext.upper())

    return {
        "formatId": item.get("format_id"),
        "label": " · ".join(label_parts),
        "ext": ext,
        "height": height,
        "width": width,
        "fps": item.get("fps"),
        "filesize": filesize,
        "filesizeText": item.get("filesize_text"),
        "abr": abr,
        "vbr": vbr,
        "audioCodec": acodec,
        "videoCodec": vcodec,
        "protocol": item.get("protocol"),
        "hasAudio": has_audio,
        "hasVideo": has_video,
        "audioConfirmed": audio_confirmed,
        "videoConfirmed": video_confirmed,
        "formatConfidence": format_confidence,
        "formatType": format_type,
        "directUrl": first_url(item.get("url")),
        "directUrls": url_list(item.get("url")),
        "httpHeaders": item.get("http_headers") or {},
    }


def first_url(value: Any) -> str | None:
    urls = url_list(value)
    return urls[0] if urls else None


def url_list(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def browser_safe_url(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    if value.startswith("http://"):
        return "https://" + value[len("http://"):]
    return value


def youtube_result_url(entry: dict[str, Any]) -> str | None:
    candidate = entry.get("webpage_url") or entry.get("original_url") or entry.get("url")
    if isinstance(candidate, str) and candidate.startswith(("http://", "https://")):
        return browser_safe_url(candidate)
    video_id = entry.get("id")
    if isinstance(video_id, str) and video_id:
        return f"https://www.youtube.com/watch?v={video_id}"
    return None


def normalize_search_results(entries: list[dict[str, Any]], engine: str) -> list[dict[str, Any]]:
    results = []
    for entry in entries:
        webpage_url = youtube_result_url(entry)
        if not webpage_url:
            continue
        thumbnail = None
        thumbnails = entry.get("thumbnails") or []
        if thumbnails and isinstance(thumbnails, list):
            thumbnail = browser_safe_url((thumbnails[-1] or {}).get("url"))
        results.append({
            "id": entry.get("id") or secrets.token_urlsafe(6),
            "title": entry.get("title") or "未命名结果",
            "source": entry.get("extractor_key") or "YouTube",
            "duration": entry.get("duration"),
            "durationText": duration_text(entry.get("duration")),
            "thumbnail": thumbnail,
            "webpageUrl": webpage_url,
            "uploader": entry.get("uploader") or entry.get("channel") or "--",
            "engine": engine,
        })
    return results


def pick_formats(info: dict[str, Any]) -> list[dict[str, Any]]:
    formats = info.get("formats") or []
    visible = []
    for item in formats:
        if not first_url(item.get("url")):
            continue
        compact = compact_format(item)
        if not compact["formatId"]:
            continue
        visible.append(compact)

    audio_only = [item for item in visible if item["hasAudio"] and not item["hasVideo"]]
    visible.sort(
        key=lambda item: (
            1 if item.get("formatConfidence") == "confirmed" else 0,
            1 if item["hasVideo"] and item["hasAudio"] else 0,
            item.get("height") or 0,
            item.get("filesize") or 0,
        ),
        reverse=True,
    )
    selected = visible[:MAX_FORMATS]
    existing_ids = {item["formatId"] for item in selected}
    for item in audio_only:
        if item["formatId"] not in existing_ids:
            selected.append(item)
            existing_ids.add(item["formatId"])
    return selected[:MAX_FORMATS + len(audio_only)]


def stream_urls(value: Any) -> list[str]:
    if isinstance(value, tuple):
        value = list(value)
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        urls: list[str] = []
        for item in value:
            urls.extend(stream_urls(item))
        return urls
    if isinstance(value, dict):
        candidate = value.get("url") or value.get("src")
        if isinstance(candidate, str) and candidate:
            return [candidate]
        nested = value.get("urls") or value.get("sources") or value.get("segments") or value.get("parts")
        if nested is not None:
            return stream_urls(nested)
    return []


def you_get_format_type(format_id: str, stream: dict[str, Any]) -> tuple[bool, bool, str]:
    note = str(stream.get("quality") or format_id).lower()
    container = str(stream.get("container") or "").lower()
    source = stream.get("src")
    if isinstance(source, list) and len(source) >= 2 and all(isinstance(item, list) for item in source[:2]):
        return True, True, "combined"
    if "audio" in note or container in {"mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"}:
        return True, False, "audio"
    return True, True, "combined"


def lux_payload_root(payload: Any) -> dict[str, Any]:
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, dict):
                return item
        return {}
    return payload if isinstance(payload, dict) else {}


def iter_stream_entries(streams: Any) -> list[tuple[str, dict[str, Any]]]:
    if isinstance(streams, dict):
        return [(str(format_id), stream) for format_id, stream in streams.items() if isinstance(stream, dict)]
    if isinstance(streams, list):
        result: list[tuple[str, dict[str, Any]]] = []
        for index, stream in enumerate(streams):
            if not isinstance(stream, dict):
                continue
            format_id = stream.get("id") or stream.get("itag") or stream.get("quality") or f"stream-{index + 1}"
            result.append((str(format_id), stream))
        return result
    return []


def normalize_subtitles(info: dict[str, Any], key: str) -> dict[str, list[dict[str, Any]]]:
    result: dict[str, list[dict[str, Any]]] = {}
    for language, entries in (info.get(key) or {}).items():
        normalized_entries = []
        for entry in entries or []:
            if entry.get("url"):
                normalized_entries.append({
                    "ext": entry.get("ext") or "unknown",
                    "url": entry.get("url"),
                    "name": entry.get("name") or language,
                })
        if normalized_entries:
            result[language] = normalized_entries
    return result


def normalize_info(info: dict[str, Any], extractor: str) -> dict[str, Any]:
    parse_id = secrets.token_urlsafe(12)
    title = info.get("title") or "untitled"
    normalized = {
        "parseId": parse_id,
        "extractor": extractor,
        "id": info.get("id"),
        "title": title,
        "webpageUrl": info.get("webpage_url") or info.get("original_url"),
        "uploader": info.get("uploader") or info.get("channel") or "--",
        "duration": info.get("duration"),
        "durationText": duration_text(info.get("duration")),
        "description": info.get("description") or "",
        "thumbnail": browser_safe_url(info.get("thumbnail")),
        "formats": pick_formats(info),
        "subtitles": normalize_subtitles(info, "subtitles"),
        "automaticCaptions": normalize_subtitles(info, "automatic_captions"),
        "httpHeaders": info.get("http_headers") or {},
        "createdAt": now(),
    }
    parsed_cache[parse_id] = normalized
    return normalized


def ensure_command_available(command: str, display_name: str) -> None:
    if shutil.which(command) is None:
        raise RuntimeError(f"{display_name} 未安装，请先安装对应依赖。")


def extract_with_ytdlp(target_url: str, cookie_file: Path | None = None) -> dict[str, Any]:
    if yt_dlp is None:
        raise RuntimeError("yt-dlp 未安装，请先安装 Python 依赖。")

    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "extract_flat": False,
    }
    if cookie_file is not None:
        options["cookiefile"] = str(cookie_file)
    with yt_dlp.YoutubeDL(options) as downloader:
        return downloader.extract_info(target_url, download=False)


def extract_with_you_get(target_url: str, cookie_file: Path | None = None) -> dict[str, Any]:
    ensure_command_available("you-get", "you-get")
    command = ["you-get", "--json"]
    if cookie_file is not None:
        command.extend(["--cookies", str(cookie_file)])
    command.append(target_url)

    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "you-get 解析失败。")
    payload = json.loads(completed.stdout)
    streams = payload.get("streams") or payload.get("dash_streams") or payload.get("data") or payload.get("videos") or []
    formats = []
    for format_id, stream in iter_stream_entries(streams):
        raw_sources = stream.get("src") or stream.get("url")
        urls = stream_urls(raw_sources)
        if not urls:
            continue
        has_audio, has_video, format_type = you_get_format_type(format_id, stream)
        quality_note = stream.get("quality") or format_id
        quality_details = parse_stream_quality_details(quality_note)
        if format_type == "combined":
            video_urls, audio_urls = split_mux_sources(raw_sources)
            if audio_urls:
                formats.append({
                    "format_id": f"{format_id}-video",
                    "format_note": f"{quality_note} video",
                    "ext": stream.get("container") or "mp4",
                    "url": video_urls,
                    "filesize": stream.get("size"),
                    "acodec": "none",
                    "vcodec": quality_details["videoCodec"],
                    "height": quality_details["height"],
                    "width": quality_details["width"],
                    "protocol": "https",
                    "format_type": "video",
                })
                formats.append({
                    "format_id": f"{format_id}-audio",
                    "format_note": f"{quality_note} audio",
                    "ext": "m4a" if (stream.get("container") or "").lower() == "mp4" else "webm",
                    "url": audio_urls,
                    "filesize": stream.get("size"),
                    "audio_bitrate": stream.get("audio_bitrate") or stream.get("abr") or stream.get("bitrate"),
                    "acodec": quality_details["audioCodec"],
                    "vcodec": "none",
                    "height": None,
                    "width": None,
                    "protocol": "https",
                    "format_type": "audio",
                })
                continue
        formats.append({
            "format_id": format_id,
            "format_note": quality_note,
            "ext": stream.get("container") or "mp4",
            "url": urls,
            "filesize": stream.get("size"),
            "audio_bitrate": stream.get("audio_bitrate") or stream.get("abr") or stream.get("bitrate"),
            "acodec": quality_details["audioCodec"] if has_audio else "none",
            "vcodec": quality_details["videoCodec"] if has_video else "none",
            "height": quality_details["height"] if has_video else None,
            "width": quality_details["width"] if has_video else None,
            "protocol": "https",
            "format_type": format_type,
        })
    info = {
        "id": payload.get("vid"),
        "title": payload.get("title"),
        "webpage_url": target_url,
        "thumbnail": normalize_thumbnail(payload.get("thumbnail")),
        "description": payload.get("description") or payload.get("desc") or "",
        "formats": formats,
    }
    return enrich_metadata_with_ytdlp(target_url, cookie_file, info)


def extract_with_lux(target_url: str, cookie_file: Path | None = None) -> dict[str, Any]:
    ensure_command_available("lux", "lux")
    command = ["lux", "-j"]
    if cookie_file is not None:
        command.extend(["-c", str(cookie_file)])
    command.append(target_url)

    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "lux 解析失败。")

    payload = lux_payload_root(json.loads(completed.stdout))
    streams = payload.get("streams") or payload.get("data") or payload.get("videos") or []
    formats = []
    for format_id, stream in iter_stream_entries(streams):
        urls = stream.get("urls") or stream.get("parts") or stream.get("src") or stream.get("url") or []
        normalized_urls = stream_urls(urls)
        if not normalized_urls:
            continue
        first_item = urls[0] if isinstance(urls, list) and urls and isinstance(urls[0], dict) else {}
        ext = first_item.get("ext") or stream.get("container") or "mp4"
        need_mux = bool(stream.get("need_mux") or stream.get("NeedMux"))
        stream_kind = str(stream.get("type") or "").lower()
        has_audio = stream_kind == "audio"
        has_video = stream_kind != "audio"
        if need_mux and isinstance(urls, list) and len(normalized_urls) >= 2:
            video_url, audio_url = split_mux_sources(urls)
            formats.append({
                "format_id": f"{format_id}-video",
                "format_note": f"{stream.get('quality') or format_id} video",
                "ext": ext,
                "url": video_url,
                "filesize": stream.get("size") or first_item.get("size"),
                "acodec": "none",
                "vcodec": "unknown",
                "protocol": "https",
                "format_type": "video",
            })
            if audio_url:
                formats.append({
                    "format_id": f"{format_id}-audio",
                    "format_note": f"{stream.get('quality') or format_id} audio",
                    "ext": ext if ext in {"m4a", "webm", "mp3", "ogg"} else "m4a",
                    "url": audio_url,
                    "filesize": stream.get("size") or first_item.get("size"),
                    "acodec": "unknown",
                    "vcodec": "none",
                    "protocol": "https",
                    "format_type": "audio",
                })
            continue
        formats.append({
            "format_id": format_id,
            "format_note": stream.get("quality") or format_id,
            "ext": ext,
            "url": normalized_urls,
            "filesize": stream.get("size") or first_item.get("size"),
            "acodec": "unknown" if has_audio else "none",
            "vcodec": "unknown" if has_video else "none",
            "protocol": "https",
            "format_type": "audio" if has_audio and not has_video else "combined",
        })
    info = {
        "id": payload.get("id") or payload.get("vid"),
        "title": payload.get("title"),
        "webpage_url": target_url,
        "thumbnail": normalize_thumbnail(payload.get("thumbnail") or payload.get("cover") or payload.get("image")),
        "description": payload.get("description") or payload.get("desc") or payload.get("intro") or "",
        "formats": formats,
    }
    return enrich_metadata_with_ytdlp(target_url, cookie_file, info)


def search_with_ytdlp(keyword: str, limit: int) -> list[dict[str, Any]]:
    if yt_dlp is None:
        raise RuntimeError("yt-dlp 未安装，请先安装 Python 依赖。")

    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": True,
        "playlistend": limit,
    }
    with yt_dlp.YoutubeDL(options) as downloader:
        result = downloader.extract_info(f"ytsearch{limit}:{keyword}", download=False)
    entries = result.get("entries") or []
    return normalize_search_results(entries, "yt-dlp")


def classify_parse_failure(engine: str, target_url: str, error: Exception, cookie_file: Path | None) -> str:
    details = f"{engine}: {sanitized_error(error, cookie_file)}"
    lower_details = details.lower()
    cookie_hint = cookie_session_hint(engine)

    if "http error 412" in lower_details or "http 412" in lower_details or "precondition failed" in lower_details:
        if is_bilibili_url(target_url) or "bilibili" in lower_details:
            return (
                "解析失败：目标视频网站当前拒绝了本次解析请求（HTTP 412 Precondition Failed）。"
                "这通常表示触发了站点风控或需要有效登录态。"
                f"{cookie_hint}"
            )
        return (
            "解析失败：源站拒绝了当前解析请求（HTTP 412 Precondition Failed）。"
            "这通常表示该链接需要有效 cookie、源站页面上下文或平台校验。"
            f"{cookie_hint}"
        )
    if "login" in lower_details or "sign in" in lower_details or "需要登录" in details:
        return f"解析失败：该链接需要有效登录 Cookie 或授权访问。{cookie_hint}"
    if "copyright" in lower_details or "private" in lower_details or "forbidden" in lower_details:
        return "解析失败：该视频不可公开访问或受到源站限制。"
    if "unsupported url" in lower_details or "unsupported" in lower_details:
        return f"解析失败：当前链接暂不受 {engine} 支持。"
    if "timed out" in lower_details or "timeout" in lower_details:
        return "解析失败：连接源站超时，请稍后重试。"
    if engine == "you-get" and is_bilibili_url(target_url) and ("oops, something went wrong" in lower_details or "don't panic" in lower_details):
        return (
            "解析失败：目标视频网站当前拒绝了本次解析请求，you-get 未返回可用页面数据。"
            f"{cookie_hint}"
        )
    if engine == "you-get" and ("oops, something went wrong" in lower_details or "don't panic" in lower_details):
        return "解析失败：you-get 当前未能成功解析该链接。建议切换到 yt-dlp 或 lux 后重试。"

    return f"解析失败：{details}"


def create_stream_token(
    url: str | list[str],
    headers: dict[str, str] | None,
    filename: str,
    content_type: str | None = None,
    mode: str = "http",
    format_id: str | None = None,
    referer_url: str | None = None,
) -> str:
    token = secrets.token_urlsafe(24)
    stream_tokens[token] = {
        "urls": url_list(url),
        "headers": headers or {},
        "filename": filename,
        "contentType": content_type or "application/octet-stream",
        "mode": mode,
        "formatId": format_id,
        "refererUrl": referer_url,
        "createdAt": now(),
    }
    return token


def get_cached_parse(parse_id: str) -> dict[str, Any]:
    cleanup_expired()
    entry = parsed_cache.get(parse_id)
    if not entry:
        raise HTTPException(status_code=404, detail="解析结果已过期，请重新解析。")
    return entry


def find_format(entry: dict[str, Any], format_id: str | None) -> dict[str, Any]:
    formats = entry.get("formats") or []
    if not formats:
        raise HTTPException(status_code=404, detail="没有可下载格式。")
    if not format_id:
        return formats[0]
    for item in formats:
        if item.get("formatId") == format_id:
            return item
    raise HTTPException(status_code=404, detail="指定格式不存在或已过期。")


def public_parse_response(normalized: dict[str, Any]) -> dict[str, Any]:
    response = {key: value for key, value in normalized.items() if key not in {"httpHeaders", "createdAt"}}
    response["formats"] = [
        {key: value for key, value in item.items() if key not in {"httpHeaders", "directUrls"}}
        for item in normalized.get("formats") or []
    ]
    return response


def merged_headers(*groups: dict[str, Any] | None) -> dict[str, str]:
    headers: dict[str, str] = {}
    for group in groups:
        for key, value in (group or {}).items():
            if isinstance(key, str) and isinstance(value, str):
                headers[key] = value
    return headers


def set_header_default(headers: dict[str, str], name: str, value: str | None) -> None:
    if not value:
        return
    lower_name = name.lower()
    if any(existing.lower() == lower_name for existing in headers):
        return
    headers[name] = value


def stream_request_headers(entry: dict[str, Any], request: Request) -> dict[str, str]:
    headers = {key: value for key, value in entry["headers"].items() if isinstance(value, str)}
    set_header_default(headers, "User-Agent", DEFAULT_USER_AGENT)
    set_header_default(headers, "Accept", "*/*")
    set_header_default(headers, "Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
    set_header_default(headers, "Referer", entry.get("refererUrl"))
    for header in ("range", "if-range"):
        value = request.headers.get(header)
        if value:
            headers[header] = value
    return headers


def content_disposition(filename: str) -> str:
    ascii_name = re.sub(r'[^A-Za-z0-9._-]+', '-', filename).strip('-') or 'download'
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


@app.get("/api/health")
async def health() -> dict[str, Any]:
    cookie_status = session_cookie_status()
    return {
        "ok": True,
        "message": "MediaSeek 服务已就绪",
        "defaultEngine": DEFAULT_ENGINE,
        "ytDlpAvailable": yt_dlp is not None,
        "youGetAvailable": shutil.which("you-get") is not None,
        "luxAvailable": shutil.which("lux") is not None,
        "cookieSessionActive": cookie_status["active"],
        "cookieSessionUpdatedAt": cookie_status["updatedAt"],
    }


@app.get("/api/cookie/status")
async def cookie_status() -> dict[str, Any]:
    status = session_cookie_status()
    return {"ok": True, **status}


@app.post("/api/cookie/load")
async def load_cookie_session(request: Request) -> dict[str, Any]:
    content_type = request.headers.get("content-type", "")
    if not content_type.startswith("multipart/form-data"):
        raise HTTPException(status_code=400, detail="请使用表单上传 Cookie 文件。")

    form = await request.form()
    engine = validate_engine(str(form.get("engine") or DEFAULT_ENGINE))
    uploaded_cookie = await save_cookie_upload(form.get("cookieFile"))
    if uploaded_cookie is None:
        raise HTTPException(status_code=400, detail="请选择要加载的 Cookie 文件。")

    try:
        validate_cookie_for_engine(uploaded_cookie, engine)
        set_session_cookie(uploaded_cookie, getattr(form.get("cookieFile"), "filename", uploaded_cookie.name))
    except Exception:
        uploaded_cookie.unlink(missing_ok=True)
        raise

    status = session_cookie_status()
    return {
        "ok": True,
        "message": "Cookie 会话已加载，后续解析会自动复用该 Cookie。",
        **status,
    }


@app.post("/api/cookie/clear")
async def clear_cookie_session() -> dict[str, Any]:
    set_session_cookie(None)
    return {
        "ok": True,
        "message": "Cookie 会话已清除。",
        **session_cookie_status(),
    }


@app.post("/api/parse")
async def parse_video(request: Request) -> dict[str, Any]:
    cleanup_expired()
    uploaded_cookie_file: Path | None = None
    parser_cookie_file: Path | None = None
    engine = DEFAULT_ENGINE

    try:
        target_url, engine, uploaded_cookie_file = await read_parse_input(request)
        target_url = validate_public_url(target_url)
        parser_cookie_file = prepare_cookie_for_engine(active_session_cookie(), engine)
        if uploaded_cookie_file is not None:
            parser_cookie_file = prepare_cookie_for_engine(uploaded_cookie_file, engine)
        try:
            if engine == "yt-dlp":
                info = await asyncio.to_thread(extract_with_ytdlp, target_url, parser_cookie_file)
            elif engine == "lux":
                info = await asyncio.to_thread(extract_with_lux, target_url, parser_cookie_file)
            else:
                info = await asyncio.to_thread(extract_with_you_get, target_url, parser_cookie_file)
            normalized = normalize_info(info, engine)
        except Exception as error:
            raise HTTPException(
                status_code=422,
                detail=classify_parse_failure(engine, target_url, error, parser_cookie_file or uploaded_cookie_file),
            ) from error
    finally:
        if parser_cookie_file is not None and parser_cookie_file != uploaded_cookie_file and parser_cookie_file != active_session_cookie():
            parser_cookie_file.unlink(missing_ok=True)
        if uploaded_cookie_file is not None:
            uploaded_cookie_file.unlink(missing_ok=True)

    return {"ok": True, "result": public_parse_response(normalized)}


@app.post("/api/search")
async def search_video(request: SearchRequest) -> dict[str, Any]:
    keyword = validate_search_keyword(request.keyword)
    limit = validate_search_limit(request.limit)

    try:
        results = await asyncio.to_thread(search_with_bilibili, keyword, limit)
    except Exception as error:
        raise HTTPException(status_code=422, detail=f"搜索失败：{sanitized_error(error, None)}") from error

    for item in results:
        thumbnail = item.get("thumbnail")
        if not thumbnail:
            continue
        filename = safe_filename(item.get("title") or item.get("id") or "search-result") + "-cover.jpg"
        token = create_stream_token(
            thumbnail,
            {"Referer": item.get("webpageUrl") or "https://www.bilibili.com/"},
            filename,
            "image/jpeg",
            referer_url=item.get("webpageUrl") or "https://www.bilibili.com/",
        )
        item["thumbnailProxyUrl"] = f"/api/stream/{token}"

    return {
        "ok": True,
        "results": results,
        "engine": "site-search",
        "keyword": keyword,
        "count": len(results),
    }


@app.post("/api/download-url")
async def download_url(request: DownloadRequest) -> dict[str, Any]:
    entry = get_cached_parse(request.parseId)
    title = safe_filename(entry.get("title") or "download")
    headers = entry.get("httpHeaders") or {}

    if request.asset in {"video", "audio"}:
        selected = find_format(entry, request.formatId)
        direct_url = selected.get("directUrl")
        if not direct_url:
            raise HTTPException(status_code=404, detail="该格式没有可用下载地址。")
        ext = selected.get("ext") or "mp4"
        filename = f"{title}-{selected.get('formatId')}.{ext}"
        token = create_stream_token(
            selected.get("directUrls") or direct_url,
            merged_headers(headers, selected.get("httpHeaders")),
            filename,
            mode="http",
            format_id=selected.get("formatId"),
            referer_url=entry.get("webpageUrl"),
        )
        return {
            "ok": True,
            "mode": "direct-or-proxy",
            "directUrl": direct_url,
            "proxyUrl": f"/api/stream/{token}",
            "filename": filename,
        }

    if request.asset == "thumbnail":
        thumbnail = entry.get("thumbnail")
        if not thumbnail:
            raise HTTPException(status_code=404, detail="没有可用封面。")
        token = create_stream_token(thumbnail, headers, f"{title}-cover.jpg", "image/jpeg", referer_url=entry.get("webpageUrl"))
        return {"ok": True, "directUrl": thumbnail, "proxyUrl": f"/api/stream/{token}", "filename": f"{title}-cover.jpg"}

    if request.asset == "subtitle":
        group_key = "automaticCaptions" if request.subtitleKind == "automatic" else "subtitles"
        groups = entry.get(group_key) or {}
        language = request.language or next(iter(groups), None)
        if not language or language not in groups:
            raise HTTPException(status_code=404, detail="没有找到指定字幕。")
        subtitle = groups[language][0]
        ext = subtitle.get("ext") or "vtt"
        filename = f"{title}-{language}.{ext}"
        token = create_stream_token(subtitle["url"], headers, filename, "text/vtt", referer_url=entry.get("webpageUrl"))
        return {"ok": True, "directUrl": subtitle["url"], "proxyUrl": f"/api/stream/{token}", "filename": filename}

    if request.asset == "description":
        filename = f"{title}-description.txt"
        return {"ok": True, "filename": filename, "content": entry.get("description") or ""}

    raise HTTPException(status_code=400, detail="未知下载类型。")


@app.get("/api/stream/{token}")
async def stream_asset(token: str, request: Request) -> StreamingResponse:
    cleanup_expired()
    entry = stream_tokens.get(token)
    if not entry:
        raise HTTPException(status_code=404, detail="下载链接已过期，请重新生成。")
    entry["createdAt"] = now()

    async def http_response() -> StreamingResponse:
        request_headers = stream_request_headers(entry, request)

        client = httpx.AsyncClient(timeout=None, follow_redirects=True)
        response = None
        last_status = 502
        for candidate_url in entry.get("urls") or []:
            upstream_request = client.build_request("GET", candidate_url, headers=request_headers)
            response = await client.send(upstream_request, stream=True)
            if response.status_code < 400:
                break
            last_status = response.status_code
            await response.aclose()
            response = None
        if response is None:
            await client.aclose()
            raise HTTPException(status_code=last_status, detail="源站拒绝下载请求，请重新解析后再试。")

        passthrough_headers = {
            "Content-Disposition": content_disposition(entry["filename"]),
            "Accept-Ranges": response.headers.get("accept-ranges", "bytes"),
        }
        for source, target in (
            ("content-length", "Content-Length"),
            ("content-range", "Content-Range"),
            ("content-type", "Content-Type"),
            ("etag", "ETag"),
            ("last-modified", "Last-Modified"),
        ):
            value = response.headers.get(source)
            if value:
                passthrough_headers[target] = value

        async def close_upstream() -> None:
            await response.aclose()
            await client.aclose()

        return StreamingResponse(
            response.aiter_bytes(1024 * 256),
            status_code=response.status_code,
            media_type=response.headers.get("content-type") or entry["contentType"],
            headers=passthrough_headers,
            background=BackgroundTask(close_upstream),
        )

    async def ytdlp_iterator():
        command = [
            "yt-dlp",
            "--quiet",
            "--no-warnings",
            "--no-playlist",
            "-f",
            entry.get("formatId") or "best",
            "-o",
            "-",
            (entry.get("urls") or [""])[0],
        ]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            assert process.stdout is not None
            while True:
                chunk = await asyncio.to_thread(process.stdout.read, 1024 * 256)
                if not chunk:
                    break
                yield chunk
        finally:
            if process.poll() is None:
                process.terminate()
                await asyncio.to_thread(process.wait)

    if entry.get("mode") != "ytdlp":
        return await http_response()

    headers = {"Content-Disposition": content_disposition(entry["filename"])}
    return StreamingResponse(ytdlp_iterator(), media_type=entry["contentType"], headers=headers)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(APP_DIR / "index.html")


@app.get("/styles.css")
async def styles() -> FileResponse:
    return FileResponse(APP_DIR / "styles.css")


@app.get("/favicon.ico")
async def favicon() -> Response:
    return Response(status_code=204)


@app.get("/ffmpeg/class-worker.js")
async def ffmpeg_class_worker() -> Response:
    global ffmpeg_worker_cache
    if ffmpeg_worker_cache is None:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
            response = await client.get(f"{FFMPEG_PACKAGE_BASE}/worker.js")
            response.raise_for_status()
        ffmpeg_worker_cache = response.text.replace(
            'from "./const.js"',
            f'from "{FFMPEG_PACKAGE_BASE}/const.js"',
        ).replace(
            'from "./errors.js"',
            f'from "{FFMPEG_PACKAGE_BASE}/errors.js"',
        )
    return Response(ffmpeg_worker_cache, media_type="text/javascript")


app.mount("/src", StaticFiles(directory=APP_DIR / "src"), name="src")
app.mount("/static", StaticFiles(directory=APP_DIR), name="static")


@app.exception_handler(HTTPException)
async def http_error_handler(_, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"ok": False, "message": exc.detail})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
