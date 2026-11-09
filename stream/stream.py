"""Math GP live: serves web/ locally, renders it in Chromium on Xvfb, pushes it to YouTube with ffmpeg,
feeds YouTube live chat into the game (with YouTube's own message timestamps) and keeps the all-time
leaderboard in data/leaderboard.json between runs.

Runs are chained for a 24/7 stream: each run hands over to the next one before GitHub's 6-hour job limit,
alternating YouTube's primary and backup ingest so the switch has no gap.

Env: LIVE_STREAM_KEY (required), LIVE_CHANNEL_URL (e.g. https://www.youtube.com/@name/live), LIVE_MINUTES,
     LIVE_INGEST=primary|backup, LIVE_CHAIN=1 to start the next run, LIVE_QUERY (extra page params), DISPLAY.
"""
import functools
import http.server
import json
import os
import queue
import random
import subprocess
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
BOARD = ROOT / "data" / "leaderboard.json"
W, H, FPS = 1080, 1920, 30
PORT = 8765
HANDOVER_MIN = 12  # the next run starts this long before this one ends


def log(*a):
    print("[live]", *a, flush=True)


def serve_web():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(WEB))
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def chat_reader(url, out: queue.Queue, stop: threading.Event):
    """YouTube live chat without API quota (chat-downloader reads the same feed the web player uses)."""
    from chat_downloader import ChatDownloader

    while not stop.is_set():
        try:
            chat = ChatDownloader().get_chat(url, message_types=["text_message"], inactivity_timeout=600)
            log("chat bağlandı:", getattr(chat, "title", url))
            for m in chat:
                if stop.is_set():
                    return
                author = (m.get("author") or {}).get("name") or "someone"
                ts = m.get("timestamp")  # microseconds since epoch, set by YouTube when the message was sent
                out.put((author, m.get("message") or "", ts / 1000 if ts else None))
        except Exception as e:  # stream not live yet, network blip, chat ended: wait and reconnect
            log("chat yeniden bağlanıyor:", type(e).__name__, str(e)[:120])
        stop.wait(20)


def music_list():
    tracks = sorted((WEB / "assets" / "music").glob("*.mp3"))
    random.shuffle(tracks)
    lst = ROOT / "music.txt"
    lst.write_text("".join(f"file '{t.as_posix()}'\n" for _ in range(80) for t in tracks), encoding="utf-8")
    return lst


def start_ffmpeg(key, ingest):
    url = f"rtmp://b.rtmp.youtube.com/live2?backup=1/{key}" if ingest == "backup" else f"rtmp://a.rtmp.youtube.com/live2/{key}"
    cmd = [
        "ffmpeg", "-loglevel", os.environ.get("LIVE_FFMPEG_LOG", "warning"), "-nostdin",
        "-f", "x11grab", "-video_size", f"{W}x{H}", "-framerate", str(FPS), "-draw_mouse", "0", "-i", os.environ.get("DISPLAY", ":99") + "+0,0",
        "-f", "concat", "-safe", "0", "-i", str(music_list()),
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
        "-b:v", "5000k", "-maxrate", "5000k", "-bufsize", "10000k", "-g", str(FPS * 2), "-keyint_min", str(FPS * 2),
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-af", "volume=0.35",
        "-f", "flv", url,
    ]
    return subprocess.Popen(cmd)


def merge_boards(old, new):
    """Overlapping runs see the same chat, so per-user values are merged with max, never summed."""
    users = dict(old.get("users", {}))
    for u, b in new.get("users", {}).items():
        a = users.get(u)
        users[u] = b if not a else {k: (max(a.get(k) or 0, b.get(k) or 0) if isinstance(b.get(k), (int, float)) else b.get(k)) for k in set(a) | set(b)}
        if a and a.get("best") is not None and b.get("best") is not None:
            users[u]["best"] = min(a["best"], b["best"])
    return {"users": users, "bans": {**old.get("bans", {}), **new.get("bans", {})}}


