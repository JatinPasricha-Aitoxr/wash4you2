/* Adds the session's CSRF token to every same-origin state-changing request.
   Loaded before the editor and admin scripts. */
(function () {
  "use strict";
  var token = null, pending = null;
  var orig = window.fetch.bind(window);
  function getToken() {
    if (token) return Promise.resolve(token);
    if (!pending) pending = orig("/admin/api/me", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : {}; }).then(function (d) { token = d.csrf || ""; pending = null; return token; });
    return pending;
  }
  window.__csrfReset = function (t) { token = t || null; };
  window.fetch = function (input, init) {
    init = init || {};
    var method = String(init.method || (input && input.method) || "GET").toUpperCase();
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var same = url.charAt(0) === "/" || url.indexOf(location.origin) === 0;
    if (!same || method === "GET" || method === "HEAD" || url.indexOf("/admin/api/login") >= 0) return orig(input, init);
    return getToken().then(function (t) {
      var h = new Headers(init.headers || {}); h.set("X-CSRF-Token", t);
      init.headers = h; init.credentials = "same-origin";
      return orig(input, init);
    });
  };
})();
