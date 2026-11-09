"""Math GP on a normal Windows PC, no OBS: an invisible (headless) Chrome draws the game on the GPU, its frames are
captured over the DevTools protocol and pushed to YouTube with ffmpeg, and YouTube live chat is fed in with
chat-downloader. Nothing opens on screen, so the PC stays usable; it only must not go to sleep.

    python stream/pc.py              # asks for the stream key once, stores it in stream/key.txt (git-ignored)

Options (env): MGP_CHANNEL (default https://www.youtube.com/@nukieer/live), MGP_OUT=720 or 1080 (stream height
1280 or 1920), MGP_FPS (30), MGP_QUERY (extra game params, e.g. latency=4).
"""
import base64
import functools
import http.server
import json
import os
import queue
import random
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import websocket  # websocket-client

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
BOARD = ROOT / "data" / "leaderboard.json"
KEYFILE = Path(__file__).with_name("key.txt")
PORT, DEBUG_PORT = 8765, 9333
FPS = int(os.environ.get("MGP_FPS") or 30)
OUT_H = 1920 if os.environ.get("MGP_OUT") == "1080" else 1280
OUT_W = OUT_H * 9 // 16
CHANNEL = os.environ.get("MGP_CHANNEL") or "https://www.youtube.com/@nukieer/live"


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def find_chrome():
    for p in [
        os.environ.get("MGP_CHROME"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ]:
        if p and Path(p).exists():
            return p
    sys.exit("Chrome bulunamadı (MGP_CHROME ile yolunu verebilirsin)")


def serve_web():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    handler = functools.partial(Quiet, directory=str(WEB))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


class Page:
    """Minimal DevTools client: evaluate JS and receive screencast frames."""

    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, max_size=None, suppress_origin=True)
        self.lock = threading.Lock()
        self.next_id = 0
        self.results = {}
        self.frame = None
        self.frames = 0
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("method") == "Page.screencastFrame":
                p = msg["params"]
                self.frame = base64.b64decode(p["data"])
                self.frames += 1
                self.send("Page.screencastFrameAck", {"sessionId": p["sessionId"]}, wait=False)
            elif "id" in msg:
                self.results[msg["id"]] = msg

    def send(self, method, params=None, wait=True):
        with self.lock:
            self.next_id += 1
            i = self.next_id
            self.ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
        if not wait:
            return None
        for _ in range(300):
            if i in self.results:
                return self.results.pop(i).get("result")
            time.sleep(0.02)
        return None

    def eval(self, js):
        r = self.send("Runtime.evaluate", {"expression": js, "returnByValue": True, "awaitPromise": True})
        return (r or {}).get("result", {}).get("value")


def start_chrome():
    chrome = find_chrome()
    profile = ROOT / ".chrome-profile"
    args = [chrome, "--headless=new", f"--remote-debugging-port={DEBUG_PORT}", f"--user-data-dir={profile}", "--window-size=720,1280",
            "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--ignore-gpu-blocklist", "--enable-gpu-rasterization",
            "about:blank"]
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(100):
        try:
            targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json"))
            page = next(t for t in targets if t["type"] == "page")
            return proc, Page(page["webSocketDebuggerUrl"])
        except Exception:
            time.sleep(0.2)
    sys.exit("Chrome açılamadı")


def chat_reader(out: queue.Queue):
    from chat_downloader import ChatDownloader

    while True:
        try:
            chat = ChatDownloader().get_chat(CHANNEL, message_types=["text_message"], inactivity_timeout=600)
            log("sohbete bağlandı:", getattr(chat, "title", CHANNEL))
            for m in chat:
                ts = m.get("timestamp")
                out.put(((m.get("author") or {}).get("name") or "someone", m.get("message") or "", ts / 1000 if ts else None))
        except Exception as e:  # not live yet, or a network blip
            log("sohbet bekleniyor:", type(e).__name__)
        time.sleep(20)


def encoder_args():
    """Prefer the graphics card's encoder; old cards or drivers fall back to the CPU."""
    test = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.2", "-c:v", "h264_nvenc", "-f", "null", "-"], capture_output=True)
    if test.returncode == 0:
        log("kodlayıcı: NVIDIA NVENC")
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "cbr", "-b:v", "4500k"]
    log("kodlayıcı: işlemci (libx264)")
    return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-b:v", "3500k", "-maxrate", "3500k", "-bufsize", "7000k"]


