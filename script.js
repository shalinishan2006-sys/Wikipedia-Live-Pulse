const STREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange";
const MAX_FEED_ITEMS = 18; // keep the page light: only the newest edits are shown

// Chart settings
const WINDOW_MINUTES = 10;   // how much history the chart shows
const STEP_SECONDS = 10;     // one point on the line every 10 seconds
const CHART_COLORS = {
  line: "#b9854f",
  lineDark: "#8f5f33",
  fill: "rgba(185, 133, 79, 0.18)",
  grid: "#dccbb0",
  text: "#7d6a58"
};

// Top lists settings
const TOP_PAGES_COUNT = 8;
const TOP_LANGS_COUNT = 8;

// Backend (the FastAPI server from Phase 3)
const API_URL = "http://127.0.0.1:8000";
const HISTORY_HOURS = 24;
const HISTORY_REFRESH_SECONDS = 60;



const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const countEl = document.getElementById("count");
const feedEl = document.getElementById("feed");
const topPagesEl = document.getElementById("topPages");
const topLangsEl = document.getElementById("topLangs");
const humanBarEl = document.getElementById("humanBar");
const botBarEl = document.getElementById("botBar");
const humanTextEl = document.getElementById("humanText");
const botTextEl = document.getElementById("botText");
const spikeCardEl = document.getElementById("spikeCard");
const spikeBadgeEl = document.getElementById("spikeBadge");
const spikeMessageEl = document.getElementById("spikeMessage");
const spikeNowEl = document.getElementById("spikeNow");
const spikeAvgEl = document.getElementById("spikeAvg");
const spikeZEl = document.getElementById("spikeZ");
const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");

const histCanvas = document.getElementById("historyChart");
const histCtx = histCanvas.getContext("2d");
const histNoteEl = document.getElementById("historyNote");
const histAvgEl = document.getElementById("histAvg");
const histPeakEl = document.getElementById("histPeak");
const histBotsEl = document.getElementById("histBots");
const histTotalEl = document.getElementById("histTotal");

let historyData = null; // the last answer from the server (null = not loaded)

// Turns a language code like "de" into a name like "German"
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });

let totalEdits = 0;
const editTimes = [];            // the time (in ms) of every recent edit (for the chart)
const recentEdits = [];          // time + site + title + bot flag of every recent edit
const startTime = Date.now();    // when this page was opened

connect();
drawChart();
refreshLists();
loadHistory();
setInterval(loadHistory, HISTORY_REFRESH_SECONDS * 1000);
setInterval(drawChart, 1000);              // redraw the chart every second
setInterval(refreshLists, 2000);           // refresh the top lists every 2 seconds
window.addEventListener("resize", function () {
  drawChart();
  drawHistory();
});

// ---------- Connection ----------
function connect() {
  // EventSource is built into the browser. It keeps one connection open,
  // and the server pushes a message every time something is edited.
  const source = new EventSource(STREAM_URL);

  source.onopen = function () {
    setStatus("live", "Live");
  };

  source.onmessage = function (event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (error) {
      return; // ignore a broken message instead of crashing
    }

    if (!isWikipediaEdit(data)) return;

    totalEdits++;
    countEl.textContent = totalEdits.toLocaleString();

    const now = Date.now();
    editTimes.push(now); // remember WHEN this edit arrived (for the chart)
    recentEdits.push({
      time: now,
      server: data.server_name,
      title: data.title,
      bot: Boolean(data.bot) // true if a bot made this edit, false if a human did
    });

    addToFeed(data);
  };

  // If the connection drops, EventSource retries by itself.
  // We only need to tell the user what is happening.
  source.onerror = function () {
    setStatus("retry", "Connection lost. Reconnecting...");
  };
}

function setStatus(kind, text) {
  statusDot.className = "dot " + kind;
  statusText.textContent = text;
}

// ---------- Filtering ----------
// The stream contains every Wikimedia project (Wikidata, Commons, ...).
// We keep only real edits and new pages on Wikipedia itself.
function isWikipediaEdit(data) {
  const isEdit = data.type === "edit" || data.type === "new";
  const isWikipedia =
    typeof data.server_name === "string" && data.server_name.endsWith(".wikipedia.org");
  return isEdit && isWikipedia;
}

