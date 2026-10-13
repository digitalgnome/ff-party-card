/*
 * FF Party Card v2 — a Final Fantasy-style party menu for Home Assistant.
 *
 *   HP / MP   any sensor, mapped from a min..max range onto 9999 / 999 (labels and maxes are configurable)
 *   Statuses  built-in: Regen (charging), Sleep, Silence (DND/Focus), Slow (power saving), KO (dead/offline)
 *             plus your own from any entity
 *   Theme     presets (classic, ff7, crimson, forest, midnight, moogle) or your own colors, font and size
 *   Actions   tap / hold a member for more-info, navigate, call a service, etc.
 *
 * Everything is editable in the visual card editor. Old v1 configs (battery / steps / storage) still work.
 *
 * Install: copy to /config/www/ff-party/ff-party-card.js, then add a dashboard resource:
 *   URL: /local/ff-party/ff-party-card.js?v=5   Type: JavaScript module
 */
(() => {
  const VERSION = "2.1.0";

  // Free pixel fonts from Google Fonts. `size` evens out how big each one looks.
  const FONTS = {
    dotgothic:  { label: "DotGothic16 (SNES-era JRPG)", family: "'DotGothic16'",    google: "DotGothic16",                size: 1 },
    pixelify:   { label: "Pixelify Sans (rounded)",     family: "'Pixelify Sans'",  google: "Pixelify+Sans:wght@400;600", size: 1 },
    pressstart: { label: "Press Start 2P (NES / FF1)",  family: "'Press Start 2P'", google: "Press+Start+2P",             size: 0.78 },
    silkscreen: { label: "Silkscreen (all caps)",       family: "'Silkscreen'",     google: "Silkscreen:wght@400;700",    size: 0.9 },
    vt323:      { label: "VT323 (terminal)",            family: "'VT323'",          google: "VT323",                      size: 1.25 },
    jersey:     { label: "Jersey 10 (tall arcade)",     family: "'Jersey 10'",      google: "Jersey+10",                  size: 1.2 },
  };
  const CUSTOM_FAMILY = "FF Party Custom";

  // ───────────────────────── helpers ─────────────────────────

  function addToHead(id, make) {
    if (document.getElementById(id)) return;
    const el = make();
    el.id = id;
    document.head.appendChild(el);
  }

  // Fonts declared inside a shadow root are ignored by Chrome, so load them on the page.
  // Returns the CSS font-family and size factor to use.
  function resolveFont(c) {
    const fallback = ", 'DotGothic16', monospace";
    if (c.font_url) {
      const url = String(c.font_url);
      const id = "ff-party-card-font-custom-" + url.replace(/[^a-z0-9]/gi, "").slice(-40);
      if (/\.css(\?|$)/i.test(url)) {
        addToHead(id, () => Object.assign(document.createElement("link"), { rel: "stylesheet", href: url }));
        // A stylesheet names its own family, so use the font setting as that name.
        const fam = FONTS[c.font] ? FONTS[c.font].family : c.font;
        return { family: (fam || `'${CUSTOM_FAMILY}'`) + fallback, size: 1 };
      }
      addToHead(id, () => {
        const s = document.createElement("style");
        s.textContent = `@font-face { font-family: "${CUSTOM_FAMILY}"; src: url("${url.replace(/["\\]/g, "")}"); font-display: swap; }`;
        return s;
      });
      return { family: `'${CUSTOM_FAMILY}'` + fallback, size: 1 };
    }
    const preset = FONTS[c.font];
    if (preset) {
      addToHead("ff-party-card-font-" + c.font, () =>
        Object.assign(document.createElement("link"), {
          rel: "stylesheet",
          href: `https://fonts.googleapis.com/css2?family=${preset.google}&display=swap`,
        })
      );
      return { family: preset.family + fallback, size: preset.size };
    }
    // Anything else is treated as a CSS font-family you've loaded yourself.
    addToHead("ff-party-card-font-dotgothic", () =>
      Object.assign(document.createElement("link"), {
        rel: "stylesheet",
        href: `https://fonts.googleapis.com/css2?family=${FONTS.dotgothic.google}&display=swap`,
      })
    );
    return { family: (c.font || FONTS.dotgothic.family) + fallback, size: 1 };
  }

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const num = (v, d) => {
    const n = parseFloat(v);
    return isNaN(n) ? d : n;
  };
  const OFF = new Set(["off", "false", "none", "unknown", "unavailable", ""]);
  const isOn = (st) => !!st && !OFF.has(String(st.state).toLowerCase());
  const toColor = (v) =>
    Array.isArray(v) && v.length >= 3 ? `rgb(${v.slice(0, 3).map(Number).join(",")})` : v ? String(v) : null;

  function fmtState(st, decimals) {
    const n = parseFloat(st.state);
    const unit = st.attributes?.unit_of_measurement || "";
    if (isNaN(n)) return String(st.state);
    const rounded = decimals != null ? Number(n.toFixed(decimals)) : Math.round(n * 10) / 10;
    const v = rounded.toLocaleString();
    if (!unit) return v;
    return unit === "%" ? `${v}%` : `${v} ${unit}`;
  }

  // Custom status rule: { name, entity, attribute?, state? | above? / below?, color? }
  function matchStatus(rule, states) {
    const st = states[rule.entity];
    if (!st) return false;
    const raw = rule.attribute ? st.attributes?.[rule.attribute] : st.state;
    if (rule.state != null) {
      const want = (Array.isArray(rule.state) ? rule.state : [rule.state]).map((x) => String(x).toLowerCase());
      return want.includes(String(raw).toLowerCase());
    }
    if (rule.above != null || rule.below != null) {
      const n = parseFloat(raw);
      if (isNaN(n)) return false;
      if (rule.above != null && !(n > rule.above)) return false;
      if (rule.below != null && !(n < rule.below)) return false;
      return true;
    }
    if (rule.attribute) return raw === true || isOn({ state: raw });
    return isOn(st);
  }

  // Translate v1 member keys (battery / steps / storage) into v2 (hp / mp).
  function normMember(m, c) {
    const n = { ...m };
    if (!n.hp && n.battery) n.hp = n.battery;
    if (!n.mp && n.storage) n.mp = n.storage;
    if (!n.mp && n.steps) {
      n.mp = n.steps;
      if (n.mp_max == null) n.mp_max = c.step_goal ?? 8000;
    }
    delete n.battery;
    delete n.storage;
    delete n.steps;
    return n;
  }

  const footerMode = (c) =>
    c.footer || (c.show_footer === false ? "hidden" : c.footer_position || "top");

  const THEMES = {
    classic:  { name: "Classic blue",  window_top: "#4a5fd6", window_bottom: "#141b5e", border: "#e9ecf5", text: "#ffffff", label: "#9fd3ff", hp: "#3a7bff", mp: "#2fb36b" },
    ff7:      { name: "FF7 deep blue", window_top: "#2f55c8", window_bottom: "#050d38", border: "#d8dce8", text: "#ffffff", label: "#8fc6ff", hp: "#4f8cff", mp: "#38c178" },
    crimson:  { name: "Crimson",       window_top: "#9a2a3c", window_bottom: "#2a0710", border: "#f2e6d0", text: "#fff7ec", label: "#ffcf8a", hp: "#ff7a59", mp: "#e8b84a" },
    forest:   { name: "Forest",        window_top: "#2f7a4a", window_bottom: "#0b2614", border: "#e6f2e0", text: "#ffffff", label: "#b9f5c8", hp: "#4fc3a1", mp: "#9ad94f" },
    midnight: { name: "Midnight",      window_top: "#30344a", window_bottom: "#0c0d14", border: "#c9ccd6", text: "#eef0f6", label: "#9fb4ff", hp: "#6b8cff", mp: "#56c2a6" },
    moogle:   { name: "Moogle pink",   window_top: "#c46aa8", window_bottom: "#3e1240", border: "#fff0f8", text: "#ffffff", label: "#ffd1ec", hp: "#ff7ab8", mp: "#b98aff" },
  };

  const DEFAULTS = {
    title: null,
    theme: "classic",
    cursor: true,
    hp_label: "HP",
    hp_display_max: 9999,
    mp_label: "MP",
    mp_display_max: 999,
    low: 30,
    critical: 15,
    hp_note: "none",   // text under the HP bar: none | value | percent
    mp_note: "value",  // text under the MP bar: none | value | percent
    step_goal: 8000,   // only used by old v1 `steps:` configs
    offline_hours: 6,  // KO if nothing reports this long while not charging (0 = never)
    sleep_start: 22,
    sleep_end: 7,
    home_label: "Home",
    away_label: "Wandering",
    builtin_statuses: true,
    gil: null,
    gil_label: "Gil",
    gil_decimals: null,
    gil_unit: true,
    font: "dotgothic", // a preset from FONTS, or any CSS font-family
    font_url: null,    // optional: your own .ttf/.woff/.woff2 (or a .css stylesheet) to load
    scale: 1,
  };

  // Pixel glove cursor, pointing right.
  const CURSOR = `<svg viewBox="-1 0 21 14" aria-hidden="true">
    <path d="M0 3H4V4H6V2H10V4H19V7H14V9H13V11H12V12H0Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="round"/>
    <path d="M4 4V12M11 7H14M11 9H13" stroke="#000" stroke-width="1" fill="none"/>
  </svg>`;

  const CSS = `
    :host { display: block; }
    ha-card { display: block; background: none; border: none; box-shadow: none; overflow: visible; }
    .ff {
      container-type: inline-size; font-family: var(--ff-font); color: var(--ff-text); --edge: var(--ff-border);
      font-synthesis: none; /* fake bold looks smeared on pixel fonts */
      -webkit-font-smoothing: none;
    }
    .inner {
      --s: calc(var(--ff-scale) * var(--ff-fscale, 1));
      font-size: clamp(calc(13px * var(--s)), calc(3.1cqw * var(--s)), calc(30px * var(--s)));
      display: flex; flex-direction: column; gap: .5em;
    }

    .window {
      background: linear-gradient(180deg,
        var(--ff-win-top) 0%,
        color-mix(in srgb, var(--ff-win-top) 45%, var(--ff-win-bottom)) 45%,
        var(--ff-win-bottom) 100%);
      border: .18em solid var(--edge);
      border-radius: .45em;
      box-shadow: inset 0 0 0 .1em color-mix(in srgb, var(--ff-win-bottom) 60%, #000), 0 .3em .8em rgba(0,0,0,.45);
      padding: .6em .9em;
      text-shadow: .08em .08em 0 #000;
    }
    .title { font-size: .8em; letter-spacing: .08em; opacity: .85; text-transform: uppercase; margin-bottom: .2em; }
    .empty { opacity: .8; padding: .6em 0; }

    .member {
      display: grid;
      grid-template-columns: 1.5em 3.6em 1fr minmax(9.5em, 42%);
      align-items: center;
      gap: .7em;
      padding: .55em 0;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      border-radius: .3em;
    }
    .member:active { background: rgba(255,255,255,.06); }
    .member + .member { border-top: .08em dashed rgba(255,255,255,.18); }

    .cursor svg { width: 1.4em; display: block; animation: bob .9s steps(2) infinite; }
    @keyframes bob { 50% { transform: translateX(.25em); } }

    .portrait {
      width: 3.6em; height: 3.6em;
      border: .12em solid var(--edge); border-radius: .25em;
      background: linear-gradient(160deg, color-mix(in srgb, var(--ff-win-top) 75%, #fff), var(--ff-win-bottom));
      display: grid; place-items: center; overflow: hidden;
    }
    .portrait img { width: 100%; height: 100%; object-fit: cover; }
    .portrait span { font-size: 1.9em; font-weight: 600; }
    .is-ko .portrait { filter: grayscale(1) brightness(.55); }
    .is-ko .name { color: #ff8a8a; }

    .name { font-size: 1.15em; font-weight: 600; }
    .job { display: block; font-size: .75em; opacity: .75; white-space: nowrap; }
    .statuses { display: flex; gap: .35em; flex-wrap: wrap; margin-top: .25em; min-height: 1.1em; }
    .chip {
      font-size: .68em; padding: .05em .45em; border-radius: .3em;
      border: .1em solid currentColor; background: rgba(0,0,0,.25); text-shadow: none;
      color: var(--ff-label);
    }
    .chip.ko { color: #ff6b6b; }
    .chip.regen { color: #7dff9a; }
    .chip.sleep { color: #c9a7ff; }
    .chip.silence { color: #c7ccd8; }
    .chip.slow { color: #ffd45e; }
    .loc { font-size: .72em; opacity: .85; margin-top: .3em; }
    .loc b { font-weight: 400; color: var(--ff-label); margin-right: .4em; }

    .stat { display: flex; align-items: baseline; gap: .3em; font-variant-numeric: tabular-nums; }
    .lbl { color: var(--ff-label); font-size: .8em; width: 1.8em; }
    .num { font-size: 1.15em; min-width: 4.2ch; text-align: right; }
    .max { font-size: .8em; opacity: .7; }
    .num.low { color: #ffe14d; }
    .num.crit { color: #ff5a5a; animation: flash 1s steps(2) infinite; }
    .num.ko { color: #ff5a5a; }
    @keyframes flash { 50% { opacity: .25; } }

    .bar {
      height: .38em; background: rgba(0,0,0,.55); border: .08em solid #000; border-radius: .2em;
      margin: .15em 0 .35em 2.1em; position: relative; overflow: hidden;
    }
    .bar i { position: absolute; top: 0; bottom: 0; left: 0; display: block; transition: width .8s; overflow: hidden; }
    .hpbar i { background: linear-gradient(90deg, var(--ff-hp), color-mix(in srgb, var(--ff-hp) 45%, #fff)); }
    .hpbar.low i { background: linear-gradient(90deg, #d69e00, #ffe14d); }
    .hpbar.crit i { background: linear-gradient(90deg, #b31b1b, #ff6b6b); }
    .mpbar i { background: linear-gradient(90deg, var(--ff-mp), color-mix(in srgb, var(--ff-mp) 45%, #fff)); }
    .regen i::after {
      content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 40%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.7), transparent);
      animation: shimmer 1.6s linear infinite;
    }
    @keyframes shimmer { from { transform: translateX(-120%); } to { transform: translateX(320%); } }
    .note { font-size: .62em; opacity: .65; text-align: right; margin-top: -.2em; }

    .footer { display: flex; justify-content: space-between; gap: 1em; flex-wrap: wrap; }
    .footer .k { color: var(--ff-label); margin-right: .6em; }
    .footer .v { font-variant-numeric: tabular-nums; }

    @container (max-width: 480px) {
      .member { grid-template-columns: 1.2em 3em 1fr; }
      .stats { grid-column: 2 / -1; }
    }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
  `;

  // ───────────────────────── the card ─────────────────────────

  class FFPartyCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._sig = "";
      this._actions = [];

      // Tap / hold handling, delegated so it survives re-renders.
      const rowOf = (e) => e.target.closest?.(".member");
      this.shadowRoot.addEventListener("pointerdown", (e) => {
        const row = rowOf(e);
        if (!row) return;
        this._held = false;
        clearTimeout(this._holdTimer);
        this._holdTimer = setTimeout(() => {
          this._held = true;
          this._act(+row.dataset.idx, "hold");
        }, 500);
      });
      const cancel = () => clearTimeout(this._holdTimer);
      this.shadowRoot.addEventListener("pointerup", cancel);
      this.shadowRoot.addEventListener("pointercancel", cancel);
      this.shadowRoot.addEventListener("click", (e) => {
        const row = rowOf(e);
        if (!row) return;
        if (this._held) { this._held = false; return; }
        this._act(+row.dataset.idx, "tap");
      });
    }

    setConfig(config) {
      if (!config) throw new Error("ff-party-card: missing config");
      this._config = { ...DEFAULTS, ...config, members: Array.isArray(config.members) ? config.members : [] };
      this._sig = "";
      this._render();
    }

    set hass(hass) {
      this._hass = hass;
      this._render();
    }

    connectedCallback() {
      // Re-check now and then so the clock, sleep window and offline detection stay current.
      this._timer = setInterval(() => this._render(), 30000);
    }
    disconnectedCallback() {
      clearInterval(this._timer);
    }

    getCardSize() {
      return 2 + (this._config?.members?.length || 1) * 2;
    }
    getGridOptions() {
      return { columns: "full", min_columns: 6 };
    }

    static getConfigElement() {
      return document.createElement("ff-party-card-editor");
    }

    static getStubConfig(hass) {
      const ids = Object.keys(hass?.states || {});
      const bat = ids.find((i) => i.startsWith("sensor.") && i.endsWith("_battery_level"));
      const person = ids.find((i) => i.startsWith("person."));
      const m = { name: person ? hass.states[person].attributes.friendly_name || "Hero" : "Hero", job: "Red Mage" };
      if (person) m.person = person;
      if (bat) m.hp = bat;
      return { title: "Party", members: [m] };
    }

    _act(i, action) {
      const a = this._actions[i];
      if (!a) return;
      const cfg = a[`${action}_action`];
      if (action === "hold" && !cfg) return;
      if (cfg?.action === "none") return;
      this.dispatchEvent(
        new CustomEvent("hass-action", {
          bubbles: true,
          composed: true,
          detail: { config: { entity: a.entity, tap_action: a.tap_action, hold_action: a.hold_action }, action },
        })
      );
    }

    _model() {
      const c = this._config;
      const states = this._hass.states;
      const now = new Date();
      const hour = now.getHours();
      const ss = num(c.sleep_start, 22), se = num(c.sleep_end, 7);
      const inSleep = ss > se ? hour >= ss || hour < se : hour >= ss && hour < se;
      const actions = [];

      const members = c.members.map((raw, i) => {
        const m = normMember(raw || {}, c);
        const st = (id) => (id ? states[id] : undefined);
        const hpS = st(m.hp), mpS = st(m.mp), bs = st(m.battery_state), p = st(m.person);
        const d = st(m.dnd), ps = st(m.power_save);

        const frac = (s, lo, hi) => {
          const n = s ? parseFloat(s.state) : NaN;
          return isNaN(n) ? null : clamp((n - lo) / (hi - lo || 1), 0, 1);
        };
        const hpF = frac(hpS, num(m.hp_min, 0), num(m.hp_max, 100));
        const mpF = frac(mpS, num(m.mp_min, 0), num(m.mp_max, 100));

        const bsText = bs ? String(bs.state).toLowerCase() : "";
        const charging =
          bsText === "full" ||
          (bsText.includes("charging") && !bsText.includes("not") && !bsText.includes("dis"));

        const times = [hpS, mpS, bs, p]
          .filter(Boolean)
          .map((e) => new Date(e.last_updated || e.last_changed).getTime())
          .filter((t) => !isNaN(t));
        const last = times.length ? Math.max(...times) : 0;
        const offH = num(c.offline_hours, 6);
        const stale = offH > 0 && last > 0 && now - last > offH * 3600000;

        const ko = !!m.hp && (hpF == null || hpF <= 0 || (stale && !charging));
        const home = p ? p.state === "home" : null;

        let location = null;
        if (p && !["unknown", "unavailable"].includes(p.state)) {
          location = p.state === "home" ? c.home_label : p.state === "not_home" ? c.away_label : p.state;
        }

        const statuses = [];
        if (ko) statuses.push(["KO", "ko", null]);
        else {
          if (c.builtin_statuses !== false) {
            const dnd = isOn(d);
            const lowPower = isOn(ps) || bs?.attributes?.["Low Power Mode"] === true;
            const asleep = inSleep && home !== false && (charging || dnd);
            if (asleep) statuses.push(["Sleep", "sleep", null]);
            if (charging) statuses.push(["Regen", "regen", null]);
            if (dnd && !asleep) statuses.push(["Silence", "silence", null]);
            if (lowPower) statuses.push(["Slow", "slow", null]);
          }
          (Array.isArray(m.statuses) ? m.statuses : [])
            .filter((r) => r && r.entity && matchStatus(r, states))
            .forEach((r) => statuses.push([r.name || "???", "custom", toColor(r.color)]));
        }

        const hpPct = ko ? 0 : (hpF ?? 0) * 100;
        const note = (mode, s, f) =>
          mode === "value" && s ? fmtState(s) : mode === "percent" && f != null ? `${Math.round(f * 100)}%` : "";

        actions[i] = {
          entity: m.hp || m.person || m.mp,
          tap_action: m.tap_action || c.tap_action || { action: "more-info" },
          hold_action: m.hold_action || c.hold_action,
        };

        return {
          name: m.name || p?.attributes?.friendly_name || "???",
          job: m.job || "",
          image: m.image || (m.use_person_picture !== false && p?.attributes?.entity_picture) || "",
          hp: !m.hp ? null : ko ? 0 : Math.round((hpF ?? 0) * num(c.hp_display_max, 9999)),
          hpPct,
          hpClass: ko ? "ko" : !m.hp ? "" : hpPct <= num(c.critical, 15) ? "crit" : hpPct <= num(c.low, 30) ? "low" : "",
          mp: mpF == null ? null : Math.round(mpF * num(c.mp_display_max, 999)),
          mpPct: (mpF ?? 0) * 100,
          hpNote: ko ? "" : note(c.hp_note, hpS, hpF),
          mpNote: note(c.mp_note, mpS, mpF),
          charging: charging && !ko,
          ko,
          statuses,
          location,
        };
      });
      this._actions = actions;

      let cursorIdx = -1;
      if (c.cursor !== false) {
        let best = Infinity;
        members.forEach((m, i) => {
          if (!m.ko && m.hp != null && m.hpPct < best) { best = m.hpPct; cursorIdx = i; }
        });
      }

      let gil = null;
      if (c.gil) {
        const g = states[c.gil];
        if (!g) gil = "---";
        else if (c.gil_unit === false) {
          const n = parseFloat(g.state);
          gil = isNaN(n) ? g.state : (c.gil_decimals != null ? Number(n.toFixed(c.gil_decimals)) : n).toLocaleString();
        } else gil = fmtState(g, c.gil_decimals);
      }

      return {
        members,
        cursorIdx,
        gil,
        time: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        date: now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }),
      };
    }

    _row(m, i, cursorIdx) {
      const c = this._config;
      const portrait = m.image
        ? `<img src="${esc(m.image)}" alt="">`
        : `<span>${esc(m.name.trim().charAt(0).toUpperCase())}</span>`;
      const chips = m.statuses
        .map(([t, cls, color]) => `<span class="chip ${cls}"${color ? ` style="color:${esc(color)}"` : ""}>${esc(t)}</span>`)
        .join("");
      return `
        <div class="member ${m.ko ? "is-ko" : ""}" data-idx="${i}">
          <div class="cursor">${i === cursorIdx ? CURSOR : ""}</div>
          <div class="portrait">${portrait}</div>
          <div class="info">
            <div><span class="name">${esc(m.name)}</span>${m.job ? `<span class="job">${esc(m.job)}</span>` : ""}</div>
            <div class="statuses">${chips}</div>
            ${m.location ? `<div class="loc"><b>Location</b>${esc(m.location)}</div>` : ""}
          </div>
          <div class="stats">
            <div class="stat"><span class="lbl">${esc(c.hp_label)}</span><span class="num ${m.hpClass}">${m.hp == null ? "---" : m.hp}</span><span class="max">/${esc(c.hp_display_max)}</span></div>
            <div class="bar hpbar ${m.hpClass} ${m.charging ? "regen" : ""}"><i style="width:${m.hpPct}%"></i></div>
            ${m.hpNote ? `<div class="note">${esc(m.hpNote)}</div>` : ""}
            <div class="stat"><span class="lbl">${esc(c.mp_label)}</span><span class="num">${m.mp == null ? "---" : m.mp}</span><span class="max">/${esc(c.mp_display_max)}</span></div>
            <div class="bar mpbar"><i style="width:${m.mpPct}%"></i></div>
            ${m.mpNote ? `<div class="note">${esc(m.mpNote)}</div>` : ""}
          </div>
        </div>`;
    }

    _render() {
      if (!this._config || !this._hass) return;
      const model = this._model();
      const sig = JSON.stringify(model);
      if (sig === this._sig) return; // nothing changed, keep animations running smoothly
      this._sig = sig;
      const c = this._config;
      const font = resolveFont(c);
      const t = THEMES[c.theme] || THEMES.classic;
      const col = (key, themeKey) => toColor(c[key]) || t[themeKey];
      const vars = [
        `--ff-font:${font.family}`,
        `--ff-scale:${num(c.scale, 1)}`,
        `--ff-fscale:${font.size}`,
        `--ff-win-top:${col("color_window_top", "window_top")}`,
        `--ff-win-bottom:${col("color_window_bottom", "window_bottom")}`,
        `--ff-border:${col("color_border", "border")}`,
        `--ff-text:${col("color_text", "text")}`,
        `--ff-label:${col("color_label", "label")}`,
        `--ff-hp:${col("color_hp", "hp")}`,
        `--ff-mp:${col("color_mp", "mp")}`,
      ].join(";");

      const mode = footerMode(c);
      const footer =
        mode === "hidden"
          ? ""
          : `<div class="window footer">
              <span><span class="k">Time</span><span class="v">${esc(model.time)}</span></span>
              <span class="v">${esc(model.date)}</span>
              ${model.gil != null ? `<span><span class="k">${esc(c.gil_label)}</span><span class="v">${esc(model.gil)}</span></span>` : ""}
            </div>`;

      const body = model.members.length
        ? model.members.map((m, i) => this._row(m, i, model.cursorIdx)).join("")
        : `<div class="empty">No party members yet. Add one in the card editor.</div>`;

      this.shadowRoot.innerHTML = `
        <style>${CSS}</style>
        <ha-card>
          <div class="ff" style="${esc(vars)}">
            <div class="inner">
              ${mode === "top" ? footer : ""}
              <div class="window">
                ${c.title ? `<div class="title">${esc(c.title)}</div>` : ""}
                ${body}
              </div>
              ${mode === "bottom" ? footer : ""}
            </div>
          </div>
        </ha-card>`;
    }
  }

  // ───────────────────────── visual editor ─────────────────────────

  const LABELS = {
    title: "Title", theme: "Theme preset", footer: "Time bar", cursor: "Point the cursor at the lowest HP",
    gil: "Gil sensor (any entity)", gil_label: "Gil label", gil_decimals: "Gil decimals", gil_unit: "Show Gil unit",
    hp_label: "HP label", hp_display_max: "HP shown as out of", mp_label: "MP label", mp_display_max: "MP shown as out of",
    low: "Low HP warning (%)", critical: "Critical HP (%)", hp_note: "Text under HP bar", mp_note: "Text under MP bar",
    sleep_start: "Sleep starts (hour, 0-23)", sleep_end: "Sleep ends (hour, 0-23)", offline_hours: "KO after offline (hours, 0 = never)",
    home_label: "Home location text", away_label: "Away location text", builtin_statuses: "Built-in statuses (Regen, Sleep, Silence, Slow)",
    font: "Font", font_url: "Custom font file URL", scale: "Size",
    color_window_top: "Window top", color_window_bottom: "Window bottom", color_border: "Border", color_text: "Text",
    color_label: "Labels", color_hp: "HP bar", color_mp: "MP bar",
    name: "Name", job: "Job / subtitle", person: "Person (location + picture)", image: "Portrait image URL",
    hp: "HP sensor", hp_min: "Empty at", hp_max: "Full at", mp: "MP sensor", mp_min: "Empty at", mp_max: "Full at",
    battery_state: "Charging sensor (Regen)", dnd: "DND / Focus sensor (Silence)", power_save: "Power saving sensor (Slow)",
    statuses: "Custom statuses", tap_action: "Tap", hold_action: "Hold",
  };
  const HELPERS = {
    hp: "Usually the phone's battery level",
    hp_max: "Sensor value that counts as full (100 for battery %)",
    mp: "Storage %, steps, or any number sensor",
    mp_max: "Sensor value that counts as full (100 for %, 8000 for steps)",
    image: "e.g. /local/ff-party/player1.png. Leave blank to use the person's picture.",
    gil: "Shown in the time bar, e.g. free space on your NAS",
    font: "Pick a preset, or type the name of a font you've loaded yourself",
    font_url: "Optional. A .ttf / .woff / .woff2 file, e.g. /local/ff-party/myfont.ttf. Overrides the font above.",
  };
  const noteOptions = [
    { value: "none", label: "Nothing" },
    { value: "value", label: "Sensor value" },
    { value: "percent", label: "Percent" },
  ];
  const colorField = (name) => ({ name, selector: { color_rgb: {} } });

  const SCHEMA = {
    general: [
      { name: "title", selector: { text: {} } },
      {
        type: "grid", name: "", schema: [
          { name: "theme", selector: { select: { mode: "dropdown", options: Object.entries(THEMES).map(([k, v]) => ({ value: k, label: v.name })) } } },
          { name: "footer", selector: { select: { mode: "dropdown", options: [
            { value: "top", label: "Top" }, { value: "bottom", label: "Bottom" }, { value: "hidden", label: "Hidden" },
          ] } } },
        ],
      },
      { type: "grid", name: "", schema: [{ name: "gil", selector: { entity: {} } }, { name: "gil_label", selector: { text: {} } }] },
      { name: "cursor", selector: { boolean: {} } },
    ],
    theme: [
      { type: "grid", name: "", schema: [
        { name: "font", selector: { select: { mode: "dropdown", custom_value: true,
          options: Object.entries(FONTS).map(([k, v]) => ({ value: k, label: v.label })) } } },
        { name: "scale", selector: { number: { min: 0.5, max: 2, step: 0.05, mode: "slider" } } },
      ] },
      { name: "font_url", selector: { text: {} } },
      { type: "grid", name: "", schema: [
        colorField("color_window_top"), colorField("color_window_bottom"),
        colorField("color_border"), colorField("color_text"),
        colorField("color_label"), colorField("color_hp"), colorField("color_mp"),
      ] },
    ],
    advanced: [
      { type: "grid", name: "", schema: [
        { name: "hp_label", selector: { text: {} } },
        { name: "hp_display_max", selector: { number: { min: 1, mode: "box" } } },
        { name: "mp_label", selector: { text: {} } },
        { name: "mp_display_max", selector: { number: { min: 1, mode: "box" } } },
        { name: "hp_note", selector: { select: { mode: "dropdown", options: noteOptions } } },
        { name: "mp_note", selector: { select: { mode: "dropdown", options: noteOptions } } },
        { name: "low", selector: { number: { min: 0, max: 100, mode: "box", unit_of_measurement: "%" } } },
        { name: "critical", selector: { number: { min: 0, max: 100, mode: "box", unit_of_measurement: "%" } } },
        { name: "sleep_start", selector: { number: { min: 0, max: 23, mode: "box" } } },
        { name: "sleep_end", selector: { number: { min: 0, max: 23, mode: "box" } } },
        { name: "home_label", selector: { text: {} } },
        { name: "away_label", selector: { text: {} } },
        { name: "offline_hours", selector: { number: { min: 0, max: 72, mode: "box" } } },
        { name: "gil_decimals", selector: { number: { min: 0, max: 4, mode: "box" } } },
      ] },
      { name: "builtin_statuses", selector: { boolean: {} } },
      { name: "gil_unit", selector: { boolean: {} } },
    ],
    basics: [
      { type: "grid", name: "", schema: [{ name: "name", selector: { text: {} } }, { name: "job", selector: { text: {} } }] },
      { name: "person", selector: { entity: { domain: "person" } } },
      { name: "image", selector: { text: {} } },
    ],
    hp: [
      { name: "hp", selector: { entity: {} } },
      { type: "grid", name: "", schema: [
        { name: "hp_min", selector: { number: { mode: "box" } } },
        { name: "hp_max", selector: { number: { mode: "box" } } },
      ] },
    ],
    mp: [
      { name: "mp", selector: { entity: {} } },
      { type: "grid", name: "", schema: [
        { name: "mp_min", selector: { number: { mode: "box" } } },
        { name: "mp_max", selector: { number: { mode: "box" } } },
      ] },
    ],
    statuses: [
      { type: "grid", name: "", schema: [
        { name: "battery_state", selector: { entity: {} } },
        { name: "dnd", selector: { entity: {} } },
      ] },
      { name: "power_save", selector: { entity: {} } },
      { name: "statuses", selector: { object: {} } },
    ],
    actions: [
      { name: "tap_action", selector: { ui_action: {} } },
      { name: "hold_action", selector: { ui_action: {} } },
    ],
  };

  const STATUS_EXAMPLE = `- name: Haste
  entity: sensor.phone_detected_activity
  state: in_vehicle
  color: "#ffd45e"
- name: Berserk
  entity: sensor.phone_battery_temperature
  above: 40`;

  // Fill in display defaults so the form shows real values instead of blanks.
  const withDefaults = (c) => {
    const out = { ...c, footer: footerMode(c) };
    for (const [k, v] of Object.entries(DEFAULTS)) if (out[k] === undefined && v !== null) out[k] = v;
    return out;
  };
  const clean = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v) && !v.length && k !== "members") continue;
      out[k] = v;
    }
    return out;
  };

  class FFPartyCardEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._forms = [];
      this._open = new Set([0]);
      this._shape = -1;
    }

    setConfig(config) {
      const c = { ...config };
      c.members = (Array.isArray(config.members) ? config.members : []).map((m) => normMember(m || {}, config));
      this._config = c;
      if (c.members.length !== this._shape) this._build();
      else this._refresh();
    }

    set hass(hass) {
      this._hass = hass;
      this._forms.forEach((f) => (f.el.hass = hass));
      if (this._shape === -1) this._build();
    }

    connectedCallback() {
      this._load();
    }

    // ha-form is lazy-loaded by HA; borrow a built-in card's editor to make sure it's registered.
    async _load() {
      if (!customElements.get("ha-form") && window.loadCardHelpers) {
        try {
          const helpers = await window.loadCardHelpers();
          const card = await helpers.createCardElement({ type: "entities", entities: [] });
          await card.constructor.getConfigElement();
        } catch (e) { /* fall through */ }
      }
      this._ready = true;
      this._build();
    }

    _fire() {
      this.dispatchEvent(
        new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true })
      );
    }

    _setCard(v) {
      const next = clean({ ...this._config, ...v, members: this._config.members });
      delete next.show_footer;
      delete next.footer_position;
      // Drop values that just match the defaults so the YAML stays tidy.
      for (const [k, d] of Object.entries(DEFAULTS)) if (next[k] === d) delete next[k];
      if (next.footer === "top") delete next.footer;
      this._config = next;
      this._fire();
    }

    _setMember(i, v) {
      const members = [...this._config.members];
      members[i] = clean({ ...members[i], ...v });
      this._config = { ...this._config, members };
      const label = this.shadowRoot.querySelector(`details.member[data-idx="${i}"] .mname`);
      if (label) label.textContent = members[i].name || `Member ${i + 1}`;
      this._fire();
    }

    _form(container, schema, get, set) {
      const f = document.createElement("ha-form");
      f.hass = this._hass;
      f.schema = schema;
      f.data = get();
      f.computeLabel = (s) => LABELS[s.name] ?? s.name;
      f.computeHelper = (s) => HELPERS[s.name];
      f.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        set(ev.detail.value);
      });
      container.appendChild(f);
      this._forms.push({ el: f, get });
    }

    _refresh() {
      this._forms.forEach((f) => (f.el.data = f.get()));
    }

    _build() {
      if (!this._config || !this._hass || !this._ready) return;
      this._forms = [];
      this._shape = this._config.members.length;
      const root = this.shadowRoot;
      root.innerHTML = `
        <style>
          .ed { display: flex; flex-direction: column; gap: 12px; }
          h3 { margin: 4px 0 0; font-size: 1.05em; font-weight: 500; }
          h4 { margin: 12px 0 2px; font-size: .78em; text-transform: uppercase; letter-spacing: .06em; color: var(--secondary-text-color); font-weight: 500; }
          details { border: 1px solid var(--divider-color, #8884); border-radius: 10px; padding: 0 14px; }
          summary { cursor: pointer; padding: 12px 0; display: flex; align-items: center; gap: 8px; font-weight: 500; list-style: none; }
          summary::-webkit-details-marker { display: none; }
          summary::before { content: "▸"; display: inline-block; transition: transform .15s; color: var(--secondary-text-color); }
          details[open] > summary::before { transform: rotate(90deg); }
          .tools { margin-left: auto; display: flex; gap: 4px; }
          .body { padding-bottom: 14px; }
          button {
            background: var(--secondary-background-color, #8882); color: var(--primary-text-color);
            border: 1px solid var(--divider-color, #8884); border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit;
          }
          button:disabled { opacity: .35; cursor: default; }
          button.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border: none; padding: 8px 14px; align-self: flex-start; }
          .hint { font-size: .85em; color: var(--secondary-text-color); margin: 6px 0 0; }
          pre { background: var(--secondary-background-color, #8882); padding: 8px 10px; border-radius: 6px; font-size: .8em; overflow-x: auto; margin: 4px 0 0; }
          .reset { margin-top: 10px; }
        </style>
        <div class="ed">
          <div id="general"></div>
          <details id="d-theme"><summary>Look &amp; theme</summary><div class="body">
            <div id="theme"></div>
            <p class="hint">Leave a color unset to use the theme preset.</p>
            <button class="reset" id="reset-colors">Reset colors to preset</button>
          </div></details>
          <details id="d-adv"><summary>Advanced</summary><div class="body"><div id="advanced"></div></div></details>
          <h3>Party members</h3>
          <div id="members" style="display:flex;flex-direction:column;gap:8px"></div>
          <button class="primary" id="add">+ Add member</button>
        </div>`;

      const cardData = () => withDefaults(this._config);
      const setCard = (v) => this._setCard(v);
      this._form(root.getElementById("general"), SCHEMA.general, cardData, setCard);
      this._form(root.getElementById("theme"), SCHEMA.theme, cardData, setCard);
      this._form(root.getElementById("advanced"), SCHEMA.advanced, cardData, setCard);

      root.getElementById("reset-colors").addEventListener("click", () => {
        const next = { ...this._config };
        Object.keys(next).filter((k) => k.startsWith("color_")).forEach((k) => delete next[k]);
        this._config = next;
        this._refresh();
        this._fire();
      });

      const list = root.getElementById("members");
      const n = this._config.members.length;
      this._config.members.forEach((m, i) => {
        const d = document.createElement("details");
        d.className = "member";
        d.dataset.idx = i;
        d.open = this._open.has(i);
        d.addEventListener("toggle", () => (d.open ? this._open.add(i) : this._open.delete(i)));
        d.innerHTML = `
          <summary>
            <span class="mname"></span>
            <span class="tools">
              <button data-a="up" title="Move up" ${i === 0 ? "disabled" : ""}>▲</button>
              <button data-a="down" title="Move down" ${i === n - 1 ? "disabled" : ""}>▼</button>
              <button data-a="del" title="Remove">✕</button>
            </span>
          </summary>
          <div class="body">
            <h4>Basics</h4><div data-s="basics"></div>
            <h4>HP</h4><div data-s="hp"></div>
            <h4>MP</h4><div data-s="mp"></div>
            <h4>Statuses</h4><div data-s="statuses"></div>
            <p class="hint">Custom statuses: each needs a name and entity, plus a state to match, or above / below for numbers.</p>
            <pre>${esc(STATUS_EXAMPLE)}</pre>
            <h4>When tapped</h4><div data-s="actions"></div>
          </div>`;
        d.querySelector(".mname").textContent = m.name || `Member ${i + 1}`;
        d.querySelector(".tools").addEventListener("click", (e) => {
          const btn = e.target.closest("button");
          e.preventDefault();
          e.stopPropagation();
          if (!btn || btn.disabled) return;
          this._memberTool(i, btn.dataset.a);
        });
        const get = () => this._config.members[i] || {};
        const set = (v) => this._setMember(i, v);
        for (const sec of ["basics", "hp", "mp", "statuses", "actions"]) {
          this._form(d.querySelector(`[data-s="${sec}"]`), SCHEMA[sec], get, set);
        }
        list.appendChild(d);
      });

      root.getElementById("add").addEventListener("click", () => {
        const members = [...this._config.members, { name: `Player ${n + 1}`, hp_max: 100 }];
        this._config = { ...this._config, members };
        this._open = new Set([members.length - 1]);
        this._build();
        this._fire();
      });
    }

    _memberTool(i, action) {
      const members = [...this._config.members];
      if (action === "del") {
        members.splice(i, 1);
        this._open = new Set();
      } else {
        const j = action === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= members.length) return;
        [members[i], members[j]] = [members[j], members[i]];
        this._open = new Set([j]);
      }
      this._config = { ...this._config, members };
      this._build();
      this._fire();
    }
  }

  // ───────────────────────── register ─────────────────────────

  if (!customElements.get("ff-party-card-editor")) customElements.define("ff-party-card-editor", FFPartyCardEditor);
  if (!customElements.get("ff-party-card")) {
    customElements.define("ff-party-card", FFPartyCard);
    window.customCards = window.customCards || [];
    window.customCards.push({
      type: "ff-party-card",
      name: "FF Party Card",
      description: "Final Fantasy party menu: HP, MP and status effects from any sensors.",
      preview: true,
    });
    console.info(`%c FF-PARTY-CARD %c v${VERSION} `, "background:#2a379e;color:#fff", "background:#e9ecf5;color:#2a379e");
  }
})();
