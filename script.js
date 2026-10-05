/* Hilltoppers Prep — settings + Canvas "plan for the day" loader.
   Every Canvas API call goes through the Cloudflare relay at
   https://hilltoppers-canvas-proxy.amos-donn.workers.dev, which forwards the
   request to Canvas with the user's own token (Authorization: Bearer). The
   token is sent only to the relay and Canvas; it never leaves this device.

   instructure.com sends no CORS headers, so a browser can never call Canvas
   directly. There is no direct attempt and no browser fallback — every
   request goes straight to the relay.
   */

(function () {
  "use strict";

  var STORAGE_TOKEN = "hiltoppers.canvasToken";
  /* The CORS proxy is a fixed server-side worker — no user input.
     Its URL is baked into the worker README so a deploy must match. */
  var PROXY_BASE = "https://hilltoppers-canvas-proxy.amos-donn.workers.dev";
  var STORAGE_PROXY = "hiltoppers.canvasProxyUrl";
  /* The school's Canvas host is fixed — no user input needed. */
  var DEFAULT_BASE = "https://stjacademy.instructure.com";

  var els = {};

  /* Look-ahead state: which day is being viewed (0 = today) and the calendar
     pages already fetched for the current classes. */
  var MIN_OFFSET = -7;
  var MAX_OFFSET = 14;
  var dayOffset = 0;
  var cards = [];
  var planCache = {};

  var WEEKDAY_NAMES = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  ];
  var WEEKDAY_ABBR = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

  function shortWeekday(date) {
    var a = WEEKDAY_ABBR[date.getDay()];
    return a.charAt(0).toUpperCase() + a.slice(1);
  }

  /* "10/4" — the canonical date form used for comparisons between the
     calendar's spelling of a date and the day being displayed. */
  function shortKey(date) {
    return date.getMonth() + 1 + "/" + date.getDate();
  }

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    els.token = document.getElementById("canvas-token");
    els.proxyUrl = document.getElementById("canvas-proxy-url");
    els.save = document.getElementById("save-settings");
    els.status = document.getElementById("settings-status");
    els.classes = document.getElementById("classes");
    els.dayName = document.getElementById("day-name");
    els.dayDate = document.getElementById("day-date");
    els.dayPrev = document.getElementById("day-prev");
    els.dayNext = document.getElementById("day-next");
    els.settings = document.getElementById("settings");
    els.toggle = document.getElementById("settings-toggle");

    els.token.value = localStorage.getItem(STORAGE_TOKEN) || "";
    if (els.proxyUrl) els.proxyUrl.value = localStorage.getItem(STORAGE_PROXY) || "";

    els.save.addEventListener("click", onSave);
    els.toggle.addEventListener("click", onToggle);
    if (els.dayPrev) {
      els.dayPrev.addEventListener("click", function () {
        stepDay(-1);
      });
    }
    if (els.dayNext) {
      els.dayNext.addEventListener("click", function () {
        stepDay(1);
      });
    }
    renderDayNav();

    if (els.token.value.trim()) {
      refresh();
    }
  }

  function onToggle() {
    var collapsed = els.settings.toggleAttribute("hidden");
    els.toggle.setAttribute("aria-expanded", String(!collapsed));
  }

  function onSave() {
    var token = els.token.value.trim();

    if (!token) {
      setStatus("Enter a Canvas API token first.", true);
      return;
    }

    localStorage.setItem(STORAGE_TOKEN, token);
    setStatus("Saved.", false);
    refresh();
  }

  function errorStatusText(diag) {
    if (!diag) return "Could not reach Canvas — unknown error.";
    var code = diag.code >= 0 ? "[err-" + diag.code + "] " : "";
    var extra = diag.detail ? " (" + diag.detail + ")" : "";
    var via = diag.relay ? " [via relay " + diag.relay + "]" : "";
    return code + (diag.label || "unknown error") + extra + via;
  }

  function setStatus(text, isError) {
    els.status.textContent = text;
    els.status.classList.toggle("is-error", Boolean(isError));
  }

  /* What the settings line reports once a load finishes. "Loading classes…" is
     written before the request goes out, so something has to replace it —
     otherwise the panel claims to be loading classes that are already on
     screen. */
  function loadedStatusText(count) {
    return "Loaded " + count + (count === 1 ? " class." : " classes.");
  }

  function normalizeBase(url) {
    var v = (url || "").trim().replace(/\/+$/, "");
    if (!v) return "";
    if (!/^https?:\/\//i.test(v)) v = "https://" + v;
    return v;
  }

  function currentToken() {
    return (localStorage.getItem(STORAGE_TOKEN) || "").trim();
  }

  function currentBase() {
    return DEFAULT_BASE;
  }

  function currentProxy() {
    // The proxy URL is fixed: https://hilltoppers-canvas-proxy.amos-donn.workers.dev
    // Kept from localStorage only for the unlikely case a deploy moves it.
    return normalizeBase(localStorage.getItem(STORAGE_PROXY) || PROXY_BASE);
  }

  /* ---------- Canvas API through the relay ----------

     Every failure is classified into a numbered bucket that carries the real
     HTTP status and the server's own message, so the status bar never shows a
     bare, generic "Failed to fetch". */

  function classifyFetchError(err, targetUrl) {
    if (!err) return { code: 9, label: "unknown error (no error object)", detail: "" };
    var msg = String(err && err.message || err);
    var name = String(err && err.name || "Error");
    var relay = String((err && err.relay) || currentProxy() || "");
    var relayHost = relay.replace(/^https?:\/\//, "").split("/")[0];
    var server = serverMessage(err);

    // 0) The relay's own refusal — name the env var to fix, don't blame the token.
    var refusal = relayRefusal(err);
    if (refusal) {
      var tip = /origin/i.test(refusal.error)
        ? " — add " + (refusal.origin || "this page's origin") + " to ALLOWED_ORIGINS"
        : /host|suffix/i.test(refusal.error)
          ? " — add " + (refusal.domain || "the Canvas domain") + " to ALLOWED_SUFFIXES"
          : "";
      return {
        code: 7,
        label: "relay refused the request: " + refusal.error + tip,
        detail: refusal.allowed ? "relay allows: " + refusal.allowed : "",
        relay: relayHost,
      };
    }

    // 1) A 2xx body that was not JSON (check before the status branch: the
    //    parse error carries the response status, which can be 200).
    if (/^ParseError$/i.test(name)) {
      return { code: 5, label: "relay returned non-JSON (HTTP " + (err.status != null ? err.status : "?") + ")", detail: "the relay returned HTML/text instead of Canvas JSON", relay: relayHost };
    }

    // 2) HTTP status returned through the relay (Canvas's own status/body).
    //    Show the real code AND the real server message, never a generic text.
    if (err && err.status != null) {
      var status = err.status;
      var suffix = server ? " — " + server : "";
      if (status === 401 || status === 403) {
        /* An HTML block page means the request never reached the Canvas API —
           typically Cloudflare bot/WAF protection. Don't blame the token. */
        if (!server || /^HTML page/.test(server)) {
          return {
            code: 6,
            label: "blocked upstream (HTTP " + status + ") — got an HTML block page, not the Canvas API",
            detail: server || "empty response body",
            relay: relayHost,
          };
        }
        return { code: 6, label: "Canvas rejected the token (HTTP " + status + ")" + suffix, detail: server, relay: relayHost };
      }
      if (status === 404) {
        return { code: 7, label: "not found (HTTP 404) — wrong API path" + suffix, detail: server || targetUrl, relay: relayHost };
      }
      if (status >= 500) {
        return { code: 8, label: "server error (HTTP " + status + ")" + suffix, detail: server || "relay/Canvas returned HTTP " + status, relay: relayHost };
      }
      return { code: 8, label: "HTTP " + status + suffix, detail: server || "relay returned HTTP " + status, relay: relayHost };
    }

    // 3) fetch() itself rejected: the request never reached the relay.
    if (err instanceof TypeError || /TypeError/i.test(name)) {
      return {
        code: 0,
        label: "relay unreachable at " + relayHost + " (browser refused the connection)",
        detail: "network/CORS failure — check the relay is deployed and its ALLOWED_ORIGINS includes this site",
        relay: relayHost,
      };
    }

    // 4) Connection-level failures.
    if (/AbortError/i.test(name) || /timeout/i.test(msg) || /timed out/i.test(msg) || /etimedout/i.test(msg)) {
      return { code: 2, label: "request to the relay timed out", detail: msg, relay: relayHost };
    }
    if (/refused/i.test(msg) || /reset/i.test(msg) || /econnrefused/i.test(msg) || /econnreset/i.test(msg) || /epipe/i.test(msg)) {
      return { code: 2, label: "connection to the relay was reset or refused", detail: msg, relay: relayHost };
    }

    // 5) TLS / certificate errors.
    if (/cert/i.test(msg) || /ssl/i.test(msg) || /insecure/i.test(msg) || /net::err-/i.test(msg)) {
      return { code: 1, label: "TLS/certificate error reaching the relay", detail: msg, relay: relayHost };
    }

    // 6) Malformed target URL (a build problem, not a Canvas problem).
    if (targetUrl) {
      try {
        var u = new URL(targetUrl);
        if (u.protocol !== "https:" && u.protocol !== "http:") {
          return { code: 4, label: "target is not an https URL (" + u.protocol + ")", detail: targetUrl, relay: relayHost };
        }
      } catch (e) {
        return { code: 4, label: "target URL is malformed", detail: targetUrl, relay: relayHost };
      }
    }
    if (err instanceof SyntaxError || /SyntaxError/i.test(name)) {
      return { code: 5, label: "failed to parse the response as JSON", detail: msg, relay: relayHost };
    }

    return { code: 9, label: "unexpected error (" + name + "): " + msg, detail: usedRelayFallback(err) ? "via relay " + relayHost : "", relay: relayHost };
  }

  function usedRelayFallback(err) {
    return Boolean(err && err.usedRelay);
  }

  /* Pull the real error message out of a failed response body so the UI can
     show what the server actually said instead of a generic failure. */
  function serverMessage(err) {
    var body = err && err.body;
    if (!body) return "";
    var text = String(body);
    try {
      var json = JSON.parse(text);
      if (json && json.message) return String(json.message).slice(0, 200);
      if (json && json.errors) return String(JSON.stringify(json.errors)).slice(0, 200);
      if (json && json.error) return String(json.error).slice(0, 200);
    } catch (e) {}
    /* Not JSON — Canvas/Cloudflare can answer with an HTML block page (e.g.
       "Not Authorized"). Show its title and text instead of raw markup. */
    if (/^\s*<|<!doctype|<html|<!DOCTYPE/i.test(text)) {
      var title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
      title = title.replace(/\s+/g, " ").trim();
      var plain = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      var out = title ? title + ": " + plain : plain;
      return "HTML page, not the Canvas API — " + out.slice(0, 240);
    }
    return text.replace(/\s+/g, " ").trim().slice(0, 200);
  }

  /* The relay's own error shape ({"error": "...", ...}) — distinct from a
     Canvas error body, which uses message/errors. */
  function relayRefusal(err) {
    var body = err && err.body;
    if (!body) return null;
    try {
      var json = JSON.parse(body);
      if (json && typeof json.error === "string" && !json.errors && !json.message) {
        return {
          error: json.error,
          origin: typeof json.origin === "string" ? json.origin : "",
          domain: typeof json.host === "string" ? json.host : "",
          allowed: Array.isArray(json.allowed) ? json.allowed.join(", ") : "",
        };
      }
    } catch (e) {}
    return null;
  }

  function requestJson(url, token, relayBase) {
    var fetchUrl = relayBase + "/?url=" + encodeURIComponent(url);
    return fetch(fetchUrl, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    }).then(function (res) {
      return res.text().then(function (body) {
        if (!res.ok) {
          var httpErr = new Error("HTTP " + res.status);
          httpErr.name = "HttpError";
          httpErr.status = res.status;
          httpErr.statusText = res.statusText || "";
          httpErr.body = body;
          httpErr.target = url;
          httpErr.relay = relayBase;
          httpErr.usedRelay = true;
          throw httpErr;
        }
        try {
          return JSON.parse(body);
        } catch (e) {
          var parseErr = new Error("relay returned non-JSON for " + url);
          parseErr.name = "ParseError";
          parseErr.status = res.status;
          parseErr.body = body;
          parseErr.target = url;
          parseErr.relay = relayBase;
          parseErr.usedRelay = true;
          throw parseErr;
        }
      });
    });
  }

  /* Relay-only: the browser cannot call Canvas directly (instructure.com sends
     no CORS headers), so every request goes straight through the relay. */
  function canvasGet(path) {
    var url = currentBase() + "/api/v1" + path;
    var relay = currentProxy();
    return requestJson(url, currentToken(), relay).catch(function (err) {
      if (err && !err.target) err.target = url;
      if (err && !err.relay) err.relay = relay;
      if (err) err.usedRelay = true;
      throw err;
    });
  }

  /* ---------- Orchestration ---------- */

  function refresh() {
    var token = currentToken();
    els.classes.textContent = "";
    els.latestDiag = null;
    cards = [];
    planCache = {};

    if (!token) {
      els.classes.appendChild(hint("Add your Canvas API token in Settings (the gear) to load the plan for each class."));
      return;
    }

    setStatus("Loading classes…", false);

    canvasGet("/courses?enrollment_state=active&per_page=100")
      .then(function (courses) {
        if (!Array.isArray(courses) || courses.length === 0) {
          els.classes.appendChild(hint("No active classes found on this Canvas account."));
          els.latestDiag = null;
          setStatus("No active classes found.", false);
          return;
        }
        /* The load is over the moment this list arrives — report it instead of
           leaving the line stuck on "Loading classes…". */
        setStatus(loadedStatusText(courses.length), false);
        renderCourseCards(courses);
      })
      .catch(function (err) {
        var target = currentBase() + "/api/v1/courses";
        var diag = classifyFetchError(err, target, true);
        var text = errorStatusText(diag);
        els.latestDiag = { label: diag.label, code: diag.code, detail: diag.detail, target: target, proxyUsed: true };
        setStatus(text, true);
        els.classes.textContent = "";
        els.classes.appendChild(hint(text));
      });
  }

  function renderCourseCards(courses) {
    els.classes.textContent = "";
    els.latestDiag = null;
    cards = [];
    courses.forEach(function (course) {
      var card = makeCard(course.name || "Untitled class");
      els.classes.appendChild(card.sec);
      cards.push({ course: course, card: card });
    });
    renderPlans();

    /* Fetch each class's calendar page once; changing the selected day then
       re-renders from this cache without hitting Canvas again. */
    cards.forEach(function (entry) {
      findPlanPage(entry.course.id)
        .then(function (page) {
          planCache[entry.course.id] = page || null;
          renderPlans();
        })
        .catch(function (err) {
          planCache[entry.course.id] = { error: err };
          renderPlans();
        });
    });
  }

  /* Which day is being shown: today + dayOffset (the look-ahead chips). */
  function targetDate() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    return d;
  }

  function dayLabelFor(date) {
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var diff = Math.round((date - today) / 86400000);
    var same = shortWeekday(date) + " " + shortKey(date);
    if (diff === 0) return "Today, " + same;
    if (diff === 1) return "Tomorrow, " + same;
    return WEEKDAY_NAMES[date.getDay()] + ", " + same;
  }

  /* The day navigator at the top of the popup: < Monday >, arrows stepping one
     day at a time in either direction. */
  function renderDayNav() {
    var date = targetDate();
    /* One word only: "Today" on the current day, otherwise the weekday. The
       date is rendered too but stays hidden until the day is hovered. */
    if (els.dayName) {
      els.dayName.textContent = dayOffset === 0 ? "Today" : WEEKDAY_NAMES[date.getDay()];
    }
    if (els.dayDate) els.dayDate.textContent = shortKey(date);
    if (els.dayPrev) setNavDisabled(els.dayPrev, dayOffset <= MIN_OFFSET);
    if (els.dayNext) setNavDisabled(els.dayNext, dayOffset >= MAX_OFFSET);
  }

  function setNavDisabled(el, disabled) {
    el.classList.toggle("is-disabled", disabled);
    el.setAttribute("aria-disabled", disabled ? "true" : "false");
  }

  function stepDay(delta) {
    var next = dayOffset + delta;
    if (next < MIN_OFFSET || next > MAX_OFFSET) return;
    dayOffset = next;
    renderPlans();
  }

  /* Canvas answers 404 with "That page has been disabled for this course" when
     a teacher turns a class's pages off. Nothing is broken and there is no
     plan to show, so that class must not be drawn at all — not as an error
     card, not as a loading card, not as an "no plan page found" card. */
  function isDisabledPlanPage(err) {
    if (!err || err.status !== 404) return false;
    return /page has been disabled/i.test(
      String(err.body || "") + " " + String(err.message || "")
    );
  }

  function renderPlans() {
    renderDayNav();
    var date = targetDate();
    /* Drop those classes before drawing anything: the card is removed from the
       page and from the list, so it never exists to begin with. */
    var hidden = false;
    cards = cards.filter(function (entry) {
      var cached = planCache[entry.course.id];
      if (!cached || !isDisabledPlanPage(cached.error)) return true;
      if (entry.card.sec.parentNode) entry.card.sec.parentNode.removeChild(entry.card.sec);
      delete planCache[entry.course.id];
      hidden = true;
      return false;
    });
    if (hidden && !cards.length) {
      els.classes.appendChild(hint("No class plans to show."));
      return;
    }
    cards.forEach(function (entry) {
      var cached = planCache[entry.course.id];
      if (cached === undefined) {
        renderState(entry.card.body, "Loading…", "");
        return;
      }
      if (cached && cached.error) {
        var target = currentBase() + "/api/v1/courses/" + entry.course.id + "/front_page";
        var diag = classifyFetchError(cached.error, target, true);
        renderState(entry.card.body, errorStatusText(diag), "is-error");
        return;
      }
      if (!cached) {
        renderState(entry.card.body, "No plan page found for this class.", "is-empty");
        return;
      }
      var plan = planForDate(cached.body, date);
      plan.sourceTitle = cached.title;
      renderPlan(entry.card.body, plan, date);
    });
  }

  /* Locate the calendar spreadsheet: front page first, then any
     calendar/schedule/plan-titled page as a fallback. */
  function findPlanPage(courseId) {
    return canvasGet("/courses/" + courseId + "/front_page")
      .catch(function () {
        return null;
      })
      .then(function (frontPage) {
        if (frontPage && frontPage.body) {
          return { title: frontPage.title, body: frontPage.body };
        }
        return canvasGet("/courses/" + courseId + "/pages?per_page=100").then(function (pages) {
          if (!Array.isArray(pages) || pages.length === 0) return null;
          var pick =
            pages.filter(function (p) {
              return p.front_page;
            })[0] ||
            pages.filter(function (p) {
              return /calendar|schedule|plan|agenda/i.test(p.title || "");
            })[0] ||
            pages[0];
          return canvasGet(
            "/courses/" + courseId + "/pages/" + encodeURIComponent(pick.url)
          ).then(function (page) {
            return { title: page.title, body: page.body || "" };
          });
        });
      });
  }

  /* ---------- Reading the spreadsheet on a class's homepage ---------- */

  /* Every spelling a spreadsheet might use for a specific date. */
  function dateKeysFor(now) {
    var monthsShort = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    var monthsLong = [
      "january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december",
    ];
    var m = now.getMonth();
    var d = now.getDate();
    var y = now.getFullYear();
    var mm = String(m + 1).padStart(2, "0");
    var dd = String(d).padStart(2, "0");
    return [
      y + "-" + mm + "-" + dd,
      (m + 1) + "/" + d,
      mm + "/" + dd,
      monthsShort[m] + " " + d,
      monthsShort[m] + " " + dd,
      monthsLong[m] + " " + d,
      monthsLong[m] + " " + dd,
      monthsShort[m] + " " + d + ", " + y,
      monthsLong[m] + " " + d + ", " + y,
    ];
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function cellMatches(text, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i].test(text)) return true;
    }
    return false;
  }

  /* Teachers pad spreadsheet cells with non-breaking spaces, so a cell can
     hold nothing else. The page arrives as HTML and the tag-strip in cellLines
     leaves character references behind as literal text ("&nbsp;"), which is
     not whitespace — it survived every emptiness check and rendered as plan.
     Decode each spelling to a plain space first, so the whitespace collapse
     and trim below drop it: a lone &nbsp; yields an empty line (dropped), and
     one mixed in with real text just spaces it out. */
  var NBSP_SPELLINGS = /&nbsp;?|&NonBreakingSpace;?|&#0*160;?|&#x0*a0;?|\u00a0/gi;

  function decodeNbsp(text) {
    return String(text == null ? "" : text).replace(NBSP_SPELLINGS, " ");
  }

  /* Display form: decode the padding, collapse whitespace, keep original casing. */
  function cleanText(text) {
    return decodeNbsp(text).replace(/\s+/g, " ").trim();
  }

  /* Match form: display form, lowercased, trailing punctuation stripped. */
  function normalizeCell(text) {
    return cleanText(text).toLowerCase().replace(/[:.,]+$/, "");
  }

  /* ---------- Weekday-labelled calendars ----------

     The two common shapes are a header row of day names (Monday..Friday,
     sometimes each carrying its own date like "Monday 9/28") with the plan
     stacked in the rows below, and the same thing rotated: day names down the
     first column with the plan in the rest of the row. */

  function weekdayOf(text) {
    var t = normalizeCell(text);
    if (!t) return -1;
    for (var i = 0; i < 7; i++) {
      if (new RegExp("^(" + WEEKDAY_NAMES[i].toLowerCase() + "|" + WEEKDAY_ABBR[i] + ")\\b").test(t)) {
        return i;
      }
    }
    return -1;
  }

  /* First m/d (or yyyy-mm-dd) in a cell, canonicalised to "m/d". */
  function firstDateKey(text) {
    var s = String(text || "");
    var iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) return Number(iso[2]) + "/" + Number(iso[3]);
    var m = s.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?\b/);
    if (m) return Number(m[1]) + "/" + Number(m[2]);
    return "";
  }

  function headerWeekdayRow(rows) {
    var limit = Math.min(rows.length, 5);
    for (var r = 0; r < limit; r++) {
      var cells = Array.prototype.slice.call(rows[r].children);
      var cols = {};
      var count = 0;
      var firstWeekday = -1;
      for (var c = 0; c < cells.length; c++) {
        var wd = weekdayOf(cleanText(cells[c].textContent));
        if (wd < 0) continue;
        if (firstWeekday < 0) firstWeekday = c;
        if (cols[wd] != null) continue;
        cols[wd] = c;
        count++;
      }
      if (count < 3) continue;
      /* Sheets often label the rows down the left (FOCUS, HOMEWORK, "Week 6"),
         so the header row carries one extra label cell. When it does not, the
         day columns sit one to the right of the cells the rows use. */
      var dataCols = 0;
      for (var j = r + 1; j < rows.length; j++) {
        dataCols = Math.max(dataCols, rows[j].children.length);
      }
      if (firstWeekday === 0 && dataCols === cells.length + 1) {
        Object.keys(cols).forEach(function (k) {
          cols[k] += 1;
        });
      }
      return { row: r, cols: cols };
    }
    return null;
  }

  function headerWeekdayColumn(rows) {
    for (var c = 0; c < 2; c++) {
      var rowIndex = {};
      var count = 0;
      var limit = Math.min(rows.length, 14);
      for (var r = 0; r < limit; r++) {
        var cells = rows[r].children;
        if (!cells[c]) continue;
        var wd = weekdayOf(cleanText(cells[c].textContent));
        if (wd < 0 || rowIndex[wd] != null) continue;
        rowIndex[wd] = r;
        count++;
      }
      if (count >= 3) return { col: c, rows: rowIndex };
    }
    return null;
  }

  /* Row mode: the day sits in the first cell, the plan in the rest of the row. */
  function weekdayRowFacts(rows, rowIndex) {
    var cells = Array.prototype.slice.call(rows[rowIndex].children);
    var lines = [];
    cells.forEach(function (cell, idx) {
      if (idx === 0) {
        var text = cleanText(cell.textContent);
        var rest = text.replace(/^[a-z]+\b\.?/i, "").replace(/^[\s\-–—:;,]+/, "").trim();
        if (rest) lines.push(rest);
        return;
      }
      cellLines(cell).forEach(function (line) {
        if (!looksLikeDate(line) && lines.indexOf(line) === -1) lines.push(line);
      });
    });
    return rowFacts(lines);
  }

  /* The plan for one specific day (row-mode date, column-mode date, or a
     weekday-labelled calendar). */
  function planForDate(html, date) {
    if (!html) return { kind: "empty" };
    var doc = new DOMParser().parseFromString(html, "text/html");
    // Longest keys first so "october 3" is stripped before "oct 3".
    var keys = dateKeysFor(date).slice().sort(function (a, b) {
      return b.length - a.length;
    });
    var patterns = keys.map(function (k) {
      return new RegExp("(^|[^0-9a-z])" + escapeRe(k) + "(?![0-9])", "i");
    });

    var tables = doc.querySelectorAll("table");
    var sawWeekdayCalendar = false;
    var calendarDates = [];
    var targetWeekday = date.getDay();

    for (var t = 0; t < tables.length; t++) {
      var rows = Array.prototype.slice.call(tables[t].querySelectorAll("tr"));
      if (!rows.length) continue;

      /* 1) The days of the week are the first row — the standard shape. */
      var headerRow = headerWeekdayRow(rows);
      if (headerRow) {
        sawWeekdayCalendar = true;
        var headCells = rows[headerRow.row].children;
        for (var wd = 0; wd < 7; wd++) {
          var hc = headerRow.cols[wd];
          if (hc == null || !headCells[hc]) continue;
          var hd = firstDateKey(cleanText(headCells[hc].textContent));
          if (hd && calendarDates.indexOf(hd) === -1) calendarDates.push(hd);
        }
        var col = headerRow.cols[targetWeekday];
        if (col != null) {
          var headCell = headCells[col];
          var cellDate = headCell ? firstDateKey(cleanText(headCell.textContent)) : "";
          var facts = columnFacts(rows, col, headerRow.row + 1);
          if (facts.length) {
            return { kind: "plan", facts: facts, byWeekday: true, headerDate: cellDate };
          }
        }
      }

      /* 2) The same grid rotated: day names down the first column. */
      var headerCol = headerWeekdayColumn(rows);
      if (headerCol) {
        sawWeekdayCalendar = true;
        var rowIdx = headerCol.rows[targetWeekday];
        if (rowIdx != null) {
          var firstCell = rows[rowIdx].children[headerCol.col];
          var rowDate = firstCell ? firstDateKey(cleanText(firstCell.textContent)) : "";
          var rowFactList = weekdayRowFacts(rows, rowIdx);
          if (rowFactList.length) {
            return { kind: "plan", facts: rowFactList, byWeekday: true, headerDate: rowDate };
          }
        }
      }

      /* 3) Fallback: an explicit date somewhere in the sheet. */
      var dateFacts = matchTableFacts(rows, patterns, keys);
      if (dateFacts.length) return { kind: "plan", facts: dateFacts };
    }

    /* A live Google Sheets/iframe embed is invisible to the Canvas API —
       only text typed into a Canvas page itself is readable. */
    if (/<iframe[\s>]/i.test(html)) return { kind: "embed" };
    if (sawWeekdayCalendar) return { kind: "noDay", dates: calendarDates };
    return { kind: "empty" };
  }

  /* Generic "looks like a date" test — used to tell day cells apart from
     plan cells, and to spot headers with days across the top. */
  var DATEISH =
    /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i;

  function looksLikeDate(text) {
    return DATEISH.test(text || "");
  }

  /* Remove the first occurrence of today's date from text, plus any
     separators left behind ("10/3 - Quiz ch.5" → "Quiz ch.5").
     Returns "" when the text is only the date. */
  function stripDate(text, keys) {
    var lower = text.toLowerCase();
    for (var i = 0; i < keys.length; i++) {
      var idx = lower.indexOf(keys[i]);
      if (idx === -1) continue;
      var rest = text.slice(0, idx) + text.slice(idx + keys[i].length);
      return rest.replace(/^[\s\-–—:;,]+|[\s\-–—:;,]+$/g, "").trim();
    }
    return "";
  }

  /* ---------- Facts: the rows of the day's column ----------

     Every labelled row (FOCUS, CLASSWORK, HOMEWORK, Resources, Materials...)
     becomes one card: the row's left-hand cell is the card title, the day's
     cell is the value, one line per line the teacher typed. */

  function stripTags(html) {
    return String(html || "").replace(/<[^>]*>/g, " ");
  }

  /* Lines inside one cell: sheets use <br> or one block per line. */
  function cellLines(cell) {
    if (!cell) return [];
    var html = String(cell.innerHTML || "");
    var parts = html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
      .split("\n");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var text = cleanText(stripTags(parts[i]));
      if (text && out.indexOf(text) === -1) out.push(text);
    }
    if (!out.length) {
      var flat = cleanText(cell.textContent);
      if (flat) out.push(flat);
    }
    return out;
  }

  /* A cell holding nothing but a date is another day, not a fact. */
  function isPureDate(text) {
    return looksLikeDate(text) && text.replace(DATEISH, "").replace(/[\s\-–—:,+.]+/g, "") === "";
  }

  function columnFacts(rows, col, fromRow) {
    var facts = [];
    var start = fromRow == null ? 1 : fromRow;
    var headerFirst =
      rows[0] && rows[0].children[0] ? cleanText(rows[0].children[0].textContent) : "";
    var labelIsDate = looksLikeDate(headerFirst);
    for (var i = start; i < rows.length; i++) {
      var rowCells = Array.prototype.slice.call(rows[i].children);
      var lines = cellLines(rowCells[col]);
      if (!lines.length) continue;
      if (lines.length === 1 && isPureDate(lines[0])) continue;
      var label = rowCells[0] ? cleanText(rowCells[0].textContent) : "";
      if (col === 0 || looksLikeDate(label) || labelIsDate) label = "";
      facts.push({ label: label, lines: lines });
    }
    return facts;
  }

  function matchTableFacts(rows, patterns, keys) {
    if (!rows.length) return [];

    var hit = null;
    for (var r = 0; r < rows.length && !hit; r++) {
      var cells = Array.prototype.slice.call(rows[r].children);
      for (var c = 0; c < cells.length; c++) {
        if (cellMatches(normalizeCell(cells[c].textContent), patterns)) {
          hit = { row: r, col: c, cells: cells };
          break;
        }
      }
    }
    if (!hit) return [];

    var matchedText = cleanText(hit.cells[hit.col].textContent);

    // Candidate 1 — row mode: the matched cell is the day; the plan lives
    // in the rest of the row (and any text following the date in the cell).
    var rowLines = [];
    var remainder = stripDate(matchedText, keys);
    if (remainder) rowLines.push(remainder);

    var dateLikeInRow = hit.cells.filter(function (cell) {
      return looksLikeDate(cleanText(cell.textContent));
    }).length;

    hit.cells.forEach(function (cell, idx) {
      if (idx === hit.col) return;
      var text = cleanText(cell.textContent);
      if (!text) return;
      if (dateLikeInRow >= 2) {
        if (!looksLikeDate(text)) {
          rowLines.push(text);
          return;
        }
        /* Date-ish sibling: keep it when it carries a plan after the date
           ("10/3 - Quiz ch. 5"), skip it when it is a pure date (another day). */
        var stripped = stripDate(text, keys);
        if (stripped) rowLines.push(stripped);
        return;
      }
      rowLines.push(text);
    });

    // Candidate 2 — column mode: the date sits in the top row, plan items
    // stack below it (dates across the top, or a single-column day list).
    var colFacts = hit.row === 0 && rows.length > 1 ? columnFacts(rows, hit.col) : [];

    // Prefer column mode when the top row is a date header: several dates
    // across it, or a pure date outside the first column.
    var dateLikeInHeader = hit.cells.filter(function (cell) {
      return looksLikeDate(cleanText(cell.textContent));
    }).length;
    var topRowIsDateHeader =
      hit.row === 0 &&
      rows.length > 1 &&
      (dateLikeInHeader >= 2 || (hit.col !== 0 && stripDate(matchedText, keys) === ""));

    var facts = topRowIsDateHeader
      ? colFacts.length
        ? colFacts
        : rowFacts(rowLines)
      : rowLines.length
        ? rowFacts(rowLines)
        : colFacts;

    // De-duplicate while preserving order.
    return facts.filter(function (fact, i) {
      return (
        facts.findIndex(function (other) {
          return other.label === fact.label && other.lines.join("\n") === fact.lines.join("\n");
        }) === i
      );
    });
  }

  /* Row-mode values have no label cell to borrow a title from. */
  function rowFacts(lines) {
    return lines.length ? [{ label: "", lines: lines }] : [];
  }

  /* ---------- Rendering ---------- */

  function hint(text) {
    var p = document.createElement("p");
    p.className = "hint";
    p.textContent = text;
    return p;
  }

  function makeCard(name) {
    var sec = document.createElement("section");
    sec.className = "class-card";

    var h = document.createElement("h2");
    h.className = "class-name";
    h.textContent = name;

    var body = document.createElement("div");
    body.className = "class-body";
    renderState(body, "Loading…", "");

    sec.appendChild(h);
    sec.appendChild(body);
    return { sec: sec, body: body };
  }

  function renderState(body, text, extraClass) {
    body.textContent = "";
    var p = document.createElement("p");
    p.className = "state " + (extraClass || "");
    p.textContent = text;
    body.appendChild(p);
  }

  function renderPlan(body, plan, date) {
    var day = date || new Date();
    if (plan.kind === "empty") {
      renderState(body, "No plan found for " + dayLabelFor(day) + ".", "is-empty");
      return;
    }
    if (plan.kind === "noDay") {
      var covers = plan.dates && plan.dates.length
        ? " (its dates cover " + plan.dates.slice(0, 6).join(", ") + ")"
        : " (it has no dates)";
      renderState(
        body,
        "This class's calendar has no " + WEEKDAY_NAMES[day.getDay()] + " entry" + covers + ".",
        "is-empty"
      );
      return;
    }
    if (plan.kind === "embed") {
      renderState(
        body,
        "This homepage embeds an external sheet (Google Sheets, etc.) that the Canvas API can't read, so the plan can't be extracted.",
        "is-empty"
      );
      return;
    }
    body.textContent = "";

    var note = document.createElement("p");
    note.className = "page-note";
    note.textContent = [plan.headerDate ? "sheet: " + plan.headerDate : "", plan.sourceTitle || ""]
      .filter(Boolean)
      .join(" · ");
    if (note.textContent) body.appendChild(note);

    /* One little card per labelled row the teacher used. */
    var list = document.createElement("div");
    list.className = "fact-list";
    (plan.facts || []).forEach(function (fact) {
      var card = document.createElement("article");
      card.className = "fact";
      if (fact.label) {
        var label = document.createElement("h3");
        label.className = "fact-label";
        label.textContent = fact.label;
        card.appendChild(label);
      } else {
        card.classList.add("fact-unlabelled");
      }
      fact.lines.forEach(function (line) {
        var value = document.createElement("p");
        value.className = "fact-value";
        value.textContent = line;
        card.appendChild(value);
      });
      list.appendChild(card);
    });
    body.appendChild(list);
  }
})();
