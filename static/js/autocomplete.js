/* Autocomplete — symbol search dropdown attached to a single <input>.
 *
 * Usage:
 *   const ac = new SymbolAutocomplete(inputEl, {
 *     getSource: () => "yfinance",
 *     onPick:    (row) => console.log(row),
 *   });
 *   ac.destroy();
 *
 * Behaviour:
 *   - Debounced (150 ms) calls to /api/symbols?source=&q=
 *   - In-memory per-(source,q) cache for the page session
 *   - For "small" sources (forex, hyperliquid) we preload the full list once
 *     and filter locally for instant feedback
 *   - Keyboard: ArrowDown/Up navigate; Enter commits; Escape closes
 *   - Click commits on mousedown so the input doesn't lose focus
 */
(function () {
  "use strict";

  const DEBOUNCE_MS = 150;
  const SMALL_SOURCES = new Set(["forex", "hyperliquid"]);
  const _smallCache = new Map();   // source -> rows
  const _searchCache = new Map();  // `${source}::${q}` -> rows

  async function fetchAll(source) {
    if (_smallCache.has(source)) return _smallCache.get(source);
    const url = `/api/symbols?source=${encodeURIComponent(source)}&q=&limit=200`;
    try {
      const r = await fetch(url);
      if (!r.ok) return [];
      const data = await r.json();
      const rows = data.matches || [];
      _smallCache.set(source, rows);
      return rows;
    } catch (_) { return []; }
  }

  async function searchRemote(source, q) {
    const key = `${source}::${q.toLowerCase()}`;
    if (_searchCache.has(key)) return _searchCache.get(key);
    const url = `/api/symbols?source=${encodeURIComponent(source)}&q=${encodeURIComponent(q)}&limit=50`;
    try {
      const r = await fetch(url);
      if (!r.ok) return [];
      const data = await r.json();
      const rows = data.matches || [];
      _searchCache.set(key, rows);
      return rows;
    } catch (_) { return []; }
  }

  function localFilter(rows, q) {
    if (!q) return rows.slice(0, 50);
    const ql = q.toLowerCase();
    const exact = [], prefix = [], contains = [];
    for (const r of rows) {
      const s = (r.symbol || "").toLowerCase();
      const n = (r.name || "").toLowerCase();
      if (s === ql || s.split(".")[0] === ql) exact.push(r);
      else if (s.startsWith(ql) || n.split(/\s+/).some(w => w.startsWith(ql))) prefix.push(r);
      else if (s.includes(ql) || n.includes(ql)) contains.push(r);
    }
    return [...exact, ...prefix, ...contains].slice(0, 50);
  }

  function highlight(text, q) {
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return text;
    return (
      text.slice(0, idx) +
      `<mark>${text.slice(idx, idx + q.length)}</mark>` +
      text.slice(idx + q.length)
    );
  }

  class SymbolAutocomplete {
    constructor(input, opts) {
      this.input    = input;
      this.getSource = opts.getSource;
      this.onPick    = opts.onPick || (() => {});
      this._open     = false;
      this._items    = [];
      this._cursor   = -1;
      this._debounce = null;
      this._lastQ    = null;

      this._buildDom();
      this._wire();
    }

    _buildDom() {
      this.dropdown = document.createElement("div");
      this.dropdown.className = "ac-dropdown";
      this.dropdown.setAttribute("role", "listbox");
      // Append directly to body so it can escape pane overflow:hidden.
      document.body.appendChild(this.dropdown);
    }

    _wire() {
      this._onInput   = () => this._scheduleQuery();
      this._onFocus   = () => this._scheduleQuery();
      this._onBlur    = () => setTimeout(() => this.close(), 100);
      this._onKey     = (e) => this._handleKey(e);

      this.input.addEventListener("input", this._onInput);
      this.input.addEventListener("focus", this._onFocus);
      this.input.addEventListener("blur",  this._onBlur);
      this.input.addEventListener("keydown", this._onKey);
    }

    _scheduleQuery() {
      if (this._debounce) clearTimeout(this._debounce);
      const q = this.input.value.trim();
      if (q === this._lastQ && this._open) return;
      this._lastQ = q;
      this._debounce = setTimeout(() => this._runQuery(q), DEBOUNCE_MS);
    }

    async _runQuery(q) {
      const source = this.getSource();
      let rows;
      if (SMALL_SOURCES.has(source)) {
        const all = await fetchAll(source);
        rows = localFilter(all, q);
      } else {
        rows = await searchRemote(source, q);
      }
      this._render(rows, q);
    }

    _render(rows, q) {
      this._items  = rows;
      this._cursor = rows.length ? 0 : -1;

      if (!rows.length) {
        this.dropdown.innerHTML = `<div class="ac-empty">No matches</div>`;
      } else {
        const html = rows.map((r, i) => {
          const sym = highlight(r.symbol || "", q);
          const name = r.name ? `<span class="ac-name">${highlight(r.name, q)}</span>` : "";
          const ex   = r.exchange ? `<span class="ac-ex">${r.exchange}</span>` : "";
          return `<div class="ac-row${i === 0 ? " is-selected" : ""}" data-idx="${i}" role="option">
            <span class="ac-sym">${sym}</span>${name}${ex}
          </div>`;
        }).join("");
        this.dropdown.innerHTML = html;
      }
      this._position();
      this.open();

      // Mousedown (not click) so the input keeps focus during selection.
      for (const el of this.dropdown.querySelectorAll(".ac-row")) {
        el.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          const idx = parseInt(el.dataset.idx, 10);
          this._commit(idx);
        });
      }
    }

    _position() {
      const r = this.input.getBoundingClientRect();
      this.dropdown.style.left   = `${r.left + window.scrollX}px`;
      this.dropdown.style.top    = `${r.bottom + window.scrollY + 2}px`;
      this.dropdown.style.minWidth = `${Math.max(280, r.width)}px`;
    }

    _handleKey(e) {
      if (!this._open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        this._scheduleQuery();
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); this._move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); this._move(-1); }
      else if (e.key === "Enter" && this._open && this._cursor >= 0) {
        e.preventDefault(); this._commit(this._cursor);
      } else if (e.key === "Escape") {
        this.close();
      }
    }

    _move(delta) {
      if (!this._items.length) return;
      this._cursor = (this._cursor + delta + this._items.length) % this._items.length;
      for (const el of this.dropdown.querySelectorAll(".ac-row")) {
        el.classList.toggle("is-selected", parseInt(el.dataset.idx, 10) === this._cursor);
      }
      const sel = this.dropdown.querySelector(".ac-row.is-selected");
      if (sel) sel.scrollIntoView({ block: "nearest" });
    }

    _commit(idx) {
      const row = this._items[idx];
      if (!row) return;
      this.input.value = row.symbol;
      this.close();
      this.onPick(row);
    }

    open()  { this._open = true;  this.dropdown.classList.add("is-open");  this._position(); }
    close() { this._open = false; this.dropdown.classList.remove("is-open"); }

    destroy() {
      this.input.removeEventListener("input", this._onInput);
      this.input.removeEventListener("focus", this._onFocus);
      this.input.removeEventListener("blur",  this._onBlur);
      this.input.removeEventListener("keydown", this._onKey);
      if (this.dropdown && this.dropdown.parentNode) {
        this.dropdown.parentNode.removeChild(this.dropdown);
      }
    }
  }

  window.SymbolAutocomplete = SymbolAutocomplete;
})();
