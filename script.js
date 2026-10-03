/* Hilltoppers Prep — settings + Canvas "plan for the day" loader.
   All Canvas calls happen in the browser with the user's own token
   (Authorization: Bearer). The token never leaves this device.

   Most Canvas instances block cross-origin browser calls (CORS), so each   request tries Canvas directly first and, when the browser blocks it,
   transparently retries through the CORS proxy hosted at
   https://hilltoppers-canvas-proxy.amos-donn.workers.dev.
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
    if (!diag || diag.code < 0) return diag && diag.label ? diag.label : "Could not reach Canvas.";
    var code = diag.code >= 0 ? "err-" + diag.code : "";
    var extra = diag.detail ? " (" + diag.detail + ")" : "";
    return (code ? "[" + code + "] " : "") + diag.label + extra;
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

  /* ---------- Canvas API (direct first, CORS-proxy fallback) ----------

     Every fetch failure is classified into one of 10 buckets so the status bar
     can say exactly why it failed instead of a generic "Failed to fetch". */

  var ERROR_BUCKETS = [
    /* 0 */[ /^Failed to fetch$/i,
            /^NetworkError/i,
            /Load failed/i,
            /^AbortError/i,
            /^NS_ERROR/i,
      ],  /* CORS/network rejection — browser refused the direct call. */
    /* 1 */[ /certificate/i, /net::err-/, /^ERR_CERT/, /ssl/i, /secure connexion/i,
            /insecure/i, /privacy/i,
      ],  /* TLS/certificate problem reaching the target. */
    /* 2 */[ /^AbortError$/i, /^TimeoutError$/i, /^ECONNRESET$/i, /^EPIPE$/i,
            /etimedout/i, /timeout/i, /timed out/i, /connection refused/i,
            /refused/i, /connection timed out/i, /timedout/i,
      ],  /* Connection reset / timeout / refused. */
    /* 3 */[ /^TypeError:\s*Failed to fetch$/i,
            /^TypeError:\s*(NetworkError|Load failed)/i,
            /^TypeError$/i,
            /blocked/i, /blocked by/i, / CORS/i,
      ],  /**
        *   TypeError with a CORS flavor — normally the browser's opaque
        *   "Failed to fetch" path, but surfaced through the TypeError branch
        *   when the runtime exposes a message. */
    /* 4 */[ /^http:\/\//i, /^file:\/\//i, /^chrome-extension:/i,
            /^blob:/i, /^data:/i, /^ftp:/i, /not a valid URL/i,
            /invalid url/i, /URL constructor/i, /malformed/i,
      ],  /**
        *   Non-https scheme or malformed target — the fetch target was not
        *   an https URL (or was unparseable). */
    /* 5 */[ /^SyntaxError$/i, /unexpected token/i, /JSON at position/i,
            /json/i, /not json/i, /unexpected end/i,
      ],  /**
        *   Response was not JSON — the proxy or Canvas returned HTML/text and
        *   JSON.parse failed. */
    /* 6 */[ /^401/i, /^403/i, /unauthorized/i, /forbidden/i, /rejected the token/i,
      ],  /**
        *   HTTP 401/403 — token rejected or not authorized. */
    /* 7 */[ /^404/i, /not found/i, /does not exist/i, /no such/i, /route/i,
      ],  /**
        *   HTTP 404 / unknown route — the API path or proxy param was wrong. */
    /* 8 */[ /^500/i, /^502/i, /^503/i, /^504/i, /internal error/i, /service/i,
            /temporarily/i, /unavailable/i, /overloaded/i,
      ],  /**
        *   5xx / server-side error — Canvas or the proxy is having trouble. */
    /* 9 */[],
  ].map(function (patterns) {
    return patterns.map(function (p) {
      try { return new RegExp(p.source, p.flags || "i"); } catch (e) {
        return new RegExp(p.source || p, "i");
      }
    });
  });

  function classifyFetchError(err, targetUrl, proxyUsed) {
    if (!err) return { code: 9, label: "unknown error (no error object)", detail: "" };
    var msg = String(err && err.message || err);
    var name = String(err && err.name || "Error");
    var str = name + ": " + msg;

    // Most browsers hide the real network reason under a generic name/message.
    // Surface what we can without inventing details.
    var detail = (err && err.message) ? msg : "";

    // 1) TypeError / opaque network failures
    if (err instanceof TypeError || /TypeError/i.test(name)) {
      for (var i = 0; i < ERROR_BUCKETS[3].length; i++) {
        if (ERROR_BUCKETS[3][i].test(str)) {
          return { code: 3, label: "browser blocked the request (TypeError)", detail: detail };
        }
      }
      for (i = 0; i < ERROR_BUCKETS[0].length; i++) {
        if (ERROR_BUCKETS[0][i].test(str)) {
          return { code: 0, label: "network/CORS failure (browser refused the call)", detail: detail };
        }
      }
      return { code: 0, label: "TypeError — browser refused the request", detail: detail };
    }

    // 2) HTTP responses from fetch (response.ok false)
    if (err && err.status != null) {
      var status = err.status;
      if (status === 401 || status === 403) {
        return { code: 6, label: "Canvas rejected the token (HTTP " + status + ")", detail: detail };
      }
      if (status === 404) {
        return { code: 7, label: "resource not found (HTTP 404) — wrong API path or proxy parameter", detail: detail };
      }
      if (status >= 500) {
        return { code: 8, label: "server error (HTTP " + status + ") — Canvas or proxy is having trouble", detail: detail };
      }
      return { code: 8, label: "HTTP error (status " + status + ")", detail: detail };
    }

    // 3) Syntax/JSON parse failures
    if (err instanceof SyntaxError || /SyntaxError/i.test(name)) {
      for (i = 0; i < ERROR_BUCKETS[5].length; i++) {
        if (ERROR_BUCKETS[5][i].test(str)) {
          return { code: 5, label: "response was not valid JSON", detail: detail };
        }
      }
      return { code: 5, label: "failed to parse the response as JSON", detail: detail };
    }

    // 4) Abort/timeout/connection-level errors (match the raw strings the
    //    browser/runtime may expose, case-insensitively per token).
    if (/AbortError/i.test(name) ||
        /timeout/i.test(msg) || /timed out/i.test(msg) ||
        /etimedout/i.test(msg) || /timedout/i.test(msg) ||
        /connection timed out/i.test(msg)) {
      return { code: 2, label: "request timed out or was aborted", detail: detail };
    }
    if (/refused/i.test(msg) || /reset/i.test(msg) ||
        /econnrefused/i.test(msg) || /epipe/i.test(msg) ||
        /econnreset/i.test(msg) || /reset by peer/i.test(msg)) {
      return { code: 2, label: "connection was reset or refused", detail: detail };
    }

    // 5) TLS / certificate errors
    if (/cert/i.test(str) || /ssl/i.test(str) || /insecure/i.test(str) || /privacy/i.test(str) || /net::err-/i.test(str)) {
      return { code: 1, label: "TLS/certificate error", detail: detail };
    }

    // 6) Non-https scheme or malformed URL
    if (targetUrl) {
      try {
        var u = new URL(targetUrl);
        if (u.protocol !== "https:" && u.protocol !== "http:") {
          return { code: 4, label: "target is not an https URL (" + u.protocol + ")", detail: targetUrl };
        }
      } catch (e) {
        return { code: 4, label: "target URL is malformed", detail: targetUrl };
      }
    }
    if (/invalid url/i.test(str) || /URL constructor/i.test(str) || /malformed/i.test(str) || /^blob:/i.test(str) || /^data:/i.test(str)) {
      return { code: 4, label: "target URL is invalid or not HTTPS", detail: detail };
    }

    // 7) DNS / host not reachable
    if (/host/i.test(str) || /dns/i.test(str) || /resolve/i.test(str) || /not found/i.test(str) || /unknown/i.test(str)) {
      return { code: 2, label: "could not reach the host (DNS/connection)", detail: detail };
    }

    return { code: 9, label: "error (" + name + ")", detail: detail };
  }

  function requestJson(url, token, proxyBase) {
    var fetchUrl = proxyBase ? proxyBase + "/?url=" + encodeURIComponent(url) : url;
    return fetch(fetchUrl, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    }).then(function (res) {
      if (!res.ok) {
        var httpErr = new Error("HTTP " + res.status);
        httpErr.status = res.status;
        throw httpErr;
      }
      return res.json();
    });
  }

  function canvasGet(path) {
    var token = currentToken();
    var url = currentBase() + "/api/v1" + path;
    var proxy = currentProxy();
    var classifier = {
      code: -1,
      label: "",
      source: "",
      target: url,
      proxyUsed: false,
    };

    function setClassifier(err, source) {
      classifier.code = classifyFetchError(err, classifier.target, classifier.proxyUsed).code;
      classifier.label = classifyFetchError(err, classifier.target, classifier.proxyUsed).label;
      classifier.source = source;
    }

    return requestJson(url, token, "").catch(function (err) {
      classifier.proxyUsed = false;
      setClassifier(err, "direct");
      var blocked =
        err instanceof TypeError ||
        /Failed to fetch|NetworkError|Load failed/i.test(String(err && err.message));
      if (blocked && proxy) {
        classifier.proxyUsed = true;
        setClassifier(err, "direct-then-proxy");
        return requestJson(url, token, proxy).catch(function (proxyErr) {
          setClassifier(proxyErr, "proxy");
          throw proxyErr;
        });
      }
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
        var diag = classifyFetchError(err, currentBase() + "/api/v1/courses", false);
        els.latestDiag = { label: err.message || "Could not reach Canvas.", code: diag.code, detail: diag.detail, target: currentBase() + "/api/v1/courses", proxyUsed: false };
        setStatus(errorStatusText(diag), true);
        els.classes.textContent = "";
        els.classes.appendChild(hint(err.message || "Could not reach Canvas." + (diag.detail ? " (" + diag.detail + ")" : "")));
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
          var diag = classifyFetchError(err, currentBase() + "/api/v1/courses/" + course.id + "/front_page", false);
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