// ---------- Helpers ----------
function pageUrl(server, title) {
  // encodeURIComponent keeps odd characters from breaking the link.
  return "https://" + server + "/wiki/" + encodeURIComponent(title.replace(/ /g, "_"));
}

// "de.wikipedia.org" -> "de"
function langCode(server) {
  return server.split(".")[0];
}

// "de" -> "German". If the browser does not know the code, show the code itself.
function langName(code) {
  try {
    return languageNames.of(code) || code;
  } catch (error) {
    return code;
  }
}

// ---------- Live feed ----------
function addToFeed(data) {
  const li = document.createElement("li");

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = new Date(data.timestamp * 1000).toLocaleTimeString();

  const lang = document.createElement("span");
  lang.className = "lang";
  lang.textContent = langCode(data.server_name);

  const page = document.createElement("a");
  page.className = "page";
  page.textContent = data.title;
  page.href = pageUrl(data.server_name, data.title);
  page.target = "_blank";
  page.rel = "noopener";

  const user = document.createElement("span");
  user.className = "user";
  user.textContent = "by " + data.user;

  li.append(time, lang, page, user);

  if (data.bot) {
    const badge = document.createElement("span");
    badge.className = "bot-badge";
    badge.textContent = "bot";
    li.appendChild(badge);
  }

  feedEl.prepend(li); // newest on top

  // Remove the oldest items so the list never grows forever
  while (feedEl.children.length > MAX_FEED_ITEMS) {
    feedEl.removeChild(feedEl.lastChild);
  }
}

// ---------- Rolling window lists ----------
function refreshLists() {
  // Rolling window: forget edits older than 10 minutes
  const oldest = Date.now() - WINDOW_MINUTES * 60000;
  while (recentEdits.length > 0 && recentEdits[0].time < oldest) {
    recentEdits.shift();
  }

  renderTopPages();
  renderTopLanguages();
  renderBots();
}

function renderTopPages() {
  // Count edits per page. The key includes the site, because
  // "Paris" on English Wikipedia and "Paris" on French Wikipedia are different pages.
  const counts = new Map();
  for (const edit of recentEdits) {
    const key = edit.server + "|" + edit.title;
    const entry = counts.get(key);
    if (entry) {
      entry.count++;
    } else {
      counts.set(key, { server: edit.server, title: edit.title, count: 1 });
    }
  }

  // Sort from most edited to least edited, keep the top few
  const top = Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_PAGES_COUNT);

  topPagesEl.textContent = ""; // clear the old list

  if (top.length === 0) {
    topPagesEl.appendChild(emptyItem());
    return;
  }

  const maxCount = top[0].count;

  for (const item of top) {
    const li = document.createElement("li");

    const row = document.createElement("div");
    row.className = "page-row";

    const lang = document.createElement("span");
    lang.className = "lang";
    lang.textContent = langCode(item.server);

    const link = document.createElement("a");
    link.className = "page";
    link.textContent = item.title;
    link.href = pageUrl(item.server, item.title);
    link.target = "_blank";
    link.rel = "noopener";

    const count = document.createElement("span");
    count.className = "page-count";
    count.textContent = item.count + (item.count === 1 ? " edit" : " edits");

    row.append(lang, link, count);
    li.append(row, makeBar(item.count / maxCount));
    topPagesEl.appendChild(li);
  }
}

function renderTopLanguages() {
  // Count edits per language code
  const counts = new Map();
  for (const edit of recentEdits) {
    const code = langCode(edit.server);
    counts.set(code, (counts.get(code) || 0) + 1);
  }

  const top = Array.from(counts.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_LANGS_COUNT);

  topLangsEl.textContent = ""; // clear the old list

  if (top.length === 0) {
    topLangsEl.appendChild(emptyItem());
    return;
  }

  const total = recentEdits.length;
  const maxCount = top[0].count;

  for (const item of top) {
    const li = document.createElement("li");

    const row = document.createElement("div");
    row.className = "page-row";

    const badge = document.createElement("span");
    badge.className = "lang";
    badge.textContent = item.code;

    const name = document.createElement("span");
    name.className = "lang-name";
    name.textContent = langName(item.code);

    const share = document.createElement("span");
    share.className = "page-count";
    share.textContent = Math.round((item.count / total) * 100) + "%";

    row.append(badge, name, share);
    li.append(row, makeBar(item.count / maxCount));
    topLangsEl.appendChild(li);
  }
}

