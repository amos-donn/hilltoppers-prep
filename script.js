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

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    els.token = document.getElementById("canvas-token");
    els.proxyUrl = document.getElementById("canvas-proxy-url");
    els.save = document.getElementById("save-settings");
    els.status = document.getElementById("settings-status");
    els.classes = document.getElementById("classes");
    els.settings = document.getElementById("settings");
    els.toggle = document.getElementById("settings-toggle");

    els.token.value = localStorage.getItem(STORAGE_TOKEN) || "";
    if (els.proxyUrl) els.proxyUrl.value = localStorage.getItem(STORAGE_PROXY) || "";

    els.save.addEventListener("click", onSave);
    els.toggle.addEventListener("click", onToggle);

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
        return { code: 6, label: "Canvas rejected the token (HTTP " + status + ")" + suffix, detail: server || "relay returned HTTP " + status, relay: relayHost };
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
    try {
      var json = JSON.parse(body);
      if (json && json.message) return String(json.message).slice(0, 200);
      if (json && json.errors) return String(JSON.stringify(json.errors)).slice(0, 200);
      if (json && json.error) return String(json.error).slice(0, 200);
    } catch (e) {}
    return String(body).replace(/\s+/g, " ").trim().slice(0, 180);
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

    if (!token) {
      els.classes.appendChild(hint("Add your Canvas API token above to load today's plan for each class."));
      return;
    }

    setStatus("Loading classes…", false);

    canvasGet("/courses?enrollment_state=active&per_page=100")
      .then(function (courses) {
        if (!Array.isArray(courses) || courses.length === 0) {
          els.classes.appendChild(hint("No active classes found on this Canvas account."));
          els.latestDiag = null;
          return;
        }
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
    courses.forEach(function (course) {
      var card = makeCard(course.name || "Untitled class");
      els.classes.appendChild(card.sec);
      loadCoursePlan(course)
        .then(function (plan) {
          renderPlan(card.body, plan);
        })
        .catch(function (err) {
          var target = currentBase() + "/api/v1/courses/" + course.id + "/front_page";
          var diag = classifyFetchError(err, target, true);
          renderState(card.body, errorStatusText(diag), "is-error");
        });
    });
  }

  function loadCoursePlan(course) {
    return findPlanPage(course.id).then(function (page) {
      if (!page) return { kind: "empty" };
      var lines = extractTodayLines(page.body);
      if (!lines.length) {
        /* A live Google Sheets/iframe embed is invisible to the Canvas API —
           only text typed into a Canvas page itself is readable. */
        if (/<iframe[\s>]/i.test(page.body)) return { kind: "embed" };
        return { kind: "empty" };
      }
      return { kind: "plan", lines: lines, sourceTitle: page.title };
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

  /* ---------- "Today" extraction from the spreadsheet ---------- */

  function todayKeys() {
    var now = new Date();
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

  /* Display form: collapse whitespace, keep original casing. */
  function cleanText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  /* Match form: display form, lowercased, trailing punctuation stripped. */
  function normalizeCell(text) {
    return cleanText(text).toLowerCase().replace(/[:.,]+$/, "");
  }

  function extractTodayLines(html) {
    if (!html) return [];
    var doc = new DOMParser().parseFromString(html, "text/html");
    // Longest keys first so "october 3" is stripped before "oct 3".
    var keys = todayKeys().slice().sort(function (a, b) {
      return b.length - a.length;
    });
    var patterns = keys.map(function (k) {
      return new RegExp("(^|[^0-9a-z])" + escapeRe(k) + "(?![0-9])", "i");
    });

    var tables = doc.querySelectorAll("table");
    for (var t = 0; t < tables.length; t++) {
      var lines = matchTable(tables[t], patterns, keys);
      if (lines.length) return lines;
    }
    return [];
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

  function columnLines(rows, col) {
    var lines = [];
    /* Prefix labels only when the first column is a real label column
       (vertical day-lists). If the header row's first cell is a date, the
       first column is another day — its cells are not labels. */
    var headerFirst =
      rows[0] && rows[0].children[0] ? cleanText(rows[0].children[0].textContent) : "";
    var labelIsDate = looksLikeDate(headerFirst);
    for (var i = 1; i < rows.length; i++) {
      var rowCells = Array.prototype.slice.call(rows[i].children);
      var value = rowCells[col] ? cleanText(rowCells[col].textContent) : "";
      if (!value || looksLikeDate(value)) continue;
      var label = rowCells[0] ? cleanText(rowCells[0].textContent) : "";
      lines.push(
        label && col !== 0 && !looksLikeDate(label) && !labelIsDate ? label + ": " + value : value
      );
    }
    return lines;
  }

  function matchTable(table, patterns, keys) {
    var rows = Array.prototype.slice.call(table.querySelectorAll("tr"));
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
    var colLines = hit.row === 0 && rows.length > 1 ? columnLines(rows, hit.col) : [];

    // Prefer column mode when the top row is a date header: several dates
    // across it, or a pure date outside the first column.
    var dateLikeInHeader = hit.cells.filter(function (cell) {
      return looksLikeDate(cleanText(cell.textContent));
    }).length;
    var topRowIsDateHeader =
      hit.row === 0 &&
      rows.length > 1 &&
      (dateLikeInHeader >= 2 || (hit.col !== 0 && stripDate(matchedText, keys) === ""));

    var lines = topRowIsDateHeader
      ? colLines.length
        ? colLines
        : rowLines
      : rowLines.length
        ? rowLines
        : colLines;

    // De-duplicate while preserving order.
    return lines.filter(function (line, i) {
      return lines.indexOf(line) === i;
    });
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

  function renderPlan(body, plan) {
    if (plan.kind === "empty") {
      renderState(body, "No plan found for today.", "is-empty");
      return;
    }
    if (plan.kind === "embed") {
      renderState(
        body,
        "This homepage embeds an external sheet (Google Sheets, etc.) that the Canvas API can't read, so today's plan can't be extracted.",
        "is-empty"
      );
      return;
    }
    body.textContent = "";

    if (plan.sourceTitle) {
      var note = document.createElement("p");
      note.className = "page-note";
      note.textContent = plan.sourceTitle;
      body.appendChild(note);
    }

    var ul = document.createElement("ul");
    ul.className = "plan-list";
    plan.lines.forEach(function (line) {
      var li = document.createElement("li");
      li.textContent = line;
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }
})();
