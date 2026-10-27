/* Wash4You admin: Blog posts. Registers the "Blog posts" view on the dashboard
   (see admin.js). All DOM is built with textContent / attributes; the only HTML
   shown is the live preview, which the server renders from Markdown, escapes and
   sanitises (see /admin/api/posts/preview) and which is parsed, not assigned. */
(function () {
  "use strict";
  var A = window.W4UAdmin;
  if (!A) return;
  var h = A.h, api = A.api, toast = A.toast, fail = A.fail, field = A.field, when = A.when, main = A.main, VIEWS = A.VIEWS;

  var siteUrl = "", categories = [];

  function slugify(t) {
    return String(t || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "");
  }
  function todayISO() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

  // How a post shows in the list and in the editor header.
  function badge(p) {
    var hidden = p.status === "draft";
    if (p.state === "deleting") return h("span", { class: "badge bad", text: "Will be deleted" });
    if (p.state === "new") return h("span", { class: "badge draft", text: "New draft" });
    if (p.state === "broken") return h("span", { class: "badge bad", text: "Needs fixing" });
    if (p.state === "edited") return h("span", { class: "badge draft", text: (hidden ? "Hidden" : "Live") + " · unpublished edits" });
    return hidden ? h("span", { class: "badge", style: "background:#eceff4;color:#5e7086", text: "Hidden" }) : h("span", { class: "badge ok", text: "Live" });
  }

  // ------------------------------------------------------------------ list
  VIEWS.blog = function () {
    leaveEditor();
    return api("/admin/api/posts").then(function (d) {
      siteUrl = d.siteUrl || ""; categories = d.categories || [];
      var q = h("input", { type: "search", placeholder: "Search posts...", class: "grow" });
      var filter = h("select", {}, [["", "All posts"], ["live", "Live"], ["draft", "Drafts & unpublished edits"], ["hidden", "Hidden"]].map(function (o) { return h("option", { value: o[0], text: o[1] }); }));
      var list = h("div");
      function match(p) {
        var s = q.value.toLowerCase();
        if (s && (p.title + " " + p.category + " " + p.slug).toLowerCase().indexOf(s) < 0) return false;
        var f = filter.value;
        if (f === "live") return p.state === "live" && p.status === "published";
        if (f === "draft") return p.state === "new" || p.state === "edited" || p.state === "deleting";
        if (f === "hidden") return p.status === "draft";
        return true;
      }
      function draw() {
        var rows = d.posts.filter(match).map(function (p) {
          var pub = p.state !== "new" && p.status === "published";
          if (p.state === "deleting") {
            return h("tr", {}, h("td", {}, h("b", { text: p.title }), h("div", { class: "status", text: "/" + p.slug + "/" })),
              h("td", { text: p.category }), h("td", { class: "nw", text: p.date || "-" }), h("td", {}, badge(p)), h("td", { text: "" }),
              h("td", {}, h("button", { class: "btn", onclick: function () { api("/admin/api/posts/discard", { slug: p.slug }).then(function () { toast("Deletion cancelled. The post stays."); VIEWS.blog(); }).catch(fail); } }, "Undo delete"), " ",
                h("button", { class: "btn btn--danger", onclick: function () { if (!confirm("Remove \u201c" + p.title + "\u201d from the live site?")) return; api("/admin/api/posts/publish", { slug: p.slug }).then(function (d) { toast((d.steps || ["Removed."]).join(" ")); VIEWS.blog(); }).catch(fail); } }, "Publish deletion")));
          }
          return h("tr", {},
            h("td", {}, h("a", { href: "#blog", onclick: function (e) { e.preventDefault(); edit(p.slug); } }, h("b", { text: p.title })), h("div", { class: "status", text: "/" + p.slug + "/" })),
            h("td", { text: p.category }), h("td", { class: "nw", text: p.date || "-" }), h("td", {}, badge(p)),
            h("td", { text: Math.max(1, Math.ceil(p.words / 200)) + " min" }),
            h("td", {}, h("button", { class: "btn", onclick: function () { edit(p.slug); } }, "Edit"), " ",
              pub ? h("a", { class: "btn", href: p.url, target: "_blank", rel: "noopener" }, "View") : null, " ",
              h("button", { class: "btn btn--danger", onclick: function () { removePost(p); } }, "Delete")));
        });
        list.replaceChildren(rows.length
          ? h("table", {}, h("thead", {}, h("tr", {}, ["Post", "Topic", "Date", "Status", "Read", ""].map(function (t) { return h("th", { text: t }); }))), h("tbody", {}, rows))
          : h("p", { class: "empty", text: d.posts.length ? "No posts match." : "No posts yet. Click New post to write your first article." }));
      }
      function removePost(p) {
        var msg = p.state === "new" ? "Delete this draft? It was never published." : "Delete “" + p.title + "”? It stays on the live site until you publish the deletion.";
        if (!confirm(msg)) return;
        api("/admin/api/posts/delete", { slug: p.slug }).then(function () { toast(p.state === "new" ? "Draft deleted." : "Marked for deletion. Publish it to remove it from the site."); VIEWS.blog(); }).catch(fail);
      }
      q.addEventListener("input", draw); filter.addEventListener("change", draw);
      main.replaceChildren(
        h("div", { class: "top" }, h("h1", { text: "Blog posts" }), h("span", { class: "sp" }),
          siteUrl ? h("a", { class: "btn", href: siteUrl + "/blog/", target: "_blank", rel: "noopener" }, "View blog") : null,
          h("button", { class: "btn btn--primary", onclick: function () { edit(null); } }, "New post")),
        h("div", { class: "panel" }, h("div", { class: "row", style: "margin-bottom:12px" }, q, filter), list,
          h("p", { class: "status", text: "Write and save drafts here; nothing goes live until you click Publish on a post. After publishing, the site rebuilds and the post appears in a few minutes." })));
      draw();
    });
  };

  // ---------------------------------------------------------------- editor
  var dirty = false, timers = [], guard = null, beforeUnload = null;
  function leaveEditor() {
    timers.forEach(clearInterval); timers = [];
    var nav = document.getElementById("nav");
    if (guard) { nav.removeEventListener("click", guard, true); guard = null; }
    if (beforeUnload) { window.removeEventListener("beforeunload", beforeUnload); beforeUnload = null; }
    dirty = false;
  }

  function pickImage(done) {
    var q = h("input", { type: "search", placeholder: "Search images...", class: "grow" });
    var grid = h("div", { class: "media" }), file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml", hidden: true });
    function load() {
      return api("/admin/api/media?q=" + encodeURIComponent(q.value) + "&limit=120").then(function (d) {
        grid.replaceChildren.apply(grid, d.items.map(function (m) {
          return h("button", { class: "tile", type: "button", onclick: function () { A.closeModal(); done(m); } },
            h("img", { src: "/" + m.url, alt: m.alt, loading: "lazy" }), h("span", { text: (m.draft ? "New: " : "") + m.name }));
        }));
        if (!d.items.length) grid.replaceChildren(h("p", { class: "empty", text: "No images found. Upload one." }));
      }).catch(fail);
    }
    file.addEventListener("change", function () {
      if (!file.files[0]) return;
      A.readFile(file.files[0]).then(function (u) { return api("/admin/api/media/upload", { name: file.files[0].name, dataUrl: u }); })
        .then(function () { toast("Uploaded. It publishes together with the post that uses it."); return load(); }).catch(fail);
    });
    q.addEventListener("input", function () { clearTimeout(q.t); q.t = setTimeout(load, 250); });
    A.modal(h("div", { class: "pick" }, h("h2", { text: "Choose an image" }),
      h("div", { class: "row", style: "margin-bottom:12px" }, q, h("button", { class: "btn btn--primary", type: "button", onclick: function () { file.click(); } }, "Upload new"), file,
        h("button", { class: "btn", type: "button", onclick: A.closeModal }, "Close")), grid));
    load();
  }

  function edit(slug) {
    leaveEditor();
    Promise.all([slug ? api("/admin/api/posts/item?slug=" + encodeURIComponent(slug)) : Promise.resolve(null), api("/admin/api/posts")]).then(function (r) {
      siteUrl = r[1].siteUrl || siteUrl; categories = r[1].categories || categories;
      build(r[0] ? r[0].post : { isNew: true, slug: "", title: "", date: todayISO(), excerpt: "", meta_description: "", category: "", author: "", image: "", status: "published", body: "", state: "new", live: false });
    }).catch(fail);
  }

  // Used by the Pages list: jump straight into a post's editor.
  A.openPost = function (slug) {
    Array.prototype.forEach.call(document.querySelectorAll("#nav button"), function (b) { b.classList.toggle("is-on", b.dataset.v === "blog"); });
    edit(slug);
  };

  function build(post) {
    var isNew = !!post.isNew, slugTouched = !isNew, state = post.state, live = !!post.live;
    var title = h("input", { value: post.title, maxlength: 140, placeholder: "e.g. How to care for silk sarees" });
    var slugIn = h("input", { value: post.slug, maxlength: 80, placeholder: "web-address-of-the-post", disabled: !isNew });
    var slugMsg = h("div", { class: "hint" });
    var date = h("input", { type: "date", value: post.date });
    var cat = h("input", { value: post.category, list: "w4u-cats", maxlength: 40, placeholder: "Pick a topic or type a new one" });
    var catList = h("datalist", { id: "w4u-cats" }, categories.map(function (c) { return h("option", { value: c }); }));
    var author = h("input", { value: post.author, maxlength: 60, placeholder: "The Wash4You team" });
    var excerpt = h("textarea", { maxlength: 300, rows: 3, placeholder: "One or two sentences. Shown on the blog page and as the card text." }, post.excerpt);
    var exCount = h("div", { class: "count" });
    var metaDesc = h("textarea", { maxlength: 200, rows: 2, placeholder: "Optional. What Google shows under the title. Leave empty to use the summary." }, post.meta_description);
    var mdCount = h("div", { class: "count" });
    var body = h("textarea", { class: "md", spellcheck: "true", placeholder: "Write your article here. Use the buttons above for headings, lists and links." }, post.body);
    var visibility = h("select", {}, [h("option", { value: "published", text: "Visible on the website" }), h("option", { value: "draft", text: "Hidden (not shown)" })]);
    visibility.value = post.status;
    var coverBox = h("div", { class: "cover" }), cover = post.image;
    var stat = h("div", { class: "status" }), saved = h("span", { class: "hint" }), err = h("p", { class: "login__err", role: "alert" });
    var pvBody = h("div", { class: "pv" }), pvToc = h("div", { class: "hint" }), meta = h("div", { class: "hint" });

    function drawCover() {
      coverBox.replaceChildren(
        cover ? h("img", { src: "/" + cover, alt: "" }) : h("p", { class: "empty", text: "No cover image. The blog card will use the topic's default picture." }),
        h("div", { class: "row", style: "margin-top:8px" },
          h("button", { class: "btn", type: "button", onclick: function () { pickImage(function (m) { cover = m.url; mark(); drawCover(); }); } }, cover ? "Change image" : "Choose image"),
          cover ? h("button", { class: "btn", type: "button", onclick: function () { cover = ""; mark(); drawCover(); } }, "Remove") : null));
    }
    function counts() {
      exCount.textContent = excerpt.value.length + "/300 · aim for 120 to 160"; exCount.className = "count" + (excerpt.value.length > 300 ? " bad" : "");
      mdCount.textContent = metaDesc.value.length + "/160 recommended"; mdCount.className = "count" + (metaDesc.value.length > 160 ? " bad" : "");
    }
    function drawStatus() {
      var p = { state: state, status: visibility.value };
      var kids = [badge(p)];
      if (live && visibility.value === "published" && state !== "new") kids.push(h("span", {}, " ", h("a", { href: siteUrl + "/" + slugIn.value + "/", target: "_blank", rel: "noopener", text: "View live post" })));
      stat.replaceChildren.apply(stat, kids);
      publishBtn.textContent = state === "new" ? "Publish post" : "Publish changes";
      discardBtn.hidden = state !== "edited";
    }
    function mark() { dirty = true; saved.textContent = "Unsaved changes"; }

    // Live preview (debounced)
    var pt;
    function preview() {
      clearTimeout(pt);
      pt = setTimeout(function () {
        api("/admin/api/posts/preview", { body: body.value }).then(function (d) {
          // Server-rendered, escaped and sanitised HTML. Parsed into an inert document and moved
          // across, rather than assigned with innerHTML.
          pvBody.replaceChildren.apply(pvBody, Array.prototype.slice.call(new DOMParser().parseFromString(d.html, "text/html").body.childNodes));
          pvToc.textContent = d.toc.length ? "In this article: " + d.toc.map(function (t) { return t.text; }).join(" · ") : "";
          meta.textContent = d.words + " words · " + d.readMinutes + " min read";
        }).catch(function () { /* preview is best-effort */ });
      }, 350);
    }

    // Toolbar
    function sel() { return { s: body.selectionStart, e: body.selectionEnd, v: body.value }; }
    function put(text, from, to, selFrom, selTo) {
      body.value = text; body.focus(); body.setSelectionRange(selFrom, selTo); mark(); preview();
    }
    function wrap(before, after, ph) {
      var x = sel(), chosen = x.v.slice(x.s, x.e) || ph;
      put(x.v.slice(0, x.s) + before + chosen + after + x.v.slice(x.e), 0, 0, x.s + before.length, x.s + before.length + chosen.length);
    }
    function prefixLines(fn, ph) {
      var x = sel(), start = x.v.lastIndexOf("\n", x.s - 1) + 1, endIdx = x.v.indexOf("\n", x.e); if (endIdx < 0) endIdx = x.v.length;
      var chunk = x.v.slice(start, endIdx) || ph, lines = chunk.split("\n").map(fn).join("\n");
      put(x.v.slice(0, start) + lines + x.v.slice(endIdx), 0, 0, start, start + lines.length);
    }
    function insertBlock(text) {
      // Goes in at the END of the selection (never replaces selected text), on its own paragraph.
      var x = sel(), at = x.e, pre = at > 0 && x.v[at - 1] !== "\n" ? "\n\n" : at > 0 && x.v.slice(at - 2, at) !== "\n\n" ? "\n" : "";
      var out = x.v.slice(0, at) + pre + text + "\n\n" + x.v.slice(at), pos = at + pre.length + text.length + 2;
      put(out, 0, 0, pos, pos);
    }
    function tb(label, titleText, fn) { return h("button", { class: "btn", type: "button", title: titleText, onclick: fn }, label); }
    var toolbar = h("div", { class: "bar" },
      tb("H2", "Section heading", function () { prefixLines(function (l) { return "## " + l.replace(/^#+\s*/, ""); }, "Heading"); }),
      tb("H3", "Sub-heading", function () { prefixLines(function (l) { return "### " + l.replace(/^#+\s*/, ""); }, "Sub-heading"); }),
      tb("Bold", "Bold", function () { wrap("**", "**", "bold text"); }),
      tb("Italic", "Italic", function () { wrap("*", "*", "italic text"); }),
      tb("Link", "Link", function () {
        var x = sel(), label = x.v.slice(x.s, x.e) || "link text";
        var url = prompt("Where should it link to?\nUse https://... for another website, or /pricing/ for a page on this site.", "https://");
        if (!url) return;
        if (!/^(https?:\/\/|\/)/.test(url.trim())) { toast("Links must start with https:// or /", true); return; }
        put(x.v.slice(0, x.s) + "[" + label + "](" + url.trim() + ")" + x.v.slice(x.e), 0, 0, x.s + 1, x.s + 1 + label.length);
      }),
      tb("• List", "Bullet list", function () { prefixLines(function (l) { return "- " + l.replace(/^[-*+]\s+/, ""); }, "List item"); }),
      tb("1. List", "Numbered list", function () { var n = 0; prefixLines(function (l) { n += 1; return n + ". " + l.replace(/^\d+[.)]\s+/, ""); }, "List item"); }),
      tb("Quote", "Quote", function () { prefixLines(function (l) { return "> " + l.replace(/^>\s*/, ""); }, "Quote"); }),
      tb("Image", "Insert an image from the library", function () {
        pickImage(function (m) {
          var alt = prompt("Describe this image in a few words (for screen readers and Google):", m.alt || "");
          if (alt === null) return;
          insertBlock("![" + alt.replace(/[\[\]\n]/g, " ").trim() + "](" + m.url + ")");
        });
      }));

    // Save / publish
    function payload() {
      return { isNew: isNew, slug: slugIn.value.trim(), title: title.value, date: date.value, excerpt: excerpt.value, meta_description: metaDesc.value, category: cat.value, author: author.value, image: cover, status: visibility.value, body: body.value };
    }
    function save(silent) {
      err.textContent = "";
      return api("/admin/api/posts/save", payload()).then(function (d) {
        isNew = false; slugIn.disabled = true; state = d.post.state; live = d.post.live; dirty = false;
        saved.textContent = (silent ? "Autosaved " : "Draft saved ") + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        if (!silent) toast("Draft saved. It is not live until you publish.");
        drawStatus(); return d.post;
      }).catch(function (e) { err.textContent = e.message; if (!silent) fail(e); throw e; });
    }
    var saveBtn = h("button", { class: "btn", type: "button", onclick: function () { save(false).catch(function () {}); } }, "Save draft");
    var publishBtn = h("button", { class: "btn btn--primary", type: "button", onclick: function () {
      if (!confirm(visibility.value === "draft" ? "Publish this change? The post will be hidden from the website." : "Publish this post to the live site?")) return;
      publishBtn.disabled = true;
      save(false).then(function () { return api("/admin/api/posts/publish", { slug: slugIn.value.trim() }); }).then(function (d) {
        toast((d.steps || ["Published."]).join(" ")); dirty = false;
        edit(slugIn.value.trim());
      }).catch(function (e) { err.textContent = e.message; fail(e); publishBtn.disabled = false; });
    } }, "Publish post");
    var discardBtn = h("button", { class: "btn", type: "button", hidden: true, onclick: function () {
      if (!confirm("Throw away your unpublished changes and go back to the live version of this post?")) return;
      api("/admin/api/posts/discard", { slug: slugIn.value.trim() }).then(function () { dirty = false; toast("Changes discarded."); edit(slugIn.value.trim()); }).catch(fail);
    } }, "Discard changes");
    var deleteBtn = h("button", { class: "btn btn--danger", type: "button", onclick: function () {
      if (!confirm(isNew && state === "new" ? "Discard this draft?" : "Delete this post? It stays live until you publish the deletion.")) return;
      var go = isNew ? Promise.resolve() : api("/admin/api/posts/delete", { slug: slugIn.value.trim() });
      go.then(function () { dirty = false; toast(isNew ? "Draft discarded." : "Marked for deletion. Publish it to remove it from the site."); VIEWS.blog(); }).catch(fail);
    } }, "Delete post");

    // Slug: auto from the title until the author edits it; availability check for new posts.
    var st;
    function checkSlug() {
      if (!isNew) return;
      clearTimeout(st);
      st = setTimeout(function () {
        var s = slugIn.value.trim(); if (!s) { slugMsg.textContent = ""; return; }
        api("/admin/api/posts/slug-check?slug=" + encodeURIComponent(s)).then(function (d) {
          slugMsg.textContent = d.ok ? "✓ " + (siteUrl || "") + "/" + s + "/ is available" : d.problem; slugMsg.className = "hint" + (d.ok ? " good" : " bad");
        }).catch(function () {});
      }, 350);
    }
    title.addEventListener("input", function () { if (isNew && !slugTouched) { slugIn.value = slugify(title.value); checkSlug(); } mark(); });
    slugIn.addEventListener("input", function () { slugTouched = true; checkSlug(); mark(); });
    [date, cat, author, visibility].forEach(function (el) { el.addEventListener("input", function () { mark(); drawStatus(); }); });
    [excerpt, metaDesc].forEach(function (el) { el.addEventListener("input", function () { mark(); counts(); }); });
    body.addEventListener("input", function () { mark(); preview(); });
    body.addEventListener("keydown", function (e) { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); save(false).catch(function () {}); } });

    // Leaving with unsaved work: warn on tab close and on dashboard navigation; autosave every 30 s.
    guard = function (e) { if (dirty && !confirm("You have unsaved changes in this post. Leave without saving?")) { e.stopPropagation(); e.preventDefault(); } else if (dirty) { dirty = false; } };
    document.getElementById("nav").addEventListener("click", guard, true);
    beforeUnload = function (e) { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    timers.push(setInterval(function () { if (dirty && title.value.trim().length >= 3 && slugIn.value.trim() && body.value.trim().length >= 20 && excerpt.value.trim().length >= 10) save(true).catch(function () {}); }, 30000));

    drawCover(); counts(); drawStatus(); preview();
    if (isNew) { slugMsg.textContent = ""; } else { slugMsg.textContent = "The web address can't be changed after the post exists, so existing links keep working."; }
    main.replaceChildren(
      h("div", { class: "top" }, h("button", { class: "btn", type: "button", onclick: function () { VIEWS.blog(); } }, "← All posts"), h("h1", { text: isNew ? "New post" : "Edit post" }), h("span", { class: "sp" }), saved),
      h("div", { class: "ed" },
        h("div", { class: "ed__main" },
          h("div", { class: "panel" }, h("h2", { text: "Details" }),
            field("Title", title),
            h("div", { class: "f" }, h("label", { text: "Web address" }), h("div", { class: "slugrow" }, h("span", { text: (siteUrl || "https://wash4you.in").replace(/^https?:\/\//, "") + "/" }), slugIn, h("span", { text: "/" })), slugMsg),
            h("div", { class: "grid2" }, field("Publish date", date), h("div", {}, field("Topic", cat), catList)),
            field("Author (optional)", author),
            field("Summary", excerpt), exCount,
            field("Search description (optional)", metaDesc), mdCount),
          h("div", { class: "panel" }, h("h2", { text: "Cover image" }), coverBox),
          h("div", { class: "panel" }, h("h2", { text: "Article" }), toolbar, body,
            h("p", { class: "hint", text: "Use ## for sections. A blank line starts a new paragraph. Tip: type a topic first, then pick Image to add pictures from your library." }))),
        h("div", { class: "ed__side" },
          h("div", { class: "panel" }, h("h2", { text: "Publish" }), stat, field("Visibility", visibility),
            h("div", { class: "row", style: "margin-top:14px" }, saveBtn, publishBtn, discardBtn, deleteBtn), err,
            h("p", { class: "hint", text: "Save draft keeps your work private. Publish sends it to the website; the site rebuilds in a few minutes. Unpublished changes also appear under Drafts & publishing." })),
          h("div", { class: "panel" }, h("h2", { text: "Preview" }), meta, pvToc,
            h("div", { class: "pvwrap" }, h("h3", { class: "pvtitle" }), pvBody)))));
    // keep the preview heading in sync with the title field
    var pvTitle = main.querySelector(".pvtitle"); pvTitle.textContent = title.value || "Untitled post";
    title.addEventListener("input", function () { pvTitle.textContent = title.value || "Untitled post"; });
    if (isNew) title.focus();
    dirty = false; saved.textContent = isNew ? "Not saved yet" : "";
  }
})();
