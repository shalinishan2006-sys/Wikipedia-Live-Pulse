import asyncio
import json
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

STREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange"

# Wikimedia asks every program to say who it is.
HEADERS = {
    "User-Agent": "WikipediaLivePulse/0.1 (https://github.com/shalinishan2006-sys; student portfolio project)",
    "Accept": "text/event-stream",
}

# The database file sits next to main.py
DB_PATH = Path(__file__).parent / "pulse.db"
FLUSH_SECONDS = 10  # how often counts are saved to the database

# What the server knows right now
state = {
    "connected": False,
    "total_edits": 0,
    "last_server": None,
    "last_title": None,
}

# Counts waiting to be saved: { minute_start_time: [total_edits, bot_edits] }
pending = {}


# ---------- Database ----------
def init_db():
    # Creates the file and the table if they do not exist yet
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS minute_counts (
            minute INTEGER PRIMARY KEY,   -- start of the minute (unix seconds)
            total  INTEGER NOT NULL,      -- all edits in that minute
            bots   INTEGER NOT NULL       -- edits made by bots
        )
        """
    )
    conn.commit()
    conn.close()


def record_edit(is_bot):
    # Add one edit to the current minute (in memory only)
    minute = int(time.time()) // 60 * 60
    entry = pending.setdefault(minute, [0, 0])
    entry[0] += 1
    if is_bot:
        entry[1] += 1


def flush_pending():
    # Save the waiting counts to the database, then empty the waiting list
    if not pending:
        return
    rows = [(minute, total, bots) for minute, (total, bots) in pending.items()]
    pending.clear()

    conn = sqlite3.connect(DB_PATH)
    try:
        conn.executemany(
            """
            INSERT INTO minute_counts (minute, total, bots)
            VALUES (?, ?, ?)
            ON CONFLICT(minute) DO UPDATE SET
                total = total + excluded.total,
                bots  = bots  + excluded.bots
            """,
            rows,
        )
        conn.commit()
    finally:
        conn.close()


async def flush_loop():
    # Runs forever: every 10 seconds, save the counts
    while True:
        await asyncio.sleep(FLUSH_SECONDS)
        try:
            flush_pending()
        except Exception as error:
            print("Could not save to the database:", error)


# ---------- Stream ----------
def is_wikipedia_edit(data):
    # Same rule as in script.js: real edits and new pages on Wikipedia only
    is_edit = data.get("type") in ("edit", "new")
    server = data.get("server_name")
    is_wikipedia = isinstance(server, str) and server.endswith(".wikipedia.org")
    return is_edit and is_wikipedia


async def listen_to_stream():
    # Runs forever. If the connection drops, wait and connect again.
    while True:
        try:
            # No time limit for reading, because the stream never ends
            timeout = httpx.Timeout(10.0, read=None)
            async with httpx.AsyncClient(timeout=timeout, headers=HEADERS) as client:
                async with client.stream("GET", STREAM_URL) as response:
                    response.raise_for_status()
                    state["connected"] = True
                    print("Connected to the Wikipedia stream")

                    async for line in response.aiter_lines():
                        # Real messages start with "data:". Skip everything else.
                        if not line.startswith("data:"):
                            continue

                        try:
                            data = json.loads(line[5:].strip())
                        except json.JSONDecodeError:
                            continue  # ignore a broken message

                        if not is_wikipedia_edit(data):
                            continue

                        state["total_edits"] += 1
                        state["last_server"] = data.get("server_name")
                        state["last_title"] = data.get("title")
                        record_edit(bool(data.get("bot")))

        except asyncio.CancelledError:
            raise  # the server is shutting down, so stop for real
        except Exception as error:
            print("Stream problem:", error)

        state["connected"] = False
        print("Reconnecting in 5 seconds...")
        await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(app):
    # Start everything when the server starts, clean up when it stops
    init_db()
    listener = asyncio.create_task(listen_to_stream())
    saver = asyncio.create_task(flush_loop())
    yield
    listener.cancel()
    saver.cancel()
    flush_pending()  # save whatever is still waiting


app = FastAPI(title="Wikipedia Live Pulse API", lifespan=lifespan)
# Let the dashboard (a page on another address) read our data
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
)

@app.get("/")
def home():
    return {"message": "Wikipedia Live Pulse backend is running"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/live")
def live():
    return state


@app.get("/minutes")
def minutes():
    # Test address: the 10 newest saved minutes
    conn = sqlite3.connect(DB_PATH)
    try:
        rows = conn.execute(
            "SELECT minute, total, bots FROM minute_counts ORDER BY minute DESC LIMIT 10"
        ).fetchall()
    finally:
        conn.close()

    return [
        {
            "time": datetime.fromtimestamp(minute).strftime("%H:%M"),
            "total": total,
            "bots": bots,
        }
        for minute, total, bots in rows
    ]
@app.get("/stats")
def stats(hours: int = Query(24, ge=1, le=168)):
    # hours must be between 1 and 168 (one week). FastAPI checks this for us.
    now_minute = int(time.time()) // 60 * 60
    start = now_minute - (hours * 60 - 1) * 60  # first minute in the range

    # Include edits that are still waiting in memory, so the newest minute is not behind
    conn = sqlite3.connect(DB_PATH)
    try:
        rows = conn.execute(
            "SELECT minute, total, bots FROM minute_counts WHERE minute >= ? ORDER BY minute",
            (start,),
        ).fetchall()
    finally:
        conn.close()

    saved = {minute: (total, bots) for minute, total, bots in rows}

    points = []
    for minute in range(start, now_minute + 1, 60):
        total, bots = saved.get(minute, (0, 0))
        waiting = pending.get(minute)
        if waiting:
            total += waiting[0]
            bots += waiting[1]
        points.append({"minute": minute, "total": total, "bots": bots})

    # Summary numbers. Minutes with no data (server was off) are not counted as "quiet".
    # The current minute is unfinished, so it is left out of the summary.
    finished = [p for p in points[:-1] if p["total"] > 0]
    totals = [p["total"] for p in finished]
    sum_total = sum(totals)
    sum_bots = sum(p["bots"] for p in finished)

    return {
        "hours": hours,
        "points": points,
        "summary": {
            "minutes_with_data": len(finished),
            "total_edits": sum_total,
            "average_per_minute": round(sum_total / len(totals), 1) if totals else 0,
            "peak_per_minute": max(totals) if totals else 0,
            "bot_share_percent": round(sum_bots / sum_total * 100, 1) if sum_total else 0,
        },
    }