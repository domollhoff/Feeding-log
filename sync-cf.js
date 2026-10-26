/* Feeding Log sync over Cloudflare (a Worker in front of a D1 database).
   Replaces sync-fb-2.js. Plain fetch, no libraries.

   The app loads this file and calls
     FeedSync.startSync({ config, code, onRemote, onStatus }) -> { push(state), stop() }
   The whole log lives on the phone. This file keeps the server copy in step with it:

   Pull   One full pull on start, then "changes since" every 10 seconds while the app is
          on screen, and right away when it comes back or the connection returns.
   Push   The app hands over its whole state on every save (and on launch, return,
          reconnect and every 2 minutes). Only what the server doesn't already have goes
          out, and nothing at all when nothing changed. Something counts as sent only once
          the server confirms it, so a failed upload goes again next time. */
(function () {
  "use strict";

  var DEFAULT_URL = "https://feeding-log-sync.daily-list.workers.dev";
  var POLL_MS = 10000;
  var TIMEOUT_MS = 20000;
  var CHUNK = 500;
  var SETTINGS = ["unit", "babyName", "birthDate", "feedGapMin", "goalFeeds", "goalOz", "goalPump", "goalSleepH"];

  /* JSON with keys sorted and undefined dropped, so two copies compare equal whatever
     order their fields arrived in. */
  function canon(v) {
    if (v && typeof v === "object") {
      if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
      return "{" + Object.keys(v).sort()
        .filter(function (k) { return v[k] !== undefined; })
        .map(function (k) { return JSON.stringify(k) + ":" + canon(v[k]); })
        .join(",") + "}";
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  /* An entry as the server stores it: undefined fields dropped, updatedAt defaulting to at. */
  function toDoc(e) {
    var d = {};
    Object.keys(e).forEach(function (k) { if (e[k] !== undefined) d[k] = e[k]; });
    if (!d.updatedAt) d.updatedAt = d.at || d.deletedAt || Date.now();
    return d;
  }

  function pickSettings(s) {
    var o = {};
    SETTINGS.forEach(function (k) { if (s && s[k] !== undefined) o[k] = s[k]; });
    return o;
  }

  function liveOf(s) {
    return { active: (s && s.active) || null, sleeping: (s && s.sleeping) || null };
  }

  /* Settings, notes and timers as one phone has them, to spot what changed on this phone. */
  function snap(s) {
    return { s: canon(pickSettings(s)), l: canon(liveOf(s)), n: Object.assign({}, (s && s.notes) || {}) };
  }

  function okId(id) {
    return typeof id === "string" && id.length > 0 && id.length <= 100;
  }

  function startSync(opts) {
    var onRemote = opts.onRemote || function () {};
    var onStatus = opts.onStatus || function () {};
    var base = (window.__FEEDSYNC_URL__ || DEFAULT_URL) + "/v1/h/" + encodeURIComponent(opts.code);

    var stopped = false, status = "", ready = false, cursor = 0;
    /* What the server is known to have. */
    var server = { entries: new Map(), canon: new Map(), settings: null, notes: {}, live: null, hasLive: false, liveAt: 0 };
    var latest = null;
    var dirty = { settings: false, live: false, notes: new Set() };
    var removedNotes = new Set();
    var docCache = new WeakMap();
    var busy = false, wantPull = false, wantFlush = false, flushFailed = false, flushQueued = false;
    var sawFirstPush = false, timer = null, aborts = new Set();

    /* The phone's state at launch. A setting, note or timer that differs from it later was
       changed on this phone; one that doesn't is left for the server copy to decide. */
    var prevLocal = null;
    try { prevLocal = snap(JSON.parse(localStorage.getItem("feedlog-v1") || "null")); } catch (e) {}

    function setStatus(s) {
      if (stopped || s === status) return;
      status = s;
      onStatus(s);
    }

    function deliver(data, how) {
      if (stopped) return;
      try {
        if (how) onRemote(data, how);
        else onRemote(data);
      } catch (e) {
        console.error("sync: could not apply an update", e);
      }
    }

    function request(path, init) {
      var ctl = typeof AbortController === "function" ? new AbortController() : null;
      var t = setTimeout(function () { if (ctl) ctl.abort(); }, TIMEOUT_MS);
      var opt = { cache: "no-store", credentials: "omit" };
      if (ctl) {
        opt.signal = ctl.signal;
        aborts.add(ctl);
      }
      if (init) Object.keys(init).forEach(function (k) { opt[k] = init[k]; });
      function done() {
        clearTimeout(t);
        if (ctl) aborts.delete(ctl);
      }
      return fetch(base + path, opt).then(function (r) {
        if (!r.ok) {
          var err = new Error("HTTP " + r.status);
          err.status = r.status;
          throw err;
        }
        return r.json();
      }).then(function (v) { done(); return v; }, function (e) { done(); throw e; });
    }

    /* No connection, or the server is busy or rate limiting: offline. Any other refusal: error. */
    function failed(e) {
      if (stopped) return;
      setStatus(e && e.status && e.status !== 429 && e.status !== 503 ? "error" : "offline");
    }

    /* ---------- pull ---------- */

    function pull() {
      return request("/pull?since=" + (ready ? cursor : 0)).then(function (res) {
        if (stopped) return;
        setStatus("live");
        applyPull(res);
        if (flushFailed && latest) wantFlush = true;
      }, failed);
    }

    function applyPull(res) {
      var first = !ready;
      var entries = [], deleted = {}, m = res.meta || {};

      (res.entries || []).forEach(function (d) {
        if (!d || !okId(d.id)) return;
        var c = canon(d), same = server.canon.get(d.id) === c;
        server.entries.set(d.id, d);
        server.canon.set(d.id, c);
        if (same && !first) return; // our own upload coming back
        if (d.deletedAt) deleted[d.id] = d.deletedAt;
        else entries.push(d);
      });

      if (m.settings) {
        var s = pickSettings(m.settings);
        var settingsChanged = canon(s) !== canon(server.settings);
        server.settings = s;
        if (settingsChanged) deliver(pickSettings(m.settings));
      }

      if (m.notes) {
        var gone = {};
        Object.keys(server.notes).forEach(function (k) {
          if (!(k in m.notes)) {
            gone[k] = "";
            removedNotes.add(k);
          }
        });
        var notesChanged = canon(m.notes) !== canon(server.notes);
        server.notes = Object.assign({}, m.notes);
        if (notesChanged) deliver({ notes: Object.assign(gone, m.notes) });
      }

      if (m.live) {
        var l = liveOf(m.live);
        var liveChanged = !server.hasLive || canon(l) !== canon(server.live);
        server.live = l;
        server.hasLive = true;
        server.liveAt = typeof m.live.savedAt === "number" ? m.live.savedAt : 0;
        if (liveChanged) deliver({ active: l.active, sleeping: l.sleeping }, { live: true });
      }

      cursor = res.cursor || 0;
      if (first) {
        ready = true;
        if (latest) wantFlush = true;
      }
      /* The app waits for "live" and then a list of entries (even an empty one) before its
         first upload, so the first pull always delivers entries, last. */
      if (first || entries.length || Object.keys(deleted).length) deliver({ entries: entries, deleted: deleted });
    }

    /* ---------- push ---------- */

    /* A timer running on this phone that the server has never had, started after the
       server's timers last changed: this phone started it and the upload never made it
       (say, no signal and then the app was closed). It beats the server's copy. */
    function unsentTimer(state) {
      var l = liveOf(state);
      return ["active", "sleeping"].some(function (k) {
        var t = l[k];
        return !!t && (t.startedAt || 0) > server.liveAt && canon(t) !== canon(server.live && server.live[k]);
      });
    }

    /* Mark settings, notes and timers that changed on this phone since the last look. */
    function trackLocal(state) {
      var cur = snap(state), prev = prevLocal || cur;

      if ((cur.s !== prev.s || !server.settings) && cur.s !== canon(server.settings)) dirty.settings = true;
      if ((cur.l !== prev.l || !server.hasLive || unsentTimer(state)) && cur.l !== canon(server.live)) dirty.live = true;

      var keys = {};
      Object.keys(cur.n).forEach(function (k) { keys[k] = 1; });
      Object.keys(prev.n).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).forEach(function (k) {
        var lv = cur.n[k], pv = prev.n[k], sv = server.notes[k];
        if (lv === undefined) removedNotes.delete(k);
        if (lv === sv) return;
        if (lv !== pv) dirty.notes.add(k);
        else if (lv !== undefined && sv === undefined && !removedNotes.has(k)) dirty.notes.add(k);
      });

      prevLocal = cur;
    }

    function docFor(e) {
      var c = docCache.get(e);
      if (!c) {
        var d = toDoc(e);
        c = { d: d, c: canon(d) };
        docCache.set(e, c);
      }
      return c;
    }

    function flush() {
      var state = latest;
      if (!state) return Promise.resolve();
      var body = {};

      /* entries: each one the server doesn't have yet, or has an older copy of */
      var docs = new Map();
      (state.entries || []).forEach(function (e) {
        if (e && okId(e.id)) docs.set(e.id, docFor(e));
      });
      var del = state.deleted || {};
      Object.keys(del).forEach(function (id) {
        if (!okId(id)) return;
        var was = (docs.get(id) || {}).d || server.entries.get(id) || { id: id };
        var d = toDoc(Object.assign({}, was, { id: id, deletedAt: del[id] }));
        docs.set(id, { d: d, c: canon(d) });
      });
      var send = [];
      docs.forEach(function (x, id) {
        var known = server.entries.get(id);
        if (known) {
          if (known.deletedAt) return; // deleted for good on the server
          if (!x.d.deletedAt && (known.updatedAt || 0) > (x.d.updatedAt || 0)) return; // server copy is newer
          if (server.canon.get(id) === x.c) return; // already there
        }
        send.push(x.d);
      });
      var more = send.length > CHUNK;
      if (more) send = send.slice(0, CHUNK);
      if (send.length) body.entries = send;

      var sentSettings = null;
      if (dirty.settings) {
        var s = pickSettings(state);
        if (canon(s) !== canon(server.settings)) {
          sentSettings = s;
          body.settings = Object.assign({}, s, { savedAt: state.savedAt || Date.now() });
        }
        dirty.settings = false;
      }

      var patch = null;
      dirty.notes.forEach(function (k) {
        var lv = (state.notes || {})[k];
        if (lv === server.notes[k]) return;
        (patch = patch || {})[k] = lv === undefined ? "" : lv;
      });
      dirty.notes.clear();
      if (patch) body.notes = patch;

      var sentLive = null;
      if (dirty.live) {
        var l = liveOf(state);
        if (!server.hasLive || canon(l) !== canon(server.live)) body.live = sentLive = l;
        dirty.live = false;
      }

      if (!send.length && !sentSettings && !patch && !sentLive) {
        flushFailed = false;
        return Promise.resolve();
      }

      return request("/push", { method: "POST", body: JSON.stringify(body) }).then(function () {
        if (stopped) return;
        send.forEach(function (d) {
          server.entries.set(d.id, d);
          server.canon.set(d.id, canon(d));
        });
        if (sentSettings) server.settings = sentSettings;
        if (patch) Object.keys(patch).forEach(function (k) {
          if (patch[k]) server.notes[k] = patch[k];
          else delete server.notes[k];
        });
        if (sentLive) {
          server.live = sentLive;
          server.hasLive = true;
          server.liveAt = Date.now();
        }
        flushFailed = false;
        if (more) wantFlush = true;
        setStatus("live");
      }, function (e) {
        if (sentSettings) dirty.settings = true;
        if (sentLive) dirty.live = true;
        if (patch) Object.keys(patch).forEach(function (k) { dirty.notes.add(k); });
        flushFailed = true;
        failed(e);
      });
    }

    function push(state) {
      if (stopped || !state) return;
      latest = state;
      if (ready) {
        trackLocal(state);
        if (!sawFirstPush) {
          sawFirstPush = true;
          /* The app ignores shared timers until its first upload is under way, so the ones
             from the first pull are handed over again now (unless this phone changed its own). */
          if (!dirty.live) setTimeout(function () {
            if (server.hasLive) deliver({ active: server.live.active, sleeping: server.live.sleeping }, { live: true });
          }, 0);
        }
      }
      /* The app sometimes pushes twice in a row (vitamin D goes in a second batch). Both
         become one upload of the newer state. */
      if (!flushQueued) {
        flushQueued = true;
        Promise.resolve().then(function () {
          flushQueued = false;
          wantFlush = true;
          kick();
        });
      }
    }

    /* ---------- one request at a time ---------- */

    function kick() {
      if (busy || stopped) return;
      var job = null;
      if (wantPull) {
        wantPull = false;
        job = pull().then(schedule, schedule);
      } else if (wantFlush && ready) {
        wantFlush = false;
        job = flush();
      }
      if (!job) return;
      busy = true;
      job.then(next, next);
    }

    function next() {
      busy = false;
      kick();
    }

    function onScreen() {
      return document.visibilityState !== "hidden";
    }

    function schedule() {
      clearTimeout(timer);
      timer = null;
      if (!stopped && onScreen()) timer = setTimeout(pollNow, POLL_MS);
    }

    function pollNow() {
      clearTimeout(timer);
      timer = null;
      if (stopped) return;
      wantPull = true;
      kick();
    }

    function onVisibility() {
      if (onScreen()) pollNow();
      else {
        clearTimeout(timer);
        timer = null;
      }
    }

    function stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", pollNow);
      aborts.forEach(function (c) { try { c.abort(); } catch (e) {} });
    }

    setStatus("connecting");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", pollNow);
    pollNow();
    return { push: push, stop: stop };
  }

  window.FeedSync = { startSync: startSync };
})();
