import sqlite3

import pytest
from fastapi.testclient import TestClient

import main

# Without "with", TestClient does not start the Wikipedia listener.
client = TestClient(main.app)

NOW = 1_700_000_030              # a fixed moment, in unix seconds
MINUTE = NOW // 60 * 60          # the start of that minute


class FakeTime:
    # A clock we control, so tests never depend on the real time
    def __init__(self, now):
        self.now = now

    def time(self):
        return self.now


@pytest.fixture(autouse=True)
def fresh_setup(tmp_path, monkeypatch):
    # Every test gets its own empty database file, a fixed clock, and an empty waiting list
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setattr(main, "time", FakeTime(NOW))
    main.pending.clear()
    main.init_db()
    yield
    main.pending.clear()


def test_is_wikipedia_edit_accepts_and_rejects():
    good = {"type": "edit", "server_name": "en.wikipedia.org"}
    new_page = {"type": "new", "server_name": "de.wikipedia.org"}
    wikidata = {"type": "edit", "server_name": "www.wikidata.org"}
    log_entry = {"type": "log", "server_name": "en.wikipedia.org"}

    assert main.is_wikipedia_edit(good) is True
    assert main.is_wikipedia_edit(new_page) is True
    assert main.is_wikipedia_edit(wikidata) is False
    assert main.is_wikipedia_edit(log_entry) is False


def test_record_edit_counts_bots():
    main.record_edit(False)
    main.record_edit(True)
    main.record_edit(True)

    assert main.pending[MINUTE] == [3, 2]  # [all edits, bot edits]


def test_flush_adds_to_same_minute():
    main.record_edit(False)
    main.record_edit(True)
    main.flush_pending()

    main.record_edit(False)
    main.flush_pending()  # same minute again: must ADD, not replace

    conn = sqlite3.connect(main.DB_PATH)
    row = conn.execute("SELECT total, bots FROM minute_counts").fetchone()
    conn.close()

    assert row == (3, 1)


def test_stats_fills_gaps_with_zeros():
    for _ in range(3):
        main.record_edit(False)
    main.flush_pending()

    data = client.get("/stats?hours=1").json()
    points = data["points"]

    assert len(points) == 60                 # one point per minute
    assert points[-1]["minute"] == MINUTE    # the newest point is the current minute
    assert points[-1]["total"] == 3
    assert sum(p["total"] for p in points[:-1]) == 0  # all other minutes are empty


def test_stats_includes_unsaved_edits():
    main.record_edit(False)
    main.record_edit(False)  # not flushed yet: still waiting in memory

    data = client.get("/stats?hours=1").json()

    assert data["points"][-1]["total"] == 2


def test_stats_summary_ignores_unfinished_minute():
    for _ in range(5):
        main.record_edit(False)
    main.record_edit(True)
    main.flush_pending()

    main.time.now += 60  # the next minute begins, so the old one is finished

    summary = client.get("/stats?hours=1").json()["summary"]

    assert summary["minutes_with_data"] == 1
    assert summary["total_edits"] == 6
    assert summary["peak_per_minute"] == 6
    assert summary["average_per_minute"] == 6.0
    assert summary["bot_share_percent"] == 16.7  # 1 bot out of 6 edits


def test_stats_rejects_too_many_hours():
    assert client.get("/stats?hours=999").status_code == 422
    assert client.get("/stats?hours=0").status_code == 422
    assert client.get("/stats?hours=168").status_code == 200