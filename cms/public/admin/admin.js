/* Wash4You admin dashboard. All DOM is built with textContent (no innerHTML on data). */
(function () {
  "use strict";
  var main = document.getElementById("main"), me = null;
  function h(tag, attrs) {
    var e = document.createElement(tag); attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k]; if (v == null || v === false) return;
      if (k === "class") e.className = v; else if (k === "text") e.textContent = v;
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v);
    });
    (function add(list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i]; if (c == null || c === false) continue;
        if (Array.isArray(c) || (typeof c === "object" && !c.nodeType && c.length != null)) add(c);
        else e.append(c.nodeType ? c : document.createTextNode(String(c)));
      }
    })(Array.prototype.slice.call(arguments, 2));
    return e;
  }
  function api(path, body) {
    var opt = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    return fetch(path, opt).then(function (r) {
      if (r.status === 401) { location.href = "/admin/login"; return new Promise(function () {}); }
      return r.json().then(function (d) { if (!r.ok) { var e = new Error(d.error || ("Error " + r.status)); e.data = d; throw e; } return d; });
    });
  }
  var tt; function toast(msg, bad) { var t = document.getElementById("toast"); t.textContent = msg; t.className = "toast on" + (bad ? " err" : ""); clearTimeout(tt); tt = setTimeout(function () { t.className = "toast"; }, 3600); }
  function fail(e) { toast(e.message || "Something went wrong", true); }
  function when(ms) { return ms ? new Date(ms).toLocaleString() : "never"; }
  function readFile(f) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(f); }); }
  function modal(node) { var mb = document.getElementById("mb"), m = document.getElementById("modal"); m.replaceChildren(node); mb.hidden = false; mb.onclick = function (e) { if (e.target === mb) closeModal(); }; }
  function closeModal() { document.getElementById("mb").hidden = true; }
  function field(label, input) { return h("div", { class: "f" }, h("label", { text: label }), input); }

  var VIEWS = {};
  function show(v) {
    Array.prototype.forEach.call(document.querySelectorAll("#nav button"), function (b) { b.classList.toggle("is-on", b.dataset.v === v); });
    main.replaceChildren(h("p", { class: "empty", text: "Loading..." }));
    VIEWS[v]().catch(fail);
    try { history.replaceState(null, "", "#" + v); } catch (e) { /* ignore */ }
  }
  document.getElementById("nav").addEventListener("click", function (e) { var b = e.target.closest("button[data-v]"); if (b) show(b.dataset.v); });

  // ---------------------------------------------------------------- overview
  VIEWS.overview = function () {
    return api("/admin/api/overview").then(function (o) {
      var card = function (n, l) { return h("div", { class: "card" }, h("b", { text: String(n) }), h("span", { text: l })); };
      var rows = o.activity.map(function (a) { return h("tr", {}, h("td", { text: when(a.at) }), h("td", { text: a.by || "-" }), h("td", { text: a.action.replace(/_/g, " ") }), h("td", { text: a.detail })); });
      main.replaceChildren(
        h("div", { class: "top" }, h("h1", { text: "Overview" }), h("span", { class: "sp" }),
          h("a", { class: "btn btn--primary", href: "/studio" }, "Open visual editor"), h("a", { class: "btn", href: o.siteUrl, target: "_blank", rel: "noopener" }, "View live site")),
        h("div", { class: "cards" }, card(o.pages, "Editable pages"), card(o.drafts, "Unpublished changes"), card(o.media, "Images in library"), card(o.revisions, "Published versions")),
        h("div", { class: "panel" }, h("h2", { text: "Status" }),
          h("p", { text: o.lastPublish ? "Last published " + when(o.lastPublish.at) + ": " + o.lastPublish.message : "Nothing has been published from the admin yet." }),
          h("p", { class: "status" + (o.drafts ? " warn" : ""), text: o.drafts ? o.drafts + " file(s) staged as drafts. Open Drafts & publishing to review and publish." : "No unpublished changes." }),
          h("p", { class: "status" }, "Editor build: " + (o.editSite.ready ? "ready (" + when(o.editSite.builtAt) + ")" : "not downloaded yet. Use Drafts & publishing > Refresh editor build."), " Content source: " + o.repoDriver)),
        h("div", { class: "panel" }, h("h2", { text: "Recent activity" }), rows.length ? h("table", {}, h("tbody", {}, rows)) : h("p", { class: "empty", text: "No activity yet." })));
    });
  };

  // ------------------------------------------------------------------- pages
  VIEWS.pages = function () {
    return api("/admin/api/studio/pages").then(function (d) {
      var q = h("input", { type: "search", placeholder: "Search pages...", class: "grow" }), list = h("div");
      function draw() {
        var s = q.value.toLowerCase(), groups = {};
        d.pages.filter(function (p) { return !s || p.path.toLowerCase().indexOf(s) >= 0; }).forEach(function (p) { (groups[p.group] = groups[p.group] || []).push(p); });
        var out = Object.keys(groups).map(function (g) {
          var rows = groups[g].slice(0, 150).map(function (p) {
            return h("tr", {}, h("td", { text: p.path }), h("td", {}, h("a", { class: "btn", href: "/studio?p=" + encodeURIComponent(p.path) }, "Edit visually"), " ", h("button", { class: "btn", onclick: function () { seoFor(p.path); } }, "SEO")));
          });
          return h("div", { class: "panel" }, h("h2", { text: g + " (" + groups[g].length + ")" }), h("table", {}, h("tbody", {}, rows)));
        });
        list.replaceChildren.apply(list, out.length ? out : [h("p", { class: "empty", text: "No pages match." })]);
      }
      q.addEventListener("input", draw);
      main.replaceChildren(h("div", { class: "top" }, h("h1", { text: "Pages & editor" })), h("div", { class: "row" }, q), list); draw();
    });
  };

  // ------------------------------------------------------------------- media
  VIEWS.media = function () {
    var state = { q: "", folder: "", offset: 0, sel: null };
    var grid = h("div", { class: "media" }), side = h("div", { class: "panel" }), q = h("input", { type: "search", placeholder: "Search by name or description...", class: "grow" }),
      folder = h("select"), file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml", hidden: true }), count = h("span", { class: "status" });
    function load() {
      return api("/admin/api/media?q=" + encodeURIComponent(state.q) + "&folder=" + encodeURIComponent(state.folder) + "&limit=120").then(function (d) {
        if (!folder.options.length) { folder.append(h("option", { value: "", text: "All folders" })); d.folders.forEach(function (f) { folder.append(h("option", { value: f, text: f || "(root)" })); }); }
        count.textContent = d.total + " image(s)";
        grid.replaceChildren.apply(grid, d.items.map(function (m) {
          return h("button", { class: "tile" + (state.sel && state.sel.path === m.path ? " is-on" : ""), onclick: function () { state.sel = m; load(); detail(); } },
            h("img", { src: "/" + m.url, alt: m.alt, loading: "lazy" }), h("span", { text: (m.draft ? "Draft: " : "") + m.name }));
        }));
        if (!d.items.length) grid.replaceChildren(h("p", { class: "empty", text: "No images found." }));
      });
    }
    function detail() {
      var m = state.sel; if (!m) { side.replaceChildren(h("h2", { text: "Details" }), h("p", { class: "empty", text: "Select an image." })); return; }
      var alt = h("input", { value: m.alt, placeholder: "Describe the image for screen readers and SEO" }), rep = h("input", { type: "file", accept: "image/*", hidden: true });
      rep.addEventListener("change", function () { if (!rep.files[0]) return; readFile(rep.files[0]).then(function (u) { return api("/admin/api/media/replace", { path: m.path, dataUrl: u }); }).then(function () { toast("Replaced. Publish to make it live."); load(); }).catch(fail); });
      side.replaceChildren(h("h2", { text: m.name }), h("img", { src: "/" + m.url, alt: m.alt, style: "max-width:100%;max-height:200px;display:block;margin-bottom:10px" }),
        h("p", { class: "status" }, m.path, " ", h("span", { class: "badge" + (m.draft ? " draft" : ""), text: m.draft ? "draft" : "published" })), field("Alt text", alt),
        h("div", { class: "row", style: "margin-top:12px" },
          h("button", { class: "btn btn--primary", onclick: function () { api("/admin/api/media/meta", { path: m.path, alt: alt.value }).then(function () { m.alt = alt.value; toast("Saved"); }).catch(fail); } }, "Save alt text"),
          h("button", { class: "btn", onclick: function () { rep.click(); } }, "Replace file"), rep,
          h("button", { class: "btn", onclick: function () { api("/admin/api/media/refs?path=" + encodeURIComponent(m.path)).then(function (r) { toast(r.refs.length ? "Used in: " + r.refs.join(", ") : "Not used anywhere."); }).catch(fail); } }, "Where used?"),
          h("button", { class: "btn btn--danger", onclick: function () { if (!confirm("Delete this image?")) return; api("/admin/api/media/delete", { path: m.path }).then(function () { state.sel = null; toast("Deleted (publish to apply)."); load(); detail(); }).catch(function (e) { fail(e); }); } }, "Delete")));
    }
    file.addEventListener("change", function () { if (!file.files[0]) return; readFile(file.files[0]).then(function (u) { return api("/admin/api/media/upload", { name: file.files[0].name, dataUrl: u }); }).then(function () { toast("Uploaded as draft."); load(); }).catch(fail); });
    q.addEventListener("input", function () { clearTimeout(q.t); q.t = setTimeout(function () { state.q = q.value; load(); }, 250); });
    folder.addEventListener("change", function () { state.folder = folder.value; load(); });
    main.replaceChildren(h("div", { class: "top" }, h("h1", { text: "Media library" }), h("span", { class: "sp" }), count, h("button", { class: "btn btn--primary", onclick: function () { file.click(); } }, "Upload image"), file),
      h("div", { class: "row", style: "margin-bottom:14px" }, q, folder), h("div", { class: "grid2", style: "grid-template-columns:2fr 1fr;align-items:start" }, h("div", {}, grid), side));
    detail(); return load();
  };

  // --------------------------------------------------------------------- SEO
  function seoFor(path) {
    return api("/admin/api/seo?path=" + encodeURIComponent(path)).then(function (d) {
      var s = d.seo || {};
      var title = h("input", { value: s.title || "", maxlength: 120 }), desc = h("textarea", { maxlength: 320 }, s.description || ""), canon = h("input", { value: s.canonical || "", placeholder: "https://wash4you.in/..." }),
        og = h("input", { value: s.og_image || "", placeholder: "images/uploads/share.webp" }), noidx = h("input", { type: "checkbox" }); noidx.checked = !!s.noindex;
      var tc = h("div", { class: "count" }), dc = h("div", { class: "count" });
      function counts() { tc.textContent = title.value.length + "/60 recommended"; tc.className = "count" + (title.value.length > 60 ? " bad" : ""); dc.textContent = desc.value.length + "/160 recommended"; dc.className = "count" + (desc.value.length > 160 ? " bad" : ""); }
      title.addEventListener("input", counts); desc.addEventListener("input", counts); counts();
      modal(h("div", {}, h("h2", { text: "SEO: " + path }), h("p", { class: "status", text: "Leave a field empty to keep the page's built-in value." }),
        field("Meta title", title), tc, field("Meta description", desc), dc, field("Canonical URL", canon), field("Social share image (Open Graph)", og),
        h("label", { class: "row", style: "margin-top:12px" }, noidx, "Hide this page from search engines (noindex)"),
        h("div", { class: "row", style: "margin-top:16px;justify-content:flex-end" }, h("button", { class: "btn", onclick: closeModal }, "Cancel"),
          h("button", { class: "btn btn--primary", onclick: function () { api("/admin/api/seo", { path: path, title: title.value.trim(), description: desc.value.trim(), canonical: canon.value.trim(), og_image: og.value.trim(), noindex: noidx.checked }).then(function () { closeModal(); toast("SEO saved as draft. Publish to make it live."); if (VIEWS.__seoRefresh) VIEWS.__seoRefresh(); }).catch(fail); } }, "Save"))));
    }).catch(fail);
  }
  VIEWS.seo = function () {
    return Promise.all([api("/admin/api/seo"), api("/admin/api/studio/pages")]).then(function (r) {
      var pages = r[0].pages || {}, all = r[1].pages;
      var q = h("input", { type: "search", placeholder: "Search pages to edit SEO...", class: "grow" }), list = h("div");
      function draw() {
        var s = q.value.toLowerCase();
        var rows = all.filter(function (p) { return !s || p.path.toLowerCase().indexOf(s) >= 0; }).slice(0, 120).map(function (p) {
          var rec = pages[p.path];
          return h("tr", {}, h("td", { text: p.path }), h("td", { text: rec ? (rec.title || "(custom)") : "built-in" }), h("td", { text: rec && rec.noindex ? "noindex" : "" }), h("td", {}, h("button", { class: "btn", onclick: function () { seoFor(p.path); } }, "Edit")));
        });
        list.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "Page" }), h("th", { text: "Title override" }), h("th", { text: "" }), h("th", { text: "" }))), h("tbody", {}, rows)));
      }
      q.addEventListener("input", draw); VIEWS.__seoRefresh = function () { VIEWS.seo(); };
      main.replaceChildren(h("div", { class: "top" }, h("h1", { text: "SEO settings" })), h("div", { class: "panel" }, h("p", { text: Object.keys(pages).length + " page(s) have custom SEO. Everything else keeps its built-in title and description." }), h("div", { class: "row" }, q), list)); draw();
    });
  };

  // ------------------------------------------------------------------- menus
  VIEWS.menus = function () {
    return api("/admin/api/menus").then(function (d) {
      var cfg = [["Header menu", d.nav.main, function (v) { return { nav: { main: v } }; }, true], ["Footer: Explore", d.footer.explore, function (v) { return { footer: { explore: v } }; }], ["Footer: Areas", d.footer.areas, function (v) { return { footer: { areas: v } }; }], ["Footer: Support", d.footer.support, function (v) { return { footer: { support: v } }; }]];
      var cta = { label: h("input", { value: d.nav.cta.label }), url: h("input", { value: d.nav.cta.url }) };
      var panels = cfg.map(function (c) {
        var items = (c[1] || []).map(function (x) { return { label: x.label, url: x.url, dropdown: x.dropdown }; }), box = h("div");
        function draw() {
          box.replaceChildren.apply(box, items.map(function (it, i) {
            var l = h("input", { value: it.label }), u = h("input", { value: it.url });
            l.addEventListener("input", function () { it.label = l.value; }); u.addEventListener("input", function () { it.url = u.value; });
            return h("div", { class: "ml" }, l, u, h("button", { class: "btn", title: "Move up", onclick: function () { if (i) { items.splice(i - 1, 0, items.splice(i, 1)[0]); draw(); } } }, "↑"),
              h("button", { class: "btn", title: "Move down", onclick: function () { if (i < items.length - 1) { items.splice(i + 1, 0, items.splice(i, 1)[0]); draw(); } } }, "↓"), h("button", { class: "btn btn--danger", onclick: function () { items.splice(i, 1); draw(); } }, "✕"));
          }));
        }
        draw();
        return h("div", { class: "panel" }, h("h2", { text: c[0] }), h("p", { class: "status", text: "Link is relative to the site (services/) or a full URL. Leave empty for the home page." }), box,
          h("div", { class: "row" }, h("button", { class: "btn", onclick: function () { items.push({ label: "New link", url: "" }); draw(); } }, "Add link"),
            h("button", { class: "btn btn--primary", onclick: function () { api("/admin/api/menus", c[2](items)).then(function () { toast("Saved as draft. Publish to make it live."); }).catch(fail); } }, "Save " + c[0].toLowerCase())));
      });
      var ctaPanel = h("div", { class: "panel" }, h("h2", { text: "Header button" }), h("div", { class: "grid2" }, field("Label", cta.label), field("Link", cta.url)),
        h("button", { class: "btn btn--primary", style: "margin-top:12px", onclick: function () { api("/admin/api/menus", { nav: { cta: { label: cta.label.value, url: cta.url.value } } }).then(function () { toast("Saved as draft."); }).catch(fail); } }, "Save header button"));
      main.replaceChildren.apply(main, [h("div", { class: "top" }, h("h1", { text: "Header, footer & menus" }))].concat([ctaPanel], panels,
        [h("p", { class: "status", text: "Phone, email, offer text and booking links are edited in the visual editor under Site." })]));
    });
  };

  // ----------------------------------------------------------------- publish
  VIEWS.publish = function () {
    return Promise.all([api("/admin/api/drafts"), api("/admin/api/overview")]).then(function (r) {
      var drafts = r[0].drafts, o = r[1];
      var msg = h("input", { placeholder: "What changed? (shown in revision history)", value: "" });
      var rows = drafts.map(function (d) { return h("tr", {}, h("td", { text: d.path }), h("td", { text: d.kind === "bin" ? "image" : d.kind === "del" ? "delete" : "content" }), h("td", { text: when(d.updatedAt) })); });
      main.replaceChildren(h("div", { class: "top" }, h("h1", { text: "Drafts & publishing" })),
        h("div", { class: "panel" }, h("h2", { text: drafts.length + " unpublished change(s)" }),
          drafts.length ? h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "File" }), h("th", { text: "Type" }), h("th", { text: "Saved" }))), h("tbody", {}, rows)) : h("p", { class: "empty", text: "Nothing waiting. Edit a page in the visual editor to create a draft." }),
          h("div", { class: "row", style: "margin-top:14px" }, h("div", { class: "grow" }, msg),
            h("button", { class: "btn btn--primary", disabled: !drafts.length, onclick: function () { this.disabled = true; api("/admin/api/publish", { message: msg.value }).then(function (d) { toast(d.steps.join(" ")); VIEWS.publish(); }).catch(function (e) { fail(e); VIEWS.publish(); }); } }, "Publish all changes"),
            h("button", { class: "btn btn--danger", disabled: !drafts.length, onclick: function () { if (confirm("Discard ALL unpublished changes? This cannot be undone (earlier revisions can still be restored).")) api("/admin/api/drafts/discard", {}).then(function () { toast("Drafts discarded."); VIEWS.publish(); }).catch(fail); } }, "Discard all"))),
        h("div", { class: "panel" }, h("h2", { text: "Editor build" }), h("p", { class: "status", text: o.editSite.ready ? "The editor shows the site as built " + when(o.editSite.builtAt) + "." : "The editable copy of the site has not been downloaded yet." }),
          h("button", { class: "btn", onclick: function () { this.disabled = true; this.textContent = "Downloading..."; api("/admin/api/edit-site/refresh", {}).then(function () { toast("Editor build refreshed."); VIEWS.publish(); }).catch(function (e) { fail(e); VIEWS.publish(); }); } }, "Refresh editor build"),
          h("p", { class: "status", text: "After you publish, the site rebuilds on GitHub (about a minute). Refresh the editor build afterwards to see your changes in the editor." })));
    });
  };

  // --------------------------------------------------------------- revisions
  VIEWS.revisions = function () {
    return api("/admin/api/revisions").then(function (d) {
      var rows = d.revisions.map(function (r) {
        return h("tr", {}, h("td", { text: when(r.at) }), h("td", {}, h("span", { class: "badge" + (r.kind === "draft" ? " draft" : ""), text: r.kind === "publish" ? "published" : "draft save" })), h("td", { text: r.message }), h("td", { text: r.by || "" }), h("td", { text: r.files + " file(s)" }),
          h("td", {}, h("button", { class: "btn", onclick: function () { if (confirm("Restore this version as a draft? Nothing goes live until you publish.")) api("/admin/api/revisions/restore", { id: r.id }).then(function (x) { toast("Restored " + x.files + " file(s) as drafts. Review and publish."); }).catch(fail); } }, "Restore")));
      });
      main.replaceChildren(h("div", { class: "top" }, h("h1", { text: "Revision history" })), h("div", { class: "panel" }, rows.length ? h("table", {}, h("thead", {}, h("tr", {}, ["When", "Type", "Note", "By", "Files", ""].map(function (t) { return h("th", { text: t }); }))), h("tbody", {}, rows)) : h("p", { class: "empty", text: "No revisions yet." }),
        h("p", { class: "status", text: "Restoring puts that version's files back as drafts. Review them in the editor, then publish." })));
    });
  };

  // ----------------------------------------------------------------- account
  VIEWS.account = function () {
    var cur = h("input", { type: "password", autocomplete: "current-password" }), nw = h("input", { type: "password", autocomplete: "new-password" });
    var users = h("div");
    function loadUsers() {
      return api("/admin/api/users").then(function (d) {
        users.replaceChildren(h("table", {}, h("thead", {}, h("tr", {}, ["User", "Last sign-in", ""].map(function (t) { return h("th", { text: t }); }))), h("tbody", {}, d.users.map(function (u) {
          return h("tr", {}, h("td", { text: u.username + (u.id === me.user.id ? " (you)" : "") }), h("td", { text: when(u.lastLoginAt) }), h("td", {}, u.id === me.user.id ? "" : h("button", { class: "btn btn--danger", onclick: function () { if (confirm("Delete " + u.username + "?")) api("/admin/api/users/delete", { id: u.id }).then(loadUsers).catch(fail); } }, "Delete")));
        }))));
      });
    }
    var nu = h("input", { placeholder: "new username" }), np = h("input", { type: "password", placeholder: "password (10+ characters, letters and a number)", autocomplete: "new-password" });
    main.replaceChildren(h("div", { class: "top" }, h("h1", { text: "Account & users" })),
      h("div", { class: "panel" }, h("h2", { text: "Change your password" }), field("Current password", cur), field("New password", nw),
        h("button", { class: "btn btn--primary", style: "margin-top:12px", onclick: function () { api("/admin/api/password", { current: cur.value, next: nw.value }).then(function () { cur.value = nw.value = ""; toast("Password changed. Other sessions were signed out."); }).catch(fail); } }, "Change password")),
      h("div", { class: "panel" }, h("h2", { text: "Administrators" }), users, h("div", { class: "row", style: "margin-top:12px" }, h("div", { class: "grow" }, nu), h("div", { class: "grow" }, np),
        h("button", { class: "btn", onclick: function () { api("/admin/api/users", { username: nu.value, password: np.value }).then(function () { nu.value = np.value = ""; toast("User added."); loadUsers(); }).catch(fail); } }, "Add administrator"))));
    return loadUsers();
  };

  api("/admin/api/me").then(function (d) { me = d; document.getElementById("who").textContent = "Signed in as " + d.user.username; var v0 = (location.hash || "#overview").slice(1); show(typeof VIEWS[v0] === "function" && v0.charAt(0) !== "_" ? v0 : "overview"); }).catch(fail);
})();