function renderBots() {
  const total = recentEdits.length;

  if (total === 0) {
    humanBarEl.style.width = "0%";
    botBarEl.style.width = "0%";
    humanTextEl.textContent = "...";
    botTextEl.textContent = "...";
    return;
  }

  // Count how many edits were made by bots
  let bots = 0;
  for (const edit of recentEdits) {
    if (edit.bot) bots++;
  }
  const humans = total - bots;

  const humanPct = Math.round((humans / total) * 100);
  const botPct = 100 - humanPct; // so the two always add up to 100%

  humanBarEl.style.width = (humans / total) * 100 + "%";
  botBarEl.style.width = (bots / total) * 100 + "%";

  humanTextEl.textContent = humanPct + "% (" + humans.toLocaleString() + ")";
  botTextEl.textContent = botPct + "% (" + bots.toLocaleString() + ")";
}

// Small helpers used by the lists
function emptyItem() {
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = "Collecting data...";
  return li;
}

// A bar filled to "fraction" (a number from 0 to 1)
function makeBar(fraction) {
  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("div");
  fill.className = "bar-fill";
  fill.style.width = fraction * 100 + "%";
  bar.appendChild(fill);
  return bar;
}



function renderSpike(points) {
  const result = analyzeSpike(points);

  if (!result.ready) {
    spikeCardEl.className = "card spike-card";
    spikeBadgeEl.textContent = "Learning...";
    spikeMessageEl.textContent =
      "Learning what normal looks like (" + Math.round(result.progress * 100) + "% ready).";
    spikeNowEl.textContent = "...";
    spikeAvgEl.textContent = "...";
    spikeZEl.textContent = "...";
    return;
  }

  spikeNowEl.textContent = Math.round(result.current);
  spikeAvgEl.textContent = Math.round(result.mean);
  spikeZEl.textContent = result.z.toFixed(1);

  if (result.isSpike) {
    spikeCardEl.className = "card spike-card alert";
    spikeBadgeEl.textContent = "Spike!";
    spikeMessageEl.textContent =
      "Edits are far above the recent average. Something big may be happening.";
  } else {
    spikeCardEl.className = "card spike-card normal";
    spikeBadgeEl.textContent = "Normal";
    spikeMessageEl.textContent =
      "Edit speed is close to the recent average. An alert needs a z-score of " + SPIKE_Z + " or more.";
  }
}

// ---------- Chart data ----------
// Builds the points of the line. Each point = number of edits in the
// 60 seconds before that moment (so the value really means "edits per minute").
function buildSeries(now) {
  // Throw away edits older than the chart needs (window + 1 minute)
  const oldest = now - (WINDOW_MINUTES + 1) * 60000;
  while (editTimes.length > 0 && editTimes[0] < oldest) {
    editTimes.shift();
  }

  const points = [];
  const stepMs = STEP_SECONDS * 1000;
  const totalSteps = (WINDOW_MINUTES * 60) / STEP_SECONDS;

  for (let i = totalSteps; i >= 0; i--) {
    const end = now - i * stepMs;

    // Skip moments before the page was opened (we have no data for them).
    // Also wait 5 seconds so the very first point is not based on almost nothing.
    if (end < startTime + 5000) continue;

    // In the first minute, the window is shorter than 60 seconds.
    // We scale the number up so it still means "per minute".
    const span = Math.min(60000, end - startTime);

    let count = 0;
    for (let j = editTimes.length - 1; j >= 0; j--) {
      const t = editTimes[j];
      if (t > end) continue;        // newer than this point, skip
      if (t <= end - span) break;   // older than the window, stop
      count++;
    }

    points.push({ time: end, value: (count / span) * 60000 });
  }
  return points;
}

