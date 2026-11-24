/* Pricing location selector (req 2b).

   The rate list is identical across Gurugram areas — only the framing label
   changes. On load this reads ?location=<slug> from the URL, syncs the
   <select>, and updates the "Prices for <Area>, Gurugram" heading. Changing
   the selector rewrites ?location= via history.replaceState (no navigation)
   and updates the heading in place.

   Plain, dependency-free and defensive: it only runs where the selector is
   present (the main /pricing/ page), and no-ops everywhere else — so it is
   safe to load on the shared pricing template.
*/
(function () {
  'use strict';

  function optionForSlug(select, slug) {
    if (!slug) return null;
    for (var i = 0; i < select.options.length; i++) {
      if (select.options[i].value === slug) return select.options[i];
    }
    return null;
  }

  function init() {
    var select = document.getElementById('pricing-location-select');
    if (!select) return; // area pages / no selector — nothing to wire.
    var nameEl = document.querySelector('[data-location-name]');

    function label(opt) {
      return opt ? opt.textContent : '';
    }

    function setHeading(opt) {
      if (nameEl && opt) nameEl.textContent = label(opt);
    }

    function updateUrl(slug) {
      try {
        var url = new URL(window.location.href);
        url.searchParams.set('location', slug);
        window.history.replaceState(null, '', url.toString());
      } catch (e) {
        /* URL/History unsupported — the on-page label still updates. */
      }
    }

    // Initial state from the URL, defaulting to the first area if absent/invalid.
    var params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (e) {
      params = null;
    }
    var requested = params ? params.get('location') : null;
    var opt = optionForSlug(select, requested);

    if (opt) {
      select.value = opt.value;
      setHeading(opt);
    } else {
      // Default to whatever option is currently selected (the first).
      setHeading(select.options[select.selectedIndex] || select.options[0]);
    }

    select.addEventListener('change', function () {
      var current = select.options[select.selectedIndex];
      setHeading(current);
      if (current) updateUrl(current.value);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
