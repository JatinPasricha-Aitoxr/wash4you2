(function () {
  "use strict";
  var form = document.getElementById("form"), err = document.getElementById("err"), go = document.getElementById("go");
  form.addEventListener("submit", function (e) {
    e.preventDefault(); err.textContent = ""; go.disabled = true;
    fetch("/admin/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: form.username.value, password: form.password.value }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (r) { if (r.ok) { location.href = "/admin"; } else { err.textContent = r.d.error || "Sign in failed."; go.disabled = false; } })
      .catch(function () { err.textContent = "Could not reach the server."; go.disabled = false; });
  });
})();
