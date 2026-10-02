// Delegated UI event handling.
//
// The CSP (server-security.cjs) leaves helmet's `script-src-attr 'none'` in
// place, so inline onclick=/oninput= attributes never run. Elements declare
// what they do instead:
//
//   data-click="name"     run on click   (also data-input / data-change)
//   data-args='[...]'     optional JSON array of arguments
//   data-pass-el          optional: append the element as the last argument
//
// `name` is resolved first against actions registered with
// GumballActions.define(name, (el, event, ...args) => ...), then as a global
// function called with (...args[, el]). Only the innermost element carrying
// the attribute fires, which stands in for the old event.stopPropagation()
// on nested clickables.
(function () {
  const defined = Object.create(null);

  function define(name, fn) { defined[name] = fn; }

  function run(el, attr, ev) {
    const name = el.dataset[attr];
    let args = [];
    if (el.dataset.args) {
      try { args = JSON.parse(el.dataset.args); }
      catch (e) { console.error("data-args is not valid JSON on", el, e); return; }
    }
    if (defined[name]) return defined[name](el, ev, ...args);
    const fn = window[name];
    if (typeof fn !== "function") { console.error(`No action or global function "${name}"`, el); return; }
    if ("passEl" in el.dataset) args.push(el);
    return fn.apply(el, args);
  }

  for (const [type, attr] of [["click", "click"], ["input", "input"], ["change", "change"]]) {
    document.addEventListener(type, (ev) => {
      const el = ev.target.closest && ev.target.closest(`[data-${attr}]`);
      if (!el || el.disabled) return;
      run(el, attr, ev);
    });
  }

  // Escape a value for use inside a double-quoted HTML attribute — for
  // building data-args in template strings: data-args="${actArgs(a, b)}".
  function actArgs(...args) {
    return JSON.stringify(args)
      .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
      .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const menu = () => document.getElementById("mobileMenu");
  define("menuOpen",  () => menu().classList.add("open"));
  define("menuClose", () => menu().classList.remove("open"));
  define("menuConnectWallet", () => { menu().classList.remove("open"); window.connectWallet(); });
  define("toggleParentOpen", (el) => el.parentElement.classList.toggle("open"));
  // data-click="hide" data-args='["modalId"]'
  define("hide", (el, ev, id) => { document.getElementById(id).style.display = "none"; });
  // On a modal backdrop: close only when the backdrop itself is clicked.
  define("hideIfBackdrop", (el, ev) => { if (ev.target === el) el.style.display = "none"; });

  window.GumballActions = { define };
  window.actArgs = actArgs;
})();
