/* Wash4You Studio - editor shell (visual page builder).
   The page canvas is an iframe (studio-frame.js reports/obeys via postMessage).
   All editing state lives here in `S`; Save writes it to data/*.json and rebuilds. */
(function () {
  "use strict";

  // ----------------------------------------------------------------- helpers
  var $ = function (s, c) { return (c || document).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function rid() { return "blk-" + Math.random().toString(16).slice(2, 8); }
  function api(path, body) {
    return fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
  }
  var toastT;
  function toast(msg, kind) { var t = $("#toast"); t.textContent = msg; t.className = "toast is-on " + (kind || ""); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("is-on"); }, 2600); }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  function readFile(file) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(file); }); }

  // -------------------------------------------------------------- widget defs
  var WIDGETS = [
    { type: "hero", name: "Hero banner", icon: "🏞", props: { eyebrow: "Welcome", title: "Your headline here", text: "A short supporting line that explains the offer.", button_label: "Book free pickup", button_url: "https://app.wash4you.in/website/W10795?brand=WASH4U", image: "" } },
    { type: "heading", name: "Heading + text", icon: "📝", props: { eyebrow: "", title: "Add a heading", text: "Write your paragraph here. Leave a blank line for a new paragraph.", align: "center", button_label: "", button_url: "" } },
    { type: "image_text", name: "Image + text", icon: "🖼", props: { image: "", alt: "", eyebrow: "Feature", title: "Tell your story", text: "Describe this feature in a couple of sentences.", button_label: "Learn more", button_url: "contact-us/", side: "left" } },
    { type: "gallery", name: "Gallery", icon: "🗂", props: { eyebrow: "Our work", title: "Photo gallery", columns: "3", images: [] } },
    { type: "cta", name: "Call to action", icon: "📣", props: { title: "Ready to book?", text: "Free pickup and delivery across Gurgaon & NCR.", button_label: "Book free pickup", button_url: "https://app.wash4you.in/website/W10795?brand=WASH4U", button2_label: "WhatsApp us", button2_url: "https://wa.me/916367600500" } },
    { type: "stats", name: "Stats strip", icon: "📊", props: { lead: "Trusted by thousands", items: [{ value: "5,000+", label: "Happy customers" }, { value: "4.7+", label: "Google rating" }, { value: "90%+", label: "Repeat rate" }] } },
    { type: "faq", name: "FAQ", icon: "❓", props: { title: "Frequently asked questions", items: [{ q: "How does pickup work?", a: "Book online and we collect from your door." }] } },
    { type: "video", name: "Video", icon: "▶️", props: { title: "", url: "" } },
    { type: "spacer", name: "Spacer", icon: "↕️", props: { height: "48" } },
    { type: "html", name: "Custom HTML", icon: "🧩", props: { html: "<p>Your HTML here</p>" } }
  ];
  var WNAME = {}; WIDGETS.forEach(function (w) { WNAME[w.type] = w.name; });

  var FIELDS = {
    hero: [["eyebrow", "Eyebrow"], ["title", "Headline"], ["text", "Text", "rich"], ["button_label", "Button label"], ["button_url", "Button link", "url"], ["image", "Background image", "image"]],
    heading: [["eyebrow", "Eyebrow"], ["title", "Heading"], ["text", "Text", "rich"], ["align", "Alignment", "select", ["center", "left", "right"]], ["button_label", "Button label"], ["button_url", "Button link", "url"]],
    image_text: [["image", "Image", "image"], ["alt", "Image description"], ["eyebrow", "Eyebrow"], ["title", "Heading"], ["text", "Text", "rich"], ["button_label", "Button label"], ["button_url", "Button link", "url"], ["side", "Image side", "select", ["left", "right"]]],
    gallery: [["eyebrow", "Eyebrow"], ["title", "Heading"], ["columns", "Columns", "select", ["1", "2", "3"]], ["images", "Images", "list", [["src", "Image", "image"], ["caption", "Caption"]], { src: "", caption: "" }]],
    cta: [["title", "Heading"], ["text", "Text", "rich"], ["button_label", "Button label"], ["button_url", "Button link", "url"], ["button2_label", "Second button label"], ["button2_url", "Second button link", "url"]],
    stats: [["lead", "Lead line"], ["items", "Figures", "list", [["value", "Value"], ["label", "Label"]], { value: "", label: "" }]],
    faq: [["title", "Heading"], ["items", "Questions", "list", [["q", "Question"], ["a", "Answer", "textarea"]], { q: "", a: "" }]],
    video: [["title", "Heading"], ["url", "YouTube or Vimeo link", "url"]],
    spacer: [["height", "Height (px)", "number"]],
    html: [["html", "HTML", "code"]]
  };

  var GLOBAL_COLORS = [["--green-cta", "Button colour"], ["--navy", "Brand navy"], ["--navy-deep", "Dark bands"], ["--brass", "Accent (brass)"], ["--ink", "Heading text"]];
  var SITE_FIELDS = [["site:contact.phone", "Phone number"], ["site:contact.email", "Email"], ["site:offer.value", "Offer value (e.g. 25%)"], ["site:offer.label", "Offer label"], ["site:offer.detail", "Offer detail"], ["site:urls.booking", "Booking link"], ["site:urls.whatsapp", "WhatsApp link"]];
  var MULTI_TPL = ["page-product-detail.html", "page-service-detail.html", "page-location.html", "page-coverage.html", "page-coverage-hub.html", "page-matrix.html"];

  // ------------------------------------------------------------------- state
  var frame = $("#frame");
  var docs = null, S = null, savedSnap = "", hist = [], hIdx = -1;
  var texts = new Map(), page = { path: "/", tpl: "", pagekey: "" }, tplScope = false;
  var info = [], domIds = [], sel = null, locked = {}, blockCache = {}, device = "desktop", tab = "widgets";
  var frameReady = false, siteVals = null, pages = [];

  function blank() { return { order: [], hidden: [], blocks: {}, secStyles: {}, elStyles: {}, globals: {} }; }
  function scopeKey() { return tplScope ? "tpl:" + page.tpl : "page:" + page.pagekey; }
  function snap() { return JSON.stringify(S); }
  function isDirty() { return !!S && (snap() !== savedSnap || texts.size > 0); }

  // ---------------------------------------------------------- init / loading
  function loadDocs() { return api("/admin/api/studio/state").then(function (r) { docs = r.data; }); }

  function initState() {
    // Build S from the page as the canvas rendered it + the saved docs.
    var key = scopeKey();
    var blocksHere = (docs.blocks.pages[key] || []);
    var byId = {}; blocksHere.forEach(function (b) { byId[b.id] = b; });
    S = blank();
    S.order = info.map(function (s) { return s.id; });
    S.hidden = info.filter(function (s) { return s.hidden; }).map(function (s) { return s.id; });
    locked = {};
    info.forEach(function (s) {
      if (s.block) { if (byId[s.id]) S.blocks[s.id] = clone({ type: byId[s.id].type, props: byId[s.id].props || {} }); else locked[s.id] = s.type; }
    });
    S.secStyles = clone(docs.styles.sections[key] || {});
    S.elStyles = clone(docs.styles.elements || {});
    S.globals = clone(docs.styles.global || {});
    // Unpublished (draft) layout / widgets win over what the published build shows.
    var dLayout = docs.layout.pages[key], dBlocks = docs.blocks.pages[key], merged = false;
    if (dBlocks) {
      S.blocks = {}; dBlocks.forEach(function (b) { S.blocks[b.id] = clone({ type: b.type, props: b.props || {} }); delete locked[b.id]; }); merged = true;
    }
    if (dLayout) {
      var ord = (dLayout.order || []).filter(function (id) { return S.order.indexOf(id) >= 0 || S.blocks[id]; });
      S.order.forEach(function (id) { if (ord.indexOf(id) < 0) ord.push(id); });
      Object.keys(S.blocks).forEach(function (id) { if (ord.indexOf(id) < 0) ord.push(id); });
      S.order = ord; S.hidden = (dLayout.hidden || []).slice(); merged = true;
    }
    savedSnap = snap(); hist = [savedSnap]; hIdx = 0; blockCache = {};
    texts.clear(); sel = null;
    updateChrome(); renderAll();
    if (merged) pushToCanvas();
  }

  function loadPage(path) {
    page.path = path;
    frameReady = false; $("#loading").classList.remove("is-off");
    frame.src = path + (path.indexOf("?") < 0 ? "?" : "&") + "studio=1&_=" + Date.now();
    $("#pickerLabel").textContent = path;
    $("#viewBtn").href = path;
    try { history.replaceState(null, "", "/studio?p=" + encodeURIComponent(path)); } catch (e) { /* ignore */ }
    $$(".picker__item").forEach(function (b) { b.classList.toggle("is-on", b.dataset.path === path); });
  }

  function goto(path) {
    if (isDirty() && !confirm("You have unsaved changes on this page. Leave without saving?")) return;
    loadPage(path);
  }

  // ------------------------------------------------------- frame <-> shell
  window.addEventListener("message", function (e) {
    var m = e.data; if (!m || !m.w4s || e.source !== frame.contentWindow) return;
    if (m.type === "sections") {
      info = m.sections || []; domIds = info.map(function (s) { return s.id; });
      page.tpl = m.tpl || page.tpl; page.pagekey = m.pagekey || page.pagekey;
      if (m.path) { page.path = m.path; $("#pickerLabel").textContent = m.path; $("#viewBtn").href = m.path; }
      if (S) { renderNav(); }
    } else if (m.type === "ready") {
      if (!frameReady) {
        frameReady = true; $("#loading").classList.add("is-off");
        var keyPage = "page:" + page.pagekey;
        tplScope = MULTI_TPL.indexOf(page.tpl) >= 0 && !(docs.layout.pages[keyPage] || docs.blocks.pages[keyPage] || docs.styles.sections[keyPage]);
        Promise.resolve().then(initState);
      }
    } else if (m.type === "select") {
      sel = m; if (m.kind === "section") { tab = "settings"; } else { tab = "settings"; }
      showTab(tab); renderSettings(); renderNav();
    } else if (m.type === "text-edit") {
      texts.set(m.binding, m.value); if (sel && sel.binding === m.binding) sel.html = m.html; updateChrome(); renderSettings();
    } else if (m.type === "text-live") {
      /* keep the settings textarea in sync without re-rendering it */
      var ta = $("#fld-text"); if (ta && sel && sel.binding === m.binding && document.activeElement !== ta && m.html != null) ta.innerHTML = m.html;
    } else if (m.type === "section-action") {
      sectionAction(m.id, m.action);
    } else if (m.type === "drop") {
      if (dragWidget) { insertBlock(dragWidget, m.beforeId); dragWidget = null; }
    } else if (m.type === "navigate") {
      var u; try { u = new URL(m.abs); } catch (err) { return; }
      if (u.hash && u.pathname === location.pathname) return;
      if (u.origin === location.origin) goto(u.pathname); else window.open(m.abs, "_blank", "noopener");
    }
  });
  function send(msg) { if (frame.contentWindow) frame.contentWindow.postMessage(Object.assign({ w4s: 1 }, msg), "*"); }

  // ------------------------------------------------------------- live css
  function liveCss() {
    var rules = [], g = S.globals || {};
    var gv = Object.keys(g).filter(function (k) { return /^--[a-z0-9-]+$/.test(k) && /^#[0-9a-fA-F]{3,8}$/.test(g[k]); }).map(function (k) { return k + ":" + g[k]; });
    if (gv.length) rules.push(":root{" + gv.join(";") + "}");
    Object.keys(S.secStyles).forEach(function (id) {
      var p = S.secStyles[id], sel2 = '[data-sec="' + id + '"]', d = [];
      if (p.bg) d.push("background:" + p.bg); if (p.color) d.push("color:" + p.color);
      if (p.padTop !== undefined && p.padTop !== "") d.push("padding-top:" + p.padTop + "px");
      if (p.padBottom !== undefined && p.padBottom !== "") d.push("padding-bottom:" + p.padBottom + "px");
      if (d.length) rules.push(sel2 + "{" + d.map(function (x) { return x + " !important"; }).join(";") + "}");
      if (p.hideMobile) rules.push("@media (max-width:40rem){" + sel2 + "{display:none !important}}");
      if (p.hideTablet) rules.push("@media (min-width:40.0625rem) and (max-width:61.99rem){" + sel2 + "{display:none !important}}");
      if (p.hideDesktop) rules.push("@media (min-width:62rem){" + sel2 + "{display:none !important}}");
    });
    Object.keys(S.elStyles).forEach(function (b) {
      var p = S.elStyles[b], d = [];
      if (p.color) d.push("color:" + p.color);
      if (p.fontSize) d.push("font-size:" + p.fontSize + (/^\d+(\.\d+)?$/.test(p.fontSize) ? "px" : ""));
      if (p.fontWeight) d.push("font-weight:" + p.fontWeight); if (p.textAlign) d.push("text-align:" + p.textAlign);
      if (p.fontStyle) d.push("font-style:" + p.fontStyle); if (p.textTransform) d.push("text-transform:" + p.textTransform);
      if (p.lineHeight) d.push("line-height:" + p.lineHeight);
      if (d.length) rules.push('[data-sid="' + b + '"]{' + d.map(function (x) { return x + " !important"; }).join(";") + "}");
    });
    return rules.join("\n");
  }

  // ------------------------------------------------------ state -> canvas
  function blockHtml(id) {
    var b = S.blocks[id], key = JSON.stringify([b.type, b.props]);
    if (blockCache[id] && blockCache[id].key === key) return Promise.resolve(blockCache[id].html);
    return api("/admin/api/studio/render-block", { id: id, type: b.type, props: b.props }).then(function (r) {
      var html = (r.data && r.data.html) || ""; blockCache[id] = { key: key, html: html }; return html;
    });
  }

  var pushing = Promise.resolve();
  function pushToCanvas() {
    // Serialise so a slow render never lands after a newer one.
    pushing = pushing.then(function () {
      if (!S || !frameReady) return;
      var need = Object.keys(S.blocks).filter(function (id) {
        var b = S.blocks[id], key = JSON.stringify([b.type, b.props]);
        return domIds.indexOf(id) < 0 || !blockCache[id] || blockCache[id].key !== key || dirtyBlocks[id];
      });
      return Promise.all(need.map(function (id) { return blockHtml(id).then(function (h) { return [id, h]; }); })).then(function (pairs) {
        var blocks = {}, labels = {};
        pairs.forEach(function (p) { blocks[p[0]] = p[1]; });
        Object.keys(S.blocks).forEach(function (id) { labels[id] = WNAME[S.blocks[id].type] || "Widget"; });
        Object.keys(locked).forEach(function (id) { labels[id] = WNAME[locked[id]] || "Widget"; });
        dirtyBlocks = {};
        send({ type: "apply", order: S.order, hidden: S.hidden, blocks: blocks, labels: labels, css: liveCss(), styledBindings: Object.keys(S.elStyles) });
      });
    });
  }
  var dirtyBlocks = {};

  function commit(opts) {
    if (!S) return; opts = opts || {};
    var s = snap();
    if (s !== hist[hIdx]) {
      hist = hist.slice(0, hIdx + 1); hist.push(s); if (hist.length > 80) hist.shift(); hIdx = hist.length - 1;
    }
    if (opts.touch) dirtyBlocks[opts.touch] = true;
    pushToCanvas(); updateChrome(); if (!opts.skipPanels) renderAll();
  }
  function undo() { if (hIdx > 0) { hIdx--; S = JSON.parse(hist[hIdx]); markAllBlocksDirty(); pushToCanvas(); updateChrome(); renderAll(); } }
  function redo() { if (hIdx < hist.length - 1) { hIdx++; S = JSON.parse(hist[hIdx]); markAllBlocksDirty(); pushToCanvas(); updateChrome(); renderAll(); } }
  function markAllBlocksDirty() { Object.keys(S.blocks).forEach(function (id) { dirtyBlocks[id] = domIds.indexOf(id) < 0; }); }

  function updateChrome() {
    lastEdit = Date.now();
    var d = isDirty();
    $("#saveBtn").disabled = !d; $("#status").textContent = d ? "Unsaved changes" : "All changes saved"; $("#status").classList.toggle("is-dirty", d);
    $("#undoBtn").disabled = hIdx <= 0; $("#redoBtn").disabled = hIdx >= hist.length - 1;
  }

  // ------------------------------------------------------------ mutations
  function idx(id) { return S.order.indexOf(id); }
  function move(id, to) { var i = idx(id); if (i < 0) return; S.order.splice(i, 1); S.order.splice(Math.max(0, Math.min(to, S.order.length)), 0, id); }
  function toggleHide(id) { var i = S.hidden.indexOf(id); if (i >= 0) S.hidden.splice(i, 1); else S.hidden.push(id); }

  function insertBlock(type, beforeId) {
    var w = WIDGETS.filter(function (x) { return x.type === type; })[0]; if (!w) return;
    var id = rid(); S.blocks[id] = { type: type, props: clone(w.props) };
    var at;
    if (beforeId && idx(beforeId) >= 0) at = idx(beforeId);
    else if (beforeId === null) at = S.order.length;
    else if (sel && sel.kind === "section" && idx(sel.id) >= 0) at = idx(sel.id) + 1;
    else at = S.order.length;
    S.order.splice(at, 0, id);
    sel = { kind: "section", id: id }; dirtyBlocks[id] = true;
    commit({ touch: id });
    tab = "settings"; showTab(tab);
    setTimeout(function () { send({ type: "select-section", id: id }); }, 350);
    toast(w.name + " added", "ok");
  }

  function sectionAction(id, action) {
    var i = idx(id); if (i < 0) return;
    if (action === "up") { if (i > 0) { move(id, i - 1); commit(); } }
    else if (action === "down") { if (i < S.order.length - 1) { move(id, i + 1); commit(); } }
    else if (action === "hide") { toggleHide(id); commit(); }
    else if (action === "dup") {
      var b = S.blocks[id]; if (!b) return;
      var nid = rid(); S.blocks[nid] = clone(b); S.order.splice(i + 1, 0, nid); sel = { kind: "section", id: nid }; commit({ touch: nid });
      setTimeout(function () { send({ type: "select-section", id: nid }); }, 350);
    } else if (action === "del") {
      if (!S.blocks[id]) return; if (!confirm("Delete this widget?")) return;
      delete S.blocks[id]; S.order.splice(i, 1); S.hidden = S.hidden.filter(function (x) { return x !== id; }); delete S.secStyles[id];
      if (sel && sel.id === id) sel = null; commit(); send({ type: "clear-selection" });
    }
  }

  // ------------------------------------------------------------- UI: tabs
  function showTab(t) {
    tab = t;
    $$("#tabs button").forEach(function (b) { b.classList.toggle("is-on", b.dataset.tab === t); });
    ["widgets", "nav", "settings", "site"].forEach(function (n) { $("#panel-" + n).hidden = n !== t; });
  }
  $("#tabs").addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) showTab(b.dataset.tab); });
  function renderAll() { renderWidgets(); renderNav(); renderSettings(); renderSite(); }

  // ------------------------------------------------------- UI: widgets tab
  var dragWidget = null;
  function renderWidgets() {
    var p = $("#panel-widgets"); p.innerHTML = "";
    p.appendChild(el("p", "hint", "Drag a widget onto the page, or click one to add it after the selected section."));
    var g = el("div", "grid2");
    WIDGETS.forEach(function (w) {
      var c = el("div", "widget"); c.draggable = true; c.innerHTML = "<span>" + w.icon + "</span>" + w.name;
      c.addEventListener("dragstart", function (e) { dragWidget = w.type; e.dataTransfer.setData("text/plain", "w4s-widget"); e.dataTransfer.effectAllowed = "copy"; send({ type: "drag", on: true }); });
      c.addEventListener("dragend", function () { send({ type: "drag", on: false }); setTimeout(function () { dragWidget = null; }, 200); });
      c.addEventListener("click", function () { insertBlock(w.type, undefined); });
      g.appendChild(c);
    });
    p.appendChild(g);
  }

  // ----------------------------------------------------- UI: navigator tab
  var dragNav = null;
  function renderNav() {
    var p = $("#panel-nav"); p.innerHTML = "";
    if (!S) { p.appendChild(el("div", "empty", "Loading...")); return; }
    var multi = MULTI_TPL.indexOf(page.tpl) >= 0;
    if (multi) {
      var row = el("label", "chk"); var cb = el("input"); cb.type = "checkbox"; cb.checked = tplScope;
      cb.addEventListener("change", function () { tplScope = cb.checked; updateChrome(); renderNav(); toast(tplScope ? "Layout will apply to every page that uses this template" : "Layout will apply to this page only"); savedSnap = savedSnap + " "; updateChrome(); });
      row.append(cb, document.createTextNode(" Apply to all pages using this template"));
      p.appendChild(row);
    }
    p.appendChild(el("p", "hint", "Drag to reorder. The eye hides a section on the live site."));
    var ul = el("ul", "navlist");
    S.order.forEach(function (id) {
      var meta = info.filter(function (s) { return s.id === id; })[0] || { label: WNAME[(S.blocks[id] || {}).type] || "Widget", block: !!S.blocks[id] };
      var hidden = S.hidden.indexOf(id) >= 0, isBlock = !!S.blocks[id] || !!locked[id];
      var li = el("li", "navi" + (hidden ? " is-hidden" : "") + (sel && sel.kind === "section" && sel.id === id ? " is-sel" : ""));
      li.draggable = true; li.dataset.id = id;
      var grip = el("span", "navi__g", "⋮⋮");
      var t = el("span", "navi__t", (meta.label || "Section").trim());
      li.append(grip, t);
      if (isBlock) li.appendChild(el("span", "navi__tag", locked[id] ? "shared" : "widget"));
      var eye = el("button", null, hidden ? "🚫" : "👁"); eye.title = hidden ? "Show" : "Hide";
      eye.addEventListener("click", function (e) { e.stopPropagation(); toggleHide(id); commit(); });
      li.appendChild(eye);
      li.addEventListener("click", function () { sel = { kind: "section", id: id }; renderNav(); renderSettings(); send({ type: "select-section", id: id }); });
      li.addEventListener("dragstart", function (e) { dragNav = id; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id); });
      li.addEventListener("dragover", function (e) { if (dragNav) { e.preventDefault(); li.classList.add("is-over"); } });
      li.addEventListener("dragleave", function () { li.classList.remove("is-over"); });
      li.addEventListener("drop", function (e) { e.preventDefault(); li.classList.remove("is-over"); if (dragNav && dragNav !== id) { move(dragNav, idx(id)); commit(); } dragNav = null; });
      ul.appendChild(li);
    });
    p.appendChild(ul);
  }

  // ------------------------------------------------------------- rich text
  var RT = "<!--rt-->";
  function hasFormatting(html) { return /<(b|strong|i|em|u|a|ul|ol|li|br|p|div|span|h[2-4]|blockquote)\b/i.test(html); }
  function plainOf(html) { var d = document.createElement("div"); d.innerHTML = html.replace(/<br\s*\/?>/gi, " "); return d.textContent.replace(/\s+/g, " ").trim(); }
  function pack(html, kind) { return kind === "rich" ? html : (hasFormatting(html) ? RT + html : plainOf(html)); }
  function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function toHtml(value) { value = value == null ? "" : String(value); return value.indexOf(RT) === 0 ? value.slice(RT.length) : escHtml(value).replace(/\n/g, "<br>"); }

  function richEditor(html, onChange, opts) {
    opts = opts || {};
    var wrap = el("div", "rte"), bar = el("div", "rte__bar"), area = el("div", "rte__area");
    area.contentEditable = "true"; area.innerHTML = html || ""; area.spellcheck = true;
    var btns = [["bold", "<b>B</b>", "Bold"], ["italic", "<i>I</i>", "Italic"], ["underline", "<u>U</u>", "Underline"], ["|"], ["link", "&#128279;", "Link"], ["unlink", "&#9986;", "Remove link"]];
    if (opts.block !== false) btns = btns.concat([["|"], ["insertUnorderedList", "&bull;&equiv;", "Bullet list"], ["insertOrderedList", "1.&equiv;", "Numbered list"], ["formatBlockH3", "H", "Heading"], ["formatBlockP", "&para;", "Paragraph"]]);
    btns.push(["|"], ["removeFormat", "&#10006;", "Clear formatting"]);
    btns.forEach(function (b) {
      if (b[0] === "|") { bar.appendChild(el("span", "rte__sep")); return; }
      var x = el("button"); x.type = "button"; x.innerHTML = b[1]; x.title = b[2];
      x.addEventListener("mousedown", function (e) { e.preventDefault(); });
      x.addEventListener("click", function () {
        area.focus();
        if (b[0] === "link") { var u = prompt("Link address (https://..., tel:..., /page/)", "https://"); if (u) document.execCommand("createLink", false, u); }
        else if (b[0] === "formatBlockH3") document.execCommand("formatBlock", false, "h3");
        else if (b[0] === "formatBlockP") document.execCommand("formatBlock", false, "p");
        else document.execCommand(b[0], false, null);
        onChange(area.innerHTML);
      });
      bar.appendChild(x);
    });
    var col = el("input"); col.type = "color"; col.title = "Text colour"; col.value = "#000000";
    col.addEventListener("input", function () { area.focus(); document.execCommand("styleWithCSS", false, true); document.execCommand("foreColor", false, col.value); onChange(area.innerHTML); });
    bar.appendChild(col);
    area.addEventListener("input", function () { onChange(area.innerHTML); });
    area.addEventListener("paste", function (e) { e.preventDefault(); var tx = (e.clipboardData || window.clipboardData).getData("text/plain"); document.execCommand("insertText", false, tx); });
    wrap.append(bar, area); wrap._area = area; return wrap;
  }

  // ---------------------------------------------------- UI: field builders
  function fld(label, node, id) { var w = el("div", "f"); var l = el("label", null, label); if (id) l.htmlFor = id; w.append(l, node); return w; }
  function textInput(val, onInput, type) { var i = el("input"); i.type = type || "text"; i.value = val == null ? "" : val; i.addEventListener("input", function () { onInput(i.value); }); return i; }
  function areaInput(val, onInput, code) { var t = el("textarea", code ? "code" : ""); t.value = val == null ? "" : val; t.addEventListener("input", function () { onInput(t.value); }); return t; }
  function selectInput(val, opts, onChange) { var s = el("select"); opts.forEach(function (o) { var op = el("option", null, o); op.value = o; if (String(val) === o) op.selected = true; s.appendChild(op); }); s.addEventListener("change", function () { onChange(s.value); }); return s; }
  function colorInput(val, onChange) {
    var w = el("div", "color"), c = el("input"), t = el("input"), x = el("button", null, "clear");
    c.type = "color"; c.value = /^#[0-9a-fA-F]{6}$/.test(val || "") ? val : "#000000"; t.type = "text"; t.value = val || ""; t.placeholder = "default"; x.type = "button";
    c.addEventListener("input", function () { t.value = c.value; onChange(c.value); });
    t.addEventListener("input", function () { if (/^#[0-9a-fA-F]{3,8}$/.test(t.value)) { if (t.value.length === 7) c.value = t.value; onChange(t.value); } else if (t.value === "") onChange(""); });
    x.addEventListener("click", function () { t.value = ""; onChange(""); });
    w.append(c, t, x); return w;
  }
  function imageInput(val, onChange) {
    var w = el("div", "imgf"), prev = val ? el("img") : el("div", "ph", "No image");
    if (val) prev.src = "/" + val;
    var col = el("div"), b = el("button", "btn btn--sm", val ? "Replace" : "Upload"), f = el("input"); f.type = "file"; f.accept = "image/*"; f.hidden = true;
    b.type = "button"; b.addEventListener("click", function () { f.click(); });
    f.addEventListener("change", function () {
      var file = f.files && f.files[0]; if (!file) return; toast("Uploading...");
      readFile(file).then(function (dataUrl) { return api("/admin/api/studio/upload", { name: file.name, dataUrl: dataUrl }); })
        .then(function (r) { if (r.ok && r.data.ok) { onChange(r.data.path); toast("Image uploaded", "ok"); } else toast((r.data && r.data.error) || "Upload failed", "err"); });
    });
    col.append(b, f); w.append(prev, col); return w;
  }
  function rowFor(spec, obj, onChange) {
    var key = spec[0], label = spec[1], type = spec[2] || "text";
    var set = function (v) { obj[key] = v; onChange(key); };
    if (type === "rich") return fld(label, richEditor(toHtml(obj[key]), function (html) { obj[key] = pack(html, "text"); onChange(key); }));
    if (type === "textarea") return fld(label, areaInput(obj[key], set));
    if (type === "code") return fld(label, areaInput(obj[key], set, true));
    if (type === "select") return fld(label, selectInput(obj[key] || spec[3][0], spec[3], set));
    if (type === "number") return fld(label, textInput(obj[key], set, "number"));
    if (type === "url") return fld(label, textInput(obj[key], set, "text"));
    if (type === "image") return fld(label, imageInput(obj[key], function (v) { set(v); renderSettings(); }));
    if (type === "list") {
      var wrap = el("div"); wrap.appendChild(el("div", "h", label));
      obj[key] = obj[key] || [];
      obj[key].forEach(function (item, i) {
        var card = el("div", "item"), bar = el("div", "item__bar"), del = el("button", null, "Remove");
        bar.append(el("span", null, "Item " + (i + 1)), del); card.appendChild(bar);
        del.addEventListener("click", function () { obj[key].splice(i, 1); onChange(key); renderSettings(); });
        spec[3].forEach(function (sub) { card.appendChild(rowFor(sub, item, function () { onChange(key); })); });
        wrap.appendChild(card);
      });
      var add = el("button", "btn btn--sm", "+ Add item"); add.type = "button";
      add.addEventListener("click", function () { obj[key].push(clone(spec[4])); onChange(key); renderSettings(); });
      wrap.appendChild(add); return wrap;
    }
    return fld(label, textInput(obj[key], set));
  }

  // ----------------------------------------------------- UI: settings tab
  var changeBlock = debounce(function (id) { commit({ touch: id, skipPanels: true }); }, 350);

  function renderSettings() {
    var p = $("#panel-settings"); p.innerHTML = "";
    if (!S || !sel) { p.appendChild(el("div", "empty", "Click a section, text or image on the page to edit it here.")); return; }
    if (sel.kind === "text") return renderTextSettings(p);
    if (sel.kind === "image") return renderImageSettings(p);
    var id = sel.id, i = idx(id);
    if (i < 0) { p.appendChild(el("div", "empty", "Select a section.")); return; }
    var meta = info.filter(function (s) { return s.id === id; })[0] || {};
    var b = S.blocks[id];
    var crumb = el("div", "crumb"); crumb.append(document.createTextNode(b ? WNAME[b.type] : (meta.label || "Section")), el("small", null, b ? "widget" : "section")); p.appendChild(crumb);

    var act = el("div", "actions");
    [["↑ Up", "up"], ["↓ Down", "down"], [S.hidden.indexOf(id) >= 0 ? "Show" : "Hide", "hide"]].concat(b ? [["Duplicate", "dup"], ["Delete", "del"]] : []).forEach(function (a) {
      var btn = el("button", "btn btn--sm" + (a[1] === "del" ? " btn--danger" : ""), a[0]); btn.addEventListener("click", function () { sectionAction(id, a[1]); renderSettings(); }); act.appendChild(btn);
    });
    p.appendChild(act);
    if (locked[id]) p.appendChild(el("p", "hint", "This widget comes from the shared template. Edit it from the template's scope (turn on 'Apply to all pages')."));

    if (b) {
      p.appendChild(el("div", "h", "Content"));
      (FIELDS[b.type] || []).forEach(function (spec) { p.appendChild(rowFor(spec, b.props, function () { changeBlock(id); })); });
    }
    p.appendChild(el("div", "h", "Section style"));
    var st = S.secStyles[id] = S.secStyles[id] || {};
    var upd = function () { cleanStyles(); commit({ skipPanels: true }); };
    p.appendChild(fld("Background colour", colorInput(st.bg, function (v) { st.bg = v; upd(); })));
    p.appendChild(fld("Text colour", colorInput(st.color, function (v) { st.color = v; upd(); })));
    var pad = el("div", "grid2");
    pad.appendChild(fld("Padding top (px)", textInput(st.padTop, function (v) { st.padTop = v; upd(); }, "number")));
    pad.appendChild(fld("Padding bottom (px)", textInput(st.padBottom, function (v) { st.padBottom = v; upd(); }, "number")));
    p.appendChild(pad);
    p.appendChild(el("div", "h", "Responsive"));
    [["hideDesktop", "Hide on desktop"], ["hideTablet", "Hide on tablet"], ["hideMobile", "Hide on mobile"]].forEach(function (c) {
      var lab = el("label", "chk"), cb = el("input"); cb.type = "checkbox"; cb.checked = !!st[c[0]];
      cb.addEventListener("change", function () { st[c[0]] = cb.checked; upd(); }); lab.append(cb, document.createTextNode(" " + c[1])); p.appendChild(lab);
    });
    p.appendChild(el("p", "hint", "Tip: switch the device buttons at the top to check each size."));
  }
  function cleanStyles() {
    Object.keys(S.secStyles).forEach(function (id) {
      var st = S.secStyles[id]; Object.keys(st).forEach(function (k) { if (st[k] === "" || st[k] === false || st[k] === undefined) delete st[k]; });
      if (!Object.keys(st).length) delete S.secStyles[id];
    });
    Object.keys(S.elStyles).forEach(function (b) {
      var st = S.elStyles[b]; Object.keys(st).forEach(function (k) { if (st[k] === "" || st[k] === undefined) delete st[k]; });
      if (!Object.keys(st).length) delete S.elStyles[b];
    });
  }

  function renderTextSettings(p) {
    var bnd = sel.binding, isRich = sel.cmsKind === "rich";
    var crumb = el("div", "crumb"); crumb.append(document.createTextNode("Text"), el("small", null, bnd)); p.appendChild(crumb);
    p.appendChild(el("p", "hint", "Edit directly on the page, or here. " + (isRich ? "This field accepts HTML." : "")));
    var cur = texts.has(bnd) ? toHtml(texts.get(bnd)) : (sel.html != null ? sel.html : escHtml(sel.value || ""));
    var kindNow = isRich ? "rich" : "text";
    var ed = richEditor(cur, function (html) { texts.set(bnd, pack(html, kindNow)); send({ type: "set-text", binding: bnd, html: html }); updateChrome(); }, { block: isRich });
    ed._area.id = "fld-text";
    p.appendChild(fld("Content", ed));
    p.appendChild(el("div", "h", "Typography"));
    var st = S.elStyles[bnd] = S.elStyles[bnd] || {}, base = sel.style || {};
    var upd = function () { cleanStyles(); commit({ skipPanels: true }); };
    p.appendChild(fld("Text colour", colorInput(st.color || "", function (v) { st.color = v; upd(); })));
    var grid = el("div", "grid2");
    grid.appendChild(fld("Size (px)", textInput(st.fontSize || "", function (v) { st.fontSize = v; upd(); }, "number")));
    grid.appendChild(fld("Weight", selectInput(st.fontWeight || "", ["", "400", "500", "600", "700", "800"], function (v) { st.fontWeight = v; upd(); })));
    p.appendChild(grid);
    var al = el("div", "align"); ["left", "center", "right"].forEach(function (a) {
      var bt = el("button", st.textAlign === a ? "is-on" : "", a === "left" ? "⬅" : a === "center" ? "↔" : "➡"); bt.title = a;
      bt.addEventListener("click", function () { st.textAlign = st.textAlign === a ? "" : a; upd(); renderSettings(); }); al.appendChild(bt);
    });
    p.appendChild(fld("Alignment", al));
    var it = el("label", "chk"), cb = el("input"); cb.type = "checkbox"; cb.checked = st.fontStyle === "italic";
    cb.addEventListener("change", function () { st.fontStyle = cb.checked ? "italic" : ""; upd(); }); it.append(cb, document.createTextNode(" Italic")); p.appendChild(it);
    p.appendChild(el("p", "hint", "Style changes apply to this field everywhere it appears on the site."));
    if (st.color === undefined && base.color) { /* default colour shown by browser */ }
  }

  function renderImageSettings(p) {
    var crumb = el("div", "crumb"); crumb.append(document.createTextNode("Image"), el("small", null, sel.binding || sel.file || "")); p.appendChild(crumb);
    p.appendChild(el("p", "hint", sel.file ? "This image is a fixed site asset. Replacing it updates the file for every page that uses it." : "Replace this image."));
    p.appendChild(fld("Image", imageInput(sel.src && sel.src.replace(/^[./]*/, "").replace(/^(\.\.\/)+/, ""), function (path) {
      if (sel.binding) { texts.set(sel.binding, path); send({ type: "set-image", binding: sel.binding, path: path }); updateChrome(); renderSettings(); }
      else if (sel.file) { replaceFile(sel.file, path); }
    })));
  }
  function replaceFile(file, uploadedPath) {
    // fixed asset: fetch the just-uploaded file and overwrite the asset through the classic endpoint
    fetch("/" + uploadedPath).then(function (r) { return r.blob(); }).then(readFile).then(function (dataUrl) {
      return api("/admin/api/upload", { name: file.split("/").pop(), dataUrl: dataUrl, file: file });
    }).then(function (r) { if (r.ok && r.data.ok) { toast("Asset replaced - reloading", "ok"); loadPage(page.path); } else toast((r.data && r.data.error) || "Replace failed", "err"); });
  }

  // ------------------------------------------------------------ site tab
  function renderSite() {
    var p = $("#panel-site"); p.innerHTML = "";
    if (!S) return;
    p.appendChild(el("div", "h", "Global colours"));
    p.appendChild(el("p", "hint", "Change the brand colours everywhere on the site."));
    GLOBAL_COLORS.forEach(function (c) {
      p.appendChild(fld(c[1], colorInput(S.globals[c[0]] || "", function (v) { if (v) S.globals[c[0]] = v; else delete S.globals[c[0]]; commit({ skipPanels: true }); })));
    });
    p.appendChild(el("div", "h", "Business details"));
    p.appendChild(el("p", "hint", "Shown across the site (header, footer, contact, offer banner)."));
    if (!siteVals) { api("/admin/api/studio/bindings", { bindings: SITE_FIELDS.map(function (f) { return f[0]; }) }).then(function (r) { siteVals = r.data.values || {}; renderSite(); }); return; }
    SITE_FIELDS.forEach(function (f) {
      var v = texts.has(f[0]) ? texts.get(f[0]) : (siteVals[f[0]] == null ? "" : siteVals[f[0]]);
      p.appendChild(fld(f[1], textInput(v, function (val) { texts.set(f[0], val); updateChrome(); })));
    });
  }

  // ---------------------------------------------------------- top bar bits
  $("#devices").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return; device = b.dataset.dev;
    $$("#devices button").forEach(function (x) { x.classList.toggle("is-on", x === b); }); $("#canvas").dataset.dev = device;
  });
  $("#undoBtn").addEventListener("click", undo); $("#redoBtn").addEventListener("click", redo);
  document.addEventListener("keydown", function (e) {
    var tag = (e.target.tagName || "").toLowerCase(); if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
  });

  // picker
  var pickerOpen = false;
  function renderPicker(q) {
    var list = $("#pickerList"); list.innerHTML = ""; q = (q || "").toLowerCase(); var last = "", shown = 0;
    pages.forEach(function (pg) {
      if (q && pg.path.toLowerCase().indexOf(q) < 0) return;
      if (shown > 250) return; shown++;
      if (pg.group !== last) { list.appendChild(el("div", "picker__group", pg.group)); last = pg.group; }
      var b = el("button", "picker__item" + (pg.path === page.path ? " is-on" : ""), pg.path); b.type = "button"; b.dataset.path = pg.path;
      b.addEventListener("click", function () { togglePicker(false); goto(pg.path); }); list.appendChild(b);
    });
    if (!shown) list.appendChild(el("div", "empty", "No pages match."));
  }
  function togglePicker(on) { pickerOpen = on === undefined ? !pickerOpen : on; $("#pickerPop").hidden = !pickerOpen; if (pickerOpen) { renderPicker(""); $("#pickerSearch").value = ""; $("#pickerSearch").focus(); } }
  $("#pickerBtn").addEventListener("click", function () { togglePicker(); });
  $("#pickerSearch").addEventListener("input", function (e) { renderPicker(e.target.value); });
  document.addEventListener("click", function (e) { if (pickerOpen && !e.target.closest("#picker")) togglePicker(false); });

  // ----------------------------------------------------------- save / publish
  function buildPayload() {
    var key = scopeKey(), d = clone(docs), pk = "page:" + page.pagekey, tk = "tpl:" + page.tpl;
    // the other scope's entry for this page is superseded
    var other = tplScope ? pk : tk;
    if (!tplScope) { /* page scope overrides template scope; leave the template entry alone */ } else { delete d.layout.pages[other]; delete d.blocks.pages[other]; delete d.styles.sections[other]; }
    d.layout.pages[key] = { order: S.order.slice(), hidden: S.hidden.slice() };
    var blocks = []; S.order.forEach(function (id) { if (S.blocks[id]) blocks.push({ id: id, type: S.blocks[id].type, props: S.blocks[id].props }); });
    if (blocks.length) d.blocks.pages[key] = blocks; else delete d.blocks.pages[key];
    cleanStyles();
    if (Object.keys(S.secStyles).length) d.styles.sections[key] = S.secStyles; else delete d.styles.sections[key];
    d.styles.elements = S.elStyles; d.styles.global = S.globals;
    var edits = []; texts.forEach(function (v, b) { edits.push({ binding: b, value: v }); });
    return { edits: edits, layout: d.layout, blocks: d.blocks, styles: d.styles };
  }
  var saving = false, lastEdit = Date.now();
  function save(quiet) {
    if (!isDirty() || saving) return; var btn = $("#saveBtn"); saving = true; btn.disabled = true; btn.textContent = "Saving..."; $("#status").textContent = "Saving draft...";
    var sentSnap = snap(), sentTexts = new Map(texts);
    api("/admin/api/studio/save", buildPayload()).then(function (r) {
      saving = false; btn.textContent = "Save draft";
      if (r.ok && r.data.ok) {
        // The canvas already shows these edits: keep it, just mark the work as saved.
        savedSnap = sentSnap; sentTexts.forEach(function (v, k) { if (texts.get(k) === v) texts.delete(k); });
        if (quiet !== true) toast("Draft saved. Publish when you are ready.", "ok");
        updateChrome(); $("#status").textContent = isDirty() ? "Unsaved changes" : "Draft saved - not published yet";
        return loadDocs().then(function () { siteVals = null; });
      }
      toast((r.data && r.data.error) || "Save failed. Your changes are still here.", "err"); updateChrome();
    }).catch(function (err) { saving = false; btn.textContent = "Save draft"; toast("Save failed. Your changes are still here.", "err"); console.error(err); updateChrome(); });
  }
  // Autosave: 15 seconds after the last change.
  setInterval(function () { if (isDirty() && !saving && Date.now() - lastEdit > 15000) save(true); }, 4000);
  $("#saveBtn").addEventListener("click", function () { save(); });

  var modalBack = $("#modalBack");
  function closeModal() { modalBack.hidden = true; }
  modalBack.addEventListener("click", function (e) { if (e.target === modalBack) closeModal(); });
  $("#publishBtn").addEventListener("click", function () {
    var m = $("#modal"); m.innerHTML = "";
    m.appendChild(el("h2", null, "Publish to the live site"));
    if (isDirty()) m.appendChild(el("p", "hint", "You have unsaved changes. They are saved as a draft first, then published."));
    m.appendChild(el("p", "hint", "Publishing sends every saved draft to the website's repository in one step. The site rebuilds automatically and your changes go live in a few minutes. Earlier versions stay available under Revisions."));
    var msg = el("input"); msg.type = "text"; msg.value = "Update site via Studio";
    m.append(fld("Note for the revision history", msg));
    var out = el("ul", "steps"); m.appendChild(out);
    var foot = el("div", "modal__foot"), cancel = el("button", "btn", "Close"), go = el("button", "btn btn--publish", "Publish");
    cancel.addEventListener("click", closeModal);
    function doPublish() {
      return api("/admin/api/publish", { message: msg.value }).then(function (r) {
        out.innerHTML = ""; ((r.data && r.data.steps) || []).forEach(function (s) { out.appendChild(el("li", null, "• " + s)); });
        if (r.data && r.data.error) out.appendChild(el("li", null, "⚠ " + r.data.error));
        var ok = r.ok && r.data && r.data.ok; go.textContent = ok ? "Done" : "Publish"; go.disabled = !!ok;
        toast(ok ? "Published" : "Publish failed", ok ? "ok" : "err");
      });
    }
    go.addEventListener("click", function () {
      go.disabled = true; go.textContent = "Publishing...";
      var pre = new Promise(function (res) { if (!isDirty()) return res(); var t = setInterval(function () { if (!saving) { clearInterval(t); res(); } }, 100); save(true); });
      pre.then(function () { if (isDirty()) throw new Error("save"); return doPublish(); }).catch(function () { go.textContent = "Publish"; go.disabled = false; toast("Could not publish. Check the draft saved first.", "err"); });
    });
    foot.append(cancel, go); m.appendChild(foot); modalBack.hidden = false;
  });

  window.addEventListener("beforeunload", function (e) { if (isDirty()) { e.preventDefault(); e.returnValue = ""; } });

  // ------------------------------------------------------------------- boot
  function boot() {
    renderWidgets(); renderSite();
    Promise.all([loadDocs(), api("/admin/api/studio/pages")]).then(function (res) {
      if (res[1].status === 401) { location.href = "/admin/login"; return; }
      pages = (res[1].data && res[1].data.pages) || [];
      var p = new URLSearchParams(location.search).get("p") || "/";
      loadPage(p);
    });
  }
  boot();
  window.__studio = { get S() { return S; }, get page() { return page; }, save: save, undo: undo, redo: redo, insert: insertBlock, state: function () { return clone(S); }, dirty: isDirty };
})();
