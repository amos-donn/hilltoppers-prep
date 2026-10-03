/* Hilltoppers Prep — settings + Canvas "plan for the day" loader.
   All Canvas calls happen in the browser with the user's own token
   (Authorization: Bearer). The token never leaves this device. */

(function () {
  "use strict";

  var STORAGE_TOKEN = "hiltoppers.canvasToken";
  var STORAGE_BASE = "hiltoppers.canvasBaseUrl";
  var DEFAULT_BASE = "https://canvas.instructure.com";

  var els = {};

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    els.token = document.getElementById("canvas-token");
    els.baseUrl = document.getElementById("canvas-base-url");
    els.save = document.getElementById("save-settings");
    els.status = document.getElementById("settings-status");
    els.classes = document.getElementById("classes");
    els.settings = document.getElementById("settings");
    els.toggle = document.getElementById("settings-toggle");

    els.token.value = localStorage.getItem(STORAGE_TOKEN) || "";
    els.baseUrl.value = localStorage.getItem(STORAGE_BASE) || DEFAULT_BASE;

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
    var base = normalizeBase(els.baseUrl.value);

    if (!token) {
      setStatus("Enter a Canvas API token first.", true);
      return;
    }
    if (!base) {
      setStatus("Enter a valid Canvas base URL (https://…).", true);
      return;
    }

    localStorage.setItem(STORAGE_TOKEN, token);
    localStorage.setItem(STORAGE_BASE, base);
    els.baseUrl.value = base;
    setStatus("Saved.", false);
    refresh();
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
    return normalizeBase(localStorage.getItem(STORAGE_BASE) || DEFAULT_BASE);
  }

  /* ---------- Canvas API ---------- */

  function canvasGet(path) {
    var token = currentToken();
    var url = currentBase() + "/api/v1" + path;
    return fetch(url, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        throw new Error("Canvas rejected the token (HTTP " + res.status + ").");
      }
      if (!res.ok) {
        throw new Error("Canvas responded with HTTP " + res.status + ".");
      }
      return res.json();
    });
  }

  /* ---------- Orchestration ---------- */

  function refresh() {
    var token = currentToken();
    els.classes.textContent = "";

    if (!token) {
      els.classes.appendChild(hint("Add your Canvas API token above to load today's plan for each class."));
      return;
    }

    setStatus("Loading classes…", false);

    canvasGet("/courses?enrollment_state=active&per_page=100")
      .then(function (courses) {
        setStatus("", false);
        if (!Array.isArray(courses) || courses.length === 0) {
          els.classes.appendChild(hint("No active classes found on this Canvas account."));
          return;
        }
        renderCourseCards(courses);
      })
      .catch(function (err) {
        setStatus(err.message || "Could not reach Canvas.", true);
        els.classes.textContent = "";
        els.classes.appendChild(hint(err.message || "Could not reach Canvas."));
      });
  }

  function renderCourseCards(courses) {
    els.classes.textContent = "";
    courses.forEach(function (course) {
      var card = makeCard(course.name || "Untitled class");
      els.classes.appendChild(card.sec);
      loadCoursePlan(course)
        .then(function (plan) {
          renderPlan(card.body, plan);
        })
        .catch(function (err) {
          renderState(card.body, err.message || "Could not load this class.", "is-error");
        });
    });
  }

  function loadCoursePlan(course) {
    return findPlanPage(course.id).then(function (page) {
      if (!page) return { kind: "empty" };
      var lines = extractTodayLines(page.body);
      if (!lines.length) return { kind: "empty" };
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
    for (var i = 1; i < rows.length; i++) {
      var rowCells = Array.prototype.slice.call(rows[i].children);
      var value = rowCells[col] ? cleanText(rowCells[col].textContent) : "";
      if (!value || looksLikeDate(value)) continue;
      var label = rowCells[0] ? cleanText(rowCells[0].textContent) : "";
      lines.push(label && col !== 0 && !looksLikeDate(label) ? label + ": " + value : value);
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
      // In a horizontal day-row the sibling cells are other days — skip
      // them. Otherwise they are plan items — keep them.
      if (dateLikeInRow >= 2 && looksLikeDate(text)) return;
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