def save_board(page, final=False):
    try:
        snap = page.evaluate("window.exportBoard ? window.exportBoard() : null")
    except Exception as e:
        log("tablo okunamadı:", e)
        return
    if not snap:
        return
    for u in snap.get("users", {}).values():
        u.pop("fast", None) if final else None
    old = json.loads(BOARD.read_text(encoding="utf-8")) if BOARD.exists() else {}
    BOARD.parent.mkdir(exist_ok=True)
    BOARD.write_text(json.dumps(merge_boards(old, snap), ensure_ascii=False, indent=1), encoding="utf-8")
    if os.environ.get("GITHUB_ACTIONS"):
        sh = lambda *c: subprocess.run(c, cwd=ROOT, capture_output=True, text=True)
        sh("git", "config", "user.name", "math-gp-bot")
        sh("git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
        for _ in range(4):
            mine = BOARD.read_text(encoding="utf-8")
            sh("git", "fetch", "-q", "origin", "main")
            sh("git", "checkout", "-q", "origin/main", "--", "data/leaderboard.json")
            theirs = json.loads(BOARD.read_text(encoding="utf-8")) if BOARD.exists() else {}
            BOARD.write_text(json.dumps(merge_boards(theirs, json.loads(mine)), ensure_ascii=False, indent=1), encoding="utf-8")
            sh("git", "add", "data/leaderboard.json")
            if sh("git", "diff", "--cached", "--quiet").returncode == 0:
                return
            sh("git", "commit", "-qm", "leaderboard")
            if sh("git", "push", "-q", "origin", "HEAD:main").returncode == 0:
                log("tablo kaydedildi")
                return
            sh("git", "reset", "-q", "--soft", "HEAD~1")
            time.sleep(random.uniform(3, 8))


def chain_next(ingest):
    nxt = "backup" if ingest == "primary" else "primary"
    r = subprocess.run(["gh", "workflow", "run", "live.yml", "-f", f"ingest={nxt}", "-f", "chain=true"], cwd=ROOT, capture_output=True, text=True)
    log("sıradaki koşu:", nxt, r.returncode, r.stderr.strip()[:200])


def main():
    key = os.environ.get("LIVE_STREAM_KEY")
    if not key:
        sys.exit("LIVE_STREAM_KEY yok")
    minutes = float(os.environ.get("LIVE_MINUTES") or 345)
    ingest = os.environ.get("LIVE_INGEST") or "primary"
    chain = os.environ.get("LIVE_CHAIN") == "true"
    started = time.time()
    end_at = started + minutes * 60
    handover_at = end_at - HANDOVER_MIN * 60 if chain else None

    serve_web()
    msgs: queue.Queue = queue.Queue()
    stop = threading.Event()
    if os.environ.get("LIVE_CHANNEL_URL"):
        threading.Thread(target=chat_reader, args=(os.environ["LIVE_CHANNEL_URL"], msgs, stop), daemon=True).start()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=False,
            args=[f"--window-size={W},{H}", "--window-position=0,0", "--kiosk", "--hide-scrollbars", "--noerrdialogs", "--disable-infobars",
                  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
        )
        page = browser.new_page(viewport={"width": W, "height": H})
        page.on("console", lambda m: log("page:", m.text[:200]) if m.text.startswith(("[map]", "[route]", "[cheat]")) or m.type == "error" else None)
        query = os.environ.get("LIVE_QUERY") or "quality=low&music=0"
        page.goto(f"http://127.0.0.1:{PORT}/index.html?{query}")
        if BOARD.exists():
            page.evaluate("b => window.loadBoard && window.loadBoard(b)", json.loads(BOARD.read_text(encoding="utf-8")))
        page.wait_for_function("window.gameReady === true", timeout=120000)
        ff = start_ffmpeg(key, ingest)
        log(f"yayın başladı ({ingest}), {minutes:.0f} dk")

        next_save, next_fps, fed = time.time() + 600, time.time() + 60, 0
        while time.time() < end_at:
            if ff.poll() is not None:
                log(f"ffmpeg durdu ({ff.returncode}), yeniden başlatılıyor")
                time.sleep(3)
                ff = start_ffmpeg(key, ingest)
            while not msgs.empty():
                user, text, ts = msgs.get()
                try:
                    page.evaluate("([u, t, ts]) => window.chatMessage(u, t, false, ts)", [user, text, ts])
                    fed += 1
                except Exception as e:
                    log("mesaj iletilemedi:", e)
            now = time.time()
            if now >= next_fps:
                next_fps = now + 300
                log("fps:", page.evaluate("window.fps ?? 'n/a'"), "| iletilen mesaj:", fed)
            if now >= next_save:
                next_save = now + 600
                save_board(page)
            if handover_at and now >= handover_at:
                handover_at = None
                save_board(page)
                chain_next(ingest)
            time.sleep(0.2)

        stop.set()
        save_board(page, final=True)
        ff.terminate()
        try:
            ff.wait(10)
        except subprocess.TimeoutExpired:
            ff.kill()
        browser.close()
        log("koşu bitti")


if __name__ == "__main__":
    main()