// ---------- Chart drawing ----------
function drawChart() {
  const now = Date.now();
  const points = buildSeries(now);
  renderSpike(points); // check the same points for a spike

  // Make the canvas sharp on high-resolution screens (like a MacBook)
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = rect.width;
  const H = rect.height;
  const pad = { left: 52, right: 18, top: 16, bottom: 30 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  ctx.clearRect(0, 0, W, H);
  ctx.font = "12px Inter, system-ui, sans-serif";

  // Choose a "nice" top value for the y axis
  let maxValue = 10;
  for (const p of points) {
    if (p.value > maxValue) maxValue = p.value;
  }
  const niceMax = Math.ceil((maxValue * 1.1) / 20) * 20;

  const windowMs = WINDOW_MINUTES * 60000;
  const xFor = (time) => pad.left + ((time - (now - windowMs)) / windowMs) * plotW;
  const yFor = (value) => pad.top + plotH - (value / niceMax) * plotH;

  // Horizontal grid lines and y labels
  ctx.strokeStyle = CHART_COLORS.grid;
  ctx.fillStyle = CHART_COLORS.text;
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const value = (niceMax / gridLines) * i;
    const y = yFor(value);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
    ctx.fillText(Math.round(value), pad.left - 8, y);
  }

  // x labels
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(WINDOW_MINUTES + " min ago", pad.left, H - 8);
  ctx.textAlign = "center";
  ctx.fillText(WINDOW_MINUTES / 2 + " min ago", pad.left + plotW / 2, H - 8);
  ctx.textAlign = "right";
  ctx.fillText("now", W - pad.right, H - 8);

  // Not enough data yet
  if (points.length < 2) {
    ctx.fillStyle = CHART_COLORS.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Collecting data...", pad.left + plotW / 2, pad.top + plotH / 2);
    return;
  }

  // Soft filled area under the line
  ctx.beginPath();
  ctx.moveTo(xFor(points[0].time), yFor(0));
  for (const p of points) ctx.lineTo(xFor(p.time), yFor(p.value));
  ctx.lineTo(xFor(points[points.length - 1].time), yFor(0));
  ctx.closePath();
  ctx.fillStyle = CHART_COLORS.fill;
  ctx.fill();

  // The line itself
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xFor(p.time);
    const y = yFor(p.value);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = CHART_COLORS.line;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  // Dot and label on the newest point
  const last = points[points.length - 1];
  const lx = xFor(last.time);
  const ly = yFor(last.value);
  ctx.beginPath();
  ctx.arc(lx, ly, 5, 0, Math.PI * 2);
  ctx.fillStyle = CHART_COLORS.lineDark;
  ctx.fill();

  ctx.fillStyle = CHART_COLORS.lineDark;
  ctx.font = "600 13px Inter, system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(Math.round(last.value) + " / min", lx - 10, ly - 8);
}

// ---------- 24-hour history (from the backend) ----------
async function loadHistory() {
  try {
    const response = await fetch(API_URL + "/stats?hours=" + HISTORY_HOURS);
    if (!response.ok) throw new Error("Server answered " + response.status);
    historyData = await response.json();
  } catch (error) {
    // Keep the old data if we have some. Otherwise show a message.
    if (!historyData) {
      histNoteEl.textContent =
        "History is not available. Start the backend server (uvicorn main:app --reload) and refresh.";
      drawHistory();
    }
    return;
  }

  const s = historyData.summary;
  histAvgEl.textContent = Math.round(s.average_per_minute).toLocaleString();
  histPeakEl.textContent = s.peak_per_minute.toLocaleString();
  histBotsEl.textContent = Math.round(s.bot_share_percent) + "%";
  histTotalEl.textContent = s.total_edits.toLocaleString();

  const hours = (s.minutes_with_data / 60).toFixed(1);
  histNoteEl.textContent =
    "The server has data for " + hours + " of the last " + HISTORY_HOURS +
    " hours. Gaps in the line mean the server was not running.";

  drawHistory();
}