def start_ffmpeg(key, enc):
    tracks = sorted((WEB / "assets" / "music").glob("*.mp3"))
    random.shuffle(tracks)
    lst = ROOT / "music.txt"
    lst.write_text("".join(f"file '{t.as_posix()}'\n" for _ in range(200) for t in tracks), encoding="utf-8")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", str(FPS), "-i", "-",
           "-f", "concat", "-safe", "0", "-i", str(lst), "-map", "0:v", "-map", "1:a",
           "-vf", f"scale={OUT_W}:{OUT_H},format=yuv420p", *enc, "-g", str(FPS * 2),
           "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-af", "volume=0.35",
           *(["-t", "25", "-y", os.environ["MGP_DRY"]] if os.environ.get("MGP_DRY") else ["-f", "flv", f"rtmp://a.rtmp.youtube.com/live2/{key}"])]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE)


def save_board(page):
    snap = page.eval("window.exportBoard ? window.exportBoard() : null")
    if snap:
        BOARD.parent.mkdir(exist_ok=True)
        BOARD.write_text(json.dumps(snap, ensure_ascii=False, indent=1), encoding="utf-8")


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles default to cp1252
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg bulunamadı")
    key = os.environ.get("MGP_KEY") or (KEYFILE.read_text().strip() if KEYFILE.exists() else "")
    if not key:
        key = input("YouTube stream key: ").strip()
        KEYFILE.write_text(key)
    serve_web()
    chrome, page = start_chrome()
    page.send("Emulation.setDeviceMetricsOverride", {"width": OUT_W, "height": OUT_H, "deviceScaleFactor": 1, "mobile": False})  # the page scales itself to fit
    query = os.environ.get("MGP_QUERY") or "latency=4"
    page.send("Page.navigate", {"url": f"http://127.0.0.1:{PORT}/index.html?music=0&{query}"})
    for _ in range(300):
        if page.eval("window.gameReady === true"):
            break
        time.sleep(0.2)
    if BOARD.exists():
        page.eval(f"window.loadBoard({BOARD.read_text(encoding='utf-8')})")
    # capture at the stream size: encoding full-size JPEGs is what limits the frame rate
    page.send("Page.startScreencast", {"format": "jpeg", "quality": 72, "maxWidth": OUT_W, "maxHeight": OUT_H, "everyNthFrame": 1})

    msgs: queue.Queue = queue.Queue()
    threading.Thread(target=chat_reader, args=(msgs,), daemon=True).start()
    enc = encoder_args()
    ff = start_ffmpeg(key, enc)
    log(f"yayın başladı → YouTube ({OUT_W}x{OUT_H} @ {FPS}fps). Kapatmak için Ctrl+C")

    next_frame, next_report, next_save, fed, sent = time.time(), time.time() + 10, time.time() + 600, 0, 0
    try:
        while True:
            now = time.time()
            if ff.poll() is not None:
                if os.environ.get("MGP_DRY"):
                    break
                log("ffmpeg durdu, yeniden bağlanıyor")
                time.sleep(3)
                ff = start_ffmpeg(key, enc)
            if now >= next_frame and page.frame:
                try:
                    ff.stdin.write(page.frame)
                    sent += 1
                except (BrokenPipeError, OSError):
                    pass
                next_frame += 1 / FPS
                if next_frame < now - 1:
                    next_frame = now
            while not msgs.empty():
                u, t, ts = msgs.get()
                page.eval(f"window.chatMessage({json.dumps(u)}, {json.dumps(t)}, false, {json.dumps(ts)})")
                fed += 1
            if now >= next_report:
                next_report = now + (10 if os.environ.get("MGP_DRY") else 60)
                log(f"oyun {page.eval('window.fps')} fps | yakalanan kare {page.frames} | gönderilen {sent} | yorum {fed}")
            if now >= next_save:
                next_save = now + 600
                save_board(page)
            time.sleep(0.004)
    except KeyboardInterrupt:
        log("kapatılıyor")
    finally:
        save_board(page)
        ff.terminate()
        chrome.terminate()


if __name__ == "__main__":
    main()
