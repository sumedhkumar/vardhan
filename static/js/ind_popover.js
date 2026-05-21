/* IndicatorPopover — list of every registered indicator with a toggle and
 * an inline parameter editor. Lives inside one Pane.
 *
 * Public API:
 *   const ip = new IndicatorPopover(rootEl, {
 *     manager:  IndicatorManager,
 *     onChange: () => persist()
 *   });
 *   ip.toggle() / ip.open() / ip.close()
 *   ip.destroy()
 */
(function () {
  "use strict";

  class IndicatorPopover {
    constructor(paneRoot, opts) {
      this.paneRoot = paneRoot;
      this.manager  = opts.manager;
      this.onChange = opts.onChange || (() => {});
      this._buildDom();
      this._render();
    }

    _buildDom() {
      const el = document.createElement("div");
      el.className = "ind-popover";
      el.innerHTML = `
        <header class="ind-popover__head">
          <h4>Indicators</h4>
          <button type="button" class="ind-close" aria-label="close">&times;</button>
        </header>
        <div class="ind-popover__body">
          <div class="ind-group" data-group="overlays">
            <h5>Overlays</h5>
            <div class="ind-list"></div>
          </div>
          <div class="ind-group" data-group="oscillators">
            <h5>Oscillators</h5>
            <div class="ind-list"></div>
          </div>
        </div>`;
      this.paneRoot.appendChild(el);
      this.el = el;
      el.querySelector(".ind-close").addEventListener("click", () => this.close());
    }

    _render() {
      const overlays    = window.Indicators.overlays();
      const oscillators = window.Indicators.oscillators();
      this._renderGroup("overlays", overlays);
      this._renderGroup("oscillators", oscillators);
    }

    _renderGroup(group, list) {
      const root = this.el.querySelector(`.ind-group[data-group="${group}"] .ind-list`);
      root.innerHTML = "";
      for (const ind of list) {
        const enabled = this.manager.isEnabled(ind.id);
        const params = enabled
          ? this.manager.params(ind.id)
          : Object.assign({}, ind.defaults || {});
        const row = document.createElement("div");
        row.className = "ind-row" + (enabled ? " is-on" : "");
        row.innerHTML = `
          <label class="ind-row__main">
            <input type="checkbox" data-id="${ind.id}" ${enabled ? "checked" : ""}>
            <span class="ind-name">${ind.name}</span>
          </label>
          <button type="button" class="ind-toggle-params" aria-label="parameters">⚙</button>
          <div class="ind-params" hidden></div>`;

        const cb = row.querySelector("input[type=checkbox]");
        cb.addEventListener("change", () => {
          if (cb.checked) this.manager.enable(ind.id, params);
          else            this.manager.disable(ind.id);
          row.classList.toggle("is-on", cb.checked);
          // If the manager refused to enable (oscillator cap hit), revert.
          if (cb.checked && !this.manager.isEnabled(ind.id)) {
            cb.checked = false;
            row.classList.remove("is-on");
          }
          this.onChange();
        });

        const paramsEl = row.querySelector(".ind-params");
        const gear = row.querySelector(".ind-toggle-params");
        if (!ind.paramSpec || ind.paramSpec.length === 0) {
          gear.disabled = true;
          gear.style.opacity = 0.3;
        } else {
          gear.addEventListener("click", () => {
            paramsEl.hidden = !paramsEl.hidden;
            if (!paramsEl.hidden && !paramsEl.dataset.built) {
              this._buildParamForm(paramsEl, ind, params);
              paramsEl.dataset.built = "1";
            }
          });
        }
        root.appendChild(row);
      }
    }

    _buildParamForm(root, ind, params) {
      for (const spec of ind.paramSpec) {
        const id = `ip-${ind.id}-${spec.key}`;
        const row = document.createElement("div");
        row.className = "ind-param";
        if (spec.type === "color") {
          row.innerHTML = `<label for="${id}">${spec.key}</label>
            <input id="${id}" type="color" value="${params[spec.key] || spec.default}">`;
        } else {
          const min  = spec.min  != null ? `min="${spec.min}"` : "";
          const max  = spec.max  != null ? `max="${spec.max}"` : "";
          const step = spec.type === "float" ? `step="0.1"` : `step="1"`;
          row.innerHTML = `<label for="${id}">${spec.key}</label>
            <input id="${id}" type="number" ${min} ${max} ${step} value="${params[spec.key]}">`;
        }
        const inp = row.querySelector("input");
        inp.addEventListener("change", () => {
          let v;
          if (spec.type === "color")     v = inp.value;
          else if (spec.type === "float") v = parseFloat(inp.value);
          else                            v = parseInt(inp.value, 10);
          params[spec.key] = v;
          // If currently enabled, restart with new params.
          if (this.manager.isEnabled(ind.id)) {
            this.manager.disable(ind.id);
            this.manager.enable(ind.id, params);
          }
          this.onChange();
        });
        root.appendChild(row);
      }
    }

    open()   { this.el.classList.add("is-open"); }
    close()  { this.el.classList.remove("is-open"); }
    toggle() { this.el.classList.toggle("is-open"); }

    destroy() {
      if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }
  }

  window.IndicatorPopover = IndicatorPopover;
})();
