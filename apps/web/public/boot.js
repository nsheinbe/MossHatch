/* Boot sentinel. External classic script (no inline script under the enforced CSP), parser-blocking,
   placed before the module script so the listeners exist before the app runs. Uses textContent only. */
(function () {
  var d = document, root = d.documentElement;
  function panel(title, msg) {
    var p = d.getElementById("boot-panel");
    if (!p) return;
    var t = d.getElementById("boot-title"), m = d.getElementById("boot-msg");
    if (t) t.textContent = title;
    if (m) m.textContent = msg;
    p.hidden = false;
  }
  var gl2 = false;
  try { gl2 = !!d.createElement("canvas").getContext("webgl2"); } catch (e) { gl2 = false; }
  root.setAttribute("data-gl2", gl2 ? "1" : "0");
  var ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  function show() {
    if (root.getAttribute("data-booted")) return;
    if (!gl2) {
      panel("This browser can't light the lanterns.",
        ios ? "Mosshatch needs WebGL 2, which arrives with iOS 15. Update iOS, or use the search below."
            : "Mosshatch needs WebGL 2 to draw the grove. Turn on hardware acceleration, try another browser, or use the search below.");
    } else {
      panel("The grove didn't load.", "Something stopped the page from starting. Reload to try again. The prices below still work.");
    }
  }
  if (!gl2) d.addEventListener("DOMContentLoaded", show);
  window.addEventListener("error", function (ev) {
    var t = ev && ev.target;
    if (t && t.tagName === "SCRIPT") d.addEventListener("DOMContentLoaded", show), show();
  }, true);
  window.setTimeout(function () { if (!root.getAttribute("data-booted") && gl2) show(); }, 12000);
})();