function drawHistory() {
  const dpr = window.devicePixelRatio || 1;
  const rect = histCanvas.getBoundingClientRect();
  histCanvas.width = rect.width * dpr;
  histCanvas.height = rect.height * dpr;
  histCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = rect.width;
  const H = rect.height;
  const pad = { left: 52, right: 18, top: 16, bottom: 30 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  histCtx.clearRect(0, 0, W, H);
  histCtx.font = "12px Inter, system-ui, sans-serif";

  // Leave out the newest minute: it is still being counted, so it looks too low
  const all = historyData ? historyData.points.slice(0, -1) : [];

  // Group minutes into buckets about 2 pixels wide, so we never draw 1,440 tiny segments
  const bucketCount = Math.max(1, Math.floor(plotW / 2));
  const perBucket = Math.max(1, Math.ceil(all.length / bucketCount));
  const buckets = [];
  for (let i = 0; i < all.length; i += perBucket) {
    const chunk = all.slice(i, i + perBucket).filter((p) => p.total > 0);
    const time = all[i].minute;
    if (chunk.length === 0) {
      buckets.push({ time, value: null }); // no data = a gap
    } else {
      let sum = 0;
      for (const p of chunk) sum += p.total;
      buckets.push({ time, value: sum / chunk.length });
    }
  }

  let maxValue = 10;
  for (const b of buckets) {
    if (b.value !== null && b.value > maxValue) maxValue = b.value;
  }
  const niceMax = Math.ceil((maxValue * 1.1) / 20) * 20;

  const xFor = (i) => pad.left + (i / Math.max(1, buckets.length - 1)) * plotW;
  const yFor = (value) => pad.top + plotH - (value / niceMax) * plotH;

  // Grid lines and y labels
  histCtx.strokeStyle = CHART_COLORS.grid;
  histCtx.fillStyle = CHART_COLORS.text;
  histCtx.lineWidth = 1;
  histCtx.textAlign = "right";
  histCtx.textBaseline = "middle";
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const value = (niceMax / gridLines) * i;
    const y = yFor(value);
    histCtx.beginPath();
    histCtx.moveTo(pad.left, y);
    histCtx.lineTo(W - pad.right, y);
    histCtx.stroke();
    histCtx.fillText(Math.round(value), pad.left - 8, y);
  }

  // x labels (clock times from the data)
  histCtx.textBaseline = "alphabetic";
  const timeLabel = (minute) =>
    new Date(minute * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (buckets.length > 0) {
    histCtx.textAlign = "left";
    histCtx.fillText(timeLabel(buckets[0].time), pad.left, H - 8);
    histCtx.textAlign = "center";
    histCtx.fillText(timeLabel(buckets[Math.floor(buckets.length / 2)].time), pad.left + plotW / 2, H - 8);
    histCtx.textAlign = "right";
    histCtx.fillText(timeLabel(buckets[buckets.length - 1].time), W - pad.right, H - 8);
  }

  const hasData = buckets.some((b) => b.value !== null);
  if (!hasData) {
    histCtx.fillStyle = CHART_COLORS.text;
    histCtx.textAlign = "center";
    histCtx.textBaseline = "middle";
    histCtx.fillText(
      historyData ? "No saved data yet" : "History not available",
      pad.left + plotW / 2,
      pad.top + plotH / 2
    );
    return;
  }

  // Draw each run of connected buckets as its own filled shape with a line on top.
  // A null bucket ends the run, which makes a visible gap.
  let run = [];
  const flushRun = () => {
    if (run.length === 0) return;

    if (run.length === 1) {
      // A single point cannot make a line, so draw a dot
      histCtx.beginPath();
      histCtx.arc(xFor(run[0].i), yFor(run[0].value), 2.5, 0, Math.PI * 2);
      histCtx.fillStyle = CHART_COLORS.line;
      histCtx.fill();
    } else {
      histCtx.beginPath();
      histCtx.moveTo(xFor(run[0].i), yFor(0));
      for (const r of run) histCtx.lineTo(xFor(r.i), yFor(r.value));
      histCtx.lineTo(xFor(run[run.length - 1].i), yFor(0));
      histCtx.closePath();
      histCtx.fillStyle = CHART_COLORS.fill;
      histCtx.fill();

      histCtx.beginPath();
      run.forEach((r, k) => {
        if (k === 0) histCtx.moveTo(xFor(r.i), yFor(r.value));
        else histCtx.lineTo(xFor(r.i), yFor(r.value));
      });
      histCtx.strokeStyle = CHART_COLORS.line;
      histCtx.lineWidth = 2;
      histCtx.lineJoin = "round";
      histCtx.stroke();
    }
    run = [];
  };

  buckets.forEach((b, i) => {
    if (b.value === null) flushRun();
    else run.push({ i, value: b.value });
  });
  flushRun();
}