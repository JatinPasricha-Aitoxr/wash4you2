/* Wash4You Studio - canvas script. Runs INSIDE the editor iframe.
   It is deliberately "dumb": it reports what is on the page and obeys commands
   from the editor shell (postMessage). All state lives in the shell. */
(function () {
  "use strict";
  if (window.parent === window) return; // only inside the Studio iframe
  var root = document.documentElement;
  root.classList.add("w4s", "w4s-live");

  function post(msg) { window.parent.postMessage(Object.assign({ w4s: 1 }, msg), "*"); }
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function mainEl() { return document.getElementById("main"); }
  function sections() { return $$("[data-sec]", mainEl()).filter(function (s) { return s.parentElement && !s.parentElement.closest("[data-sec]"); }); }

  // ------------------------------------------------------------ UI parts
  var bar = document.createElement("div");
  bar.id = "w4s-bar";
  bar.innerHTML = '<span class="w4s-lbl"></span>' +
    '<button data-a="up" title="Move up">&#8593;</button><button data-a="down" title="Move down">&#8595;</button>' +
    '<button data-a="hide" title="Hide / show">&#128065;</button>' +
    '<button data-a="dup" title="Duplicate">&#10697;</button><button data-a="del" title="Delete">&#128465;</button>';
  var drop = document.createElement("div"); drop.id = "w4s-drop";
  document.body.append(bar, drop);

  var hoverSec = null, selSec = null;

  function secInfo(el) {
    return { id: el.getAttribute("data-sec"), label: el.getAttribute("data-sec-label") || (el.querySelector("h1,h2,h3") || {}).textContent || "Section",
             hidden: el.hasAttribute("data-sec-hidden"), block: el.hasAttribute("data-block"), type: el.getAttribute("data-block-type") || "" };
  }
  function listSections() { return sections().map(function (s) { var i = secInfo(s); i.label = (i.label || "").trim().slice(0, 60); return i; }); }
  function announce() { post({ type: "sections", sections: listSections(), title: document.title, path: location.pathname,
    pagekey: document.body.getAttribute("data-pagekey"), tpl: document.body.getAttribute("data-tpl") }); }

  function placeBar(el) {
    var r = el.getBoundingClientRect();
    var info = secInfo(el);
    bar.querySelector(".w4s-lbl").textContent = (info.block ? "Widget: " : "") + (info.label || "Section").trim().slice(0, 40);
    bar.querySelector('[data-a="dup"]').disabled = !info.block;
    bar.querySelector('[data-a="del"]').disabled = !info.block;
    bar.style.top = Math.max(window.scrollY + r.top - 28, window.scrollY + 2) + "px";
    bar.style.left = Math.max(window.scrollX + r.left + 8, 4) + "px";
    bar.classList.add("is-on");
  }
  function hoverTo(el) {
    if (hoverSec === el) return;
    if (hoverSec) hoverSec.classList.remove("w4s-hover");
    hoverSec = el;
    if (el) { el.classList.add("w4s-hover"); placeBar(el); } else if (!selSec) bar.classList.remove("is-on");
  }
  function select(el, silent) {
    if (selSec) selSec.classList.remove("w4s-selected");
    selSec = el;
    if (el) { el.classList.add("w4s-selected"); placeBar(el); if (!silent) post({ type: "select", kind: "section", id: el.getAttribute("data-sec") }); }
  }

  document.addEventListener("mousemove", function (e) {
    if (e.target.closest("#w4s-bar")) return;
    var s = e.target.closest && e.target.closest("[data-sec]");
    hoverTo(s && mainEl() && mainEl().contains(s) ? topSection(s) : null);
  });
  function topSection(el) { while (el.parentElement && el.parentElement.closest("[data-sec]")) el = el.parentElement.closest("[data-sec]"); return el; }
  document.addEventListener("mouseleave", function () { hoverTo(null); if (selSec) placeBar(selSec); });
  window.addEventListener("scroll", function () { var t = hoverSec || selSec; if (t) placeBar(t); }, { passive: true });
  window.addEventListener("resize", function () { var t = hoverSec || selSec; if (t) placeBar(t); });

  bar.addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b || b.disabled) return;
    var el = hoverSec || selSec; if (!el) return;
    post({ type: "section-action", action: b.getAttribute("data-a"), id: el.getAttribute("data-sec") });
  });

  // ---------------------------------------------------------- click routing
  document.addEventListener("click", function (e) {
    if (e.target.closest("#w4s-bar")) return;
    var a = e.target.closest("a[href]");
    var cmsEl = e.target.closest("[data-cms]");
    var fileImg = e.target.closest("[data-cms-file]");
    // Never navigate or submit while editing; but report in-site links so the shell can open them.
    if (a && !cmsEl) {
      e.preventDefault(); e.stopPropagation();
      post({ type: "navigate", href: a.getAttribute("href"), abs: a.href });
      return;
    }
    if (fileImg || (cmsEl && cmsEl.getAttribute("data-cms-kind") === "image") || (cmsEl && cmsEl.tagName === "IMG")) {
      e.preventDefault(); e.stopPropagation();
      var t = fileImg || cmsEl;
      post({ type: "select", kind: "image", binding: t.getAttribute("data-cms"), file: t.getAttribute("data-cms-file"), src: t.getAttribute("src") || "" });
      markSection(t);
      return;
    }
    if (cmsEl) {
      e.preventDefault(); e.stopPropagation();
      startEdit(cmsEl);
      markSection(cmsEl);
      return;
    }
    var s = e.target.closest("[data-sec]");
    if (s && mainEl() && mainEl().contains(s)) { e.preventDefault(); select(topSection(s)); }
  }, true);
  document.addEventListener("submit", function (e) { e.preventDefault(); }, true);
  function markSection(el) { var s = el.closest("[data-sec]"); if (s) select(topSection(s), true); }

  // ----------------------------------------------------------- rich-text toolbar
  var RT = "<!--rt-->";
  var rt = document.createElement("div"); rt.id = "w4s-rt";
  rt.innerHTML = '<button data-c="bold" title="Bold (Ctrl+B)"><b>B</b></button><button data-c="italic" title="Italic (Ctrl+I)"><i>I</i></button>' +
    '<button data-c="underline" title="Underline (Ctrl+U)"><u>U</u></button><span class="w4s-sep"></span>' +
    '<button data-c="link" title="Link">&#128279;</button><button data-c="unlink" title="Remove link">&#9986;</button>' +
    '<span class="w4s-block"><span class="w4s-sep"></span><button data-c="insertUnorderedList" title="Bullet list">&#8226;&#8801;</button>' +
    '<button data-c="insertOrderedList" title="Numbered list">1.&#8801;</button></span>' +
    '<span class="w4s-sep"></span><input type="color" data-c="color" title="Text colour" value="#000000">' +
    '<button data-c="removeFormat" title="Clear formatting">&#10006;</button>';
  document.body.appendChild(rt);
  rt.addEventListener("mousedown", function (e) { if (e.target.tagName !== "INPUT") e.preventDefault(); });
  rt.addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return; var c = b.getAttribute("data-c");
    if (c === "link") { var url = prompt("Link address (https://..., tel:..., /page/)", "https://"); if (url) document.execCommand("createLink", false, url); }
    else document.execCommand(c, false, null);
    if (editing) post({ type: "text-live", binding: editing.getAttribute("data-cms"), html: editing.innerHTML });
  });
  rt.querySelector('input[type=color]').addEventListener("input", function (e) {
    document.execCommand("styleWithCSS", false, true); document.execCommand("foreColor", false, e.target.value);
    if (editing) post({ type: "text-live", binding: editing.getAttribute("data-cms"), html: editing.innerHTML });
  });
  function placeRt(el, blockOk) {
    var r = el.getBoundingClientRect();
    rt.classList.toggle("w4s-noblock", !blockOk);
    rt.style.top = Math.max(window.scrollY + r.top - 44, window.scrollY + 4) + "px";
    rt.style.left = Math.max(window.scrollX + r.left, 4) + "px";
    rt.classList.add("is-on");
  }
  function hasFormatting(html) { return /<(b|strong|i|em|u|a|ul|ol|li|br|p|div|span|h[2-4]|blockquote)\b/i.test(html); }
  function plain(html) { var d = document.createElement("div"); d.innerHTML = html.replace(/<br\s*\/?>/gi, " "); return d.textContent.replace(/\s+/g, " ").trim(); }
  function pack(html, kind) { return kind === "rich" ? html : (hasFormatting(html) ? RT + html : plain(html)); }

  // ----------------------------------------------------------- text editing
  var editing = null;
  function curStyle(el) {
    var c = getComputedStyle(el);
    return { color: rgb2hex(c.color), fontSize: parseFloat(c.fontSize) || 16, fontWeight: c.fontWeight, textAlign: c.textAlign, fontStyle: c.fontStyle, textTransform: c.textTransform };
  }
  function rgb2hex(rgb) {
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || ""); if (!m) return "#000000";
    return "#" + [m[1], m[2], m[3]].map(function (n) { return ("0" + (+n).toString(16)).slice(-2); }).join("");
  }
  function startEdit(el) {
    if (editing && editing !== el) finishEdit(editing);
    var kind = el.getAttribute("data-cms-kind") || "text";
    post({ type: "select", kind: "text", binding: el.getAttribute("data-cms"), cmsKind: kind,
           value: el.innerText, html: el.innerHTML, style: curStyle(el) });
    if (el.isContentEditable) return;
    el.dataset.w4sOrig = el.innerHTML;
    el.setAttribute("contenteditable", "true");
    el.classList.add("w4s-active");
    el.focus();
    editing = el;
    placeRt(el, kind === "rich");
  }
  function finishEdit(el) {
    if (!el.isContentEditable) return;
    el.removeAttribute("contenteditable");
    el.classList.remove("w4s-active");
    if (editing === el) editing = null;
    var kind = el.getAttribute("data-cms-kind") || "text";
    var orig = (el.dataset.w4sOrig || "").trim();
    var html = el.innerHTML.trim();
    rt.classList.remove("is-on");
    if (html !== orig) {
      el.classList.add("w4s-dirty");
      post({ type: "text-edit", binding: el.getAttribute("data-cms"), value: pack(html, kind), html: html });
    }
  }
  document.addEventListener("focusout", function (e) {
    if (!e.target.isContentEditable) return;
    if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("#w4s-rt")) return;
    finishEdit(e.target);
  }, true);
  document.addEventListener("keydown", function (e) {
    var el = e.target; if (!el.isContentEditable) return;
    var kind = el.getAttribute("data-cms-kind") || "text";
    if (e.key === "Enter" && kind !== "rich") { e.preventDefault(); el.blur(); }
    else if (e.key === "Escape") { el.innerText = el.dataset.w4sOrig || el.innerText; el.blur(); }
  });
  document.addEventListener("input", function (e) {
    var el = e.target; if (el.isContentEditable && el.getAttribute("data-cms")) {
      post({ type: "text-live", binding: el.getAttribute("data-cms"), html: el.innerHTML });
    }
  });

  // ------------------------------------------------------ drag & drop (widgets)
  var dragging = false;
  function dropTarget(y) {
    var secs = sections(), before = null, line = 0;
    for (var i = 0; i < secs.length; i++) {
      var r = secs[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { before = secs[i]; line = r.top + window.scrollY; break; }
      line = r.bottom + window.scrollY;
    }
    return { before: before, y: line };
  }
  document.addEventListener("dragover", function (e) {
    if (!dragging) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "copy";
    var t = dropTarget(e.clientY);
    drop.style.top = (t.y - 2) + "px"; drop.classList.add("is-on");
  });
  document.addEventListener("drop", function (e) {
    if (!dragging) return;
    e.preventDefault();
    var t = dropTarget(e.clientY);
    drop.classList.remove("is-on"); root.classList.remove("w4s-dragging"); dragging = false;
    post({ type: "drop", beforeId: t.before ? t.before.getAttribute("data-sec") : null });
  });
  document.addEventListener("dragleave", function (e) { if (!e.relatedTarget) drop.classList.remove("is-on"); });

  // ---------------------------------------------------------- state commands
  var liveStyle = document.createElement("style"); liveStyle.id = "w4s-live-css"; document.head.appendChild(liveStyle);

  function applyOrder(cmd) {
    var main = mainEl(); if (!main) return;
    var existing = {}; sections().forEach(function (s) { existing[s.getAttribute("data-sec")] = s; });
    // blocks that were deleted
    Object.keys(existing).forEach(function (id) {
      if (cmd.order.indexOf(id) < 0 && existing[id].hasAttribute("data-block")) { existing[id].remove(); delete existing[id]; }
    });
    // new / replaced block html
    Object.keys(cmd.blocks || {}).forEach(function (id) {
      var tpl = document.createElement("template"); tpl.innerHTML = cmd.blocks[id].trim();
      var el = tpl.content.firstElementChild; if (!el) return;
      el.setAttribute("data-sec", id); el.setAttribute("data-sec-label", cmd.labels && cmd.labels[id] || "Widget");
      if (existing[id]) { existing[id].replaceWith(el); } else { main.appendChild(el); }
      existing[id] = el;
    });
    var secs = sections();
    var parent = secs.length ? secs[0].parentElement : main;
    var marker = document.createComment("w4s"); parent.insertBefore(marker, secs.length ? secs[0] : null);
    // put every section right after the marker, in the requested order
    var frag = document.createDocumentFragment();
    cmd.order.forEach(function (id) { if (existing[id]) frag.appendChild(existing[id]); });
    marker.parentNode.insertBefore(frag, marker.nextSibling);
    marker.remove();
    var hid = cmd.hidden || [];
    sections().forEach(function (s) { if (hid.indexOf(s.getAttribute("data-sec")) >= 0) s.setAttribute("data-sec-hidden", "1"); else s.removeAttribute("data-sec-hidden"); });
    var empty = $("#w4s-empty"); if (empty) empty.remove();
    if (!sections().length) { var d = document.createElement("div"); d.id = "w4s-empty"; d.textContent = "This page has no sections yet. Drag a widget here."; main.appendChild(d); }
  }

  window.addEventListener("message", function (e) {
    var m = e.data; if (!m || !m.w4s) return;
    if (m.type === "apply") {
      applyOrder(m);
      liveStyle.textContent = m.css || "";
      // text style hooks: any bound element with an override gets data-sid
      (m.styledBindings || []).forEach(function (b) { $$('[data-cms="' + cssEsc(b) + '"]').forEach(function (el) { el.setAttribute("data-sid", b); }); });
      if (selSec && !document.contains(selSec)) { selSec = null; bar.classList.remove("is-on"); }
      if (selSec) placeBar(selSec);
      announce();
    } else if (m.type === "select-section") {
      var el = $('[data-sec="' + cssEsc(m.id) + '"]');
      if (el) { select(el, true); if (m.scroll !== false) el.scrollIntoView({ block: "start", behavior: "auto" }); window.scrollBy(0, -60); placeBar(el); }
    } else if (m.type === "set-text") {
      var t = $('[data-cms="' + cssEsc(m.binding) + '"]');
      if (t) { t.innerHTML = m.html; t.classList.add("w4s-dirty"); }
    } else if (m.type === "set-image") {
      var im = m.binding ? $('[data-cms="' + cssEsc(m.binding) + '"]') : $('[data-cms-file="' + cssEsc(m.file) + '"]');
      if (im) { im.src = "/" + m.path; im.removeAttribute("srcset"); im.classList.add("w4s-dirty"); }
    } else if (m.type === "drag") {
      dragging = !!m.on; root.classList.toggle("w4s-dragging", dragging); if (!dragging) drop.classList.remove("is-on");
    } else if (m.type === "clear-selection") {
      select(null, true); bar.classList.remove("is-on");
    }
  });
  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  // ------------------------------------------------------------------ boot
  function boot() {
    if (!sections().length && mainEl()) { var d = document.createElement("div"); d.id = "w4s-empty"; d.textContent = "This page has no sections yet. Drag a widget here."; mainEl().appendChild(d); }
    // The site's own scripts (animations, rails) can hide things; make everything visible for editing.
    $$(".reveal,.stagger-children").forEach(function (el) { el.classList.add("is-visible", "in", "visible"); });
    $$("img[loading=lazy]").forEach(function (i) { i.loading = "eager"; });
    announce();
    post({ type: "ready" });
  }
  if (document.readyState === "complete") boot(); else window.addEventListener("load", boot);
})();
