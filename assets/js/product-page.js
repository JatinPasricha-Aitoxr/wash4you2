/**
 * Wash4You Product Page Interactions
 * Handles service selection, pricing display updates, cart sync, and smooth navigation.
 */
(function () {
  'use strict';

  function initProductPage() {
    const buybox = document.getElementById('product-buybox');
    if (!buybox) return;

    let productData = null;
    const rawDataEl = document.getElementById('product-json-data');
    if (rawDataEl) {
      try {
        productData = JSON.parse(rawDataEl.textContent);
      } catch (err) {
        console.warn('[wash4you] Could not parse product-json-data', err);
      }
    }

    const priceDisplay = document.getElementById('product-price-display');
    const serviceNameDisplay = document.getElementById('product-selected-service-name');
    const serviceDescDisplay = document.getElementById('product-service-desc');
    const serviceIncludesEl = document.getElementById('product-service-includes');
    const serviceButtons = document.querySelectorAll('[data-service-select]');
    const addBtn = document.getElementById('product-add-cart-btn');
    const unitDisplay = document.getElementById('product-price-unit');
    const turnaroundDisplay = document.getElementById('product-turnaround');

    // ---- City (Gurgaon / Delhi) -------------------------------------------
    // One choice per visitor, remembered across pages. Every [data-pg]
    // element carries both rates; switching rewrites its text.
    const CITY_KEY = 'w4y-city';
    let city = 'gurgaon';
    try { city = localStorage.getItem(CITY_KEY) === 'delhi' ? 'delhi' : 'gurgaon'; } catch (e) { /* storage blocked */ }
    const cityButtons = document.querySelectorAll('[data-city]');

    function pricesFor(svc) {
      return city === 'delhi'
        ? { price: svc.price_delhi || svc.price, amount: svc.amount_delhi != null ? svc.amount_delhi : svc.amount }
        : { price: svc.price, amount: svc.amount };
    }

    function applyCity() {
      document.querySelectorAll('[data-pg]').forEach((el) => {
        el.textContent = city === 'delhi' ? el.dataset.pd : el.dataset.pg;
      });
      cityButtons.forEach((btn) => {
        const on = btn.dataset.city === city;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      const active = document.querySelector('[data-service-select].is-active');
      const id = active ? active.dataset.serviceSelect : (productData && productData.services[0] && productData.services[0].id);
      if (id) setService(id);
    }

    cityButtons.forEach((btn) => btn.addEventListener('click', function () {
      city = this.dataset.city;
      try { localStorage.setItem(CITY_KEY, city); } catch (e) { /* ignore */ }
      applyCity();
    }));

    const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    function setService(serviceId) {
      if (!productData || !productData.services) return;
      const svc = productData.services.find((s) => s.id === serviceId);
      if (!svc) return;

      // Update button visual state
      serviceButtons.forEach((btn) => {
        const isMatch = btn.dataset.serviceSelect === serviceId;
        btn.classList.toggle('is-active', isMatch);
        btn.setAttribute('aria-pressed', isMatch ? 'true' : 'false');
      });

      // Update price and text
      const rate = pricesFor(svc);
      if (priceDisplay) {
        priceDisplay.textContent = rate.price;
      }
      if (unitDisplay) {
        unitDisplay.textContent = (svc.unit ? svc.unit + ' ' : '') + '+ 18% GST';
      }
      if (turnaroundDisplay && svc.turnaround) {
        turnaroundDisplay.textContent = 'Turnaround ' + svc.turnaround;
      }
      if (serviceNameDisplay) {
        serviceNameDisplay.textContent = svc.name;
      }
      if (serviceDescDisplay) {
        serviceDescDisplay.textContent = svc.longDescription || svc.shortDescription;
      }

      // Update includes list if present
      if (serviceIncludesEl && svc.includes) {
        serviceIncludesEl.innerHTML = svc.includes
          .map((item) => `<li><span class="prod-check" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span><span>${escapeHtml(item)}</span></li>`)
          .join('');
      }

      // Update buybox data-attributes for cart.js
      buybox.dataset.slug = svc.slug;
      buybox.dataset.name = `${productData.name} (${svc.name})`;
      buybox.dataset.amount = String(rate.amount);
      buybox.dataset.price = rate.price;
      buybox.dataset.img = productData.heroImageFallback || productData.heroImage || '';
    }

    // Attach click handlers to service pills/buttons
    serviceButtons.forEach((btn) => {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        const serviceId = this.dataset.serviceSelect;
        setService(serviceId);
      });
    });

    // Cross-links from the comparison cards ("Choose Dry Clean & Press", etc.)
    document.querySelectorAll('[data-choose-service]').forEach((link) => {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        const serviceId = this.dataset.chooseService;
        setService(serviceId);
        const target = document.getElementById('service-selector');
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });

    // "Add to Cart" feedback
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        const origContent = this.innerHTML;
        this.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Added to Cart!`;
        this.classList.add('is-added');

        setTimeout(() => {
          this.innerHTML = origContent;
          this.classList.remove('is-added');
        }, 1800);

        // Open cart drawer after 250ms so user sees the item in their list
        setTimeout(() => {
          const drawer = document.getElementById('cart-drawer');
          const backdrop = document.getElementById('cart-backdrop');
          if (drawer && !drawer.classList.contains('is-open')) {
            drawer.classList.add('is-open');
            drawer.setAttribute('aria-hidden', 'false');
            if (backdrop) backdrop.hidden = false;
            document.body.classList.add('cart-lock');
          }
        }, 300);
      });
    }

    // Initialize with the service named in ?service= (the price list's
    // steam-press links use it), else the first one.
    if (productData && productData.services && productData.services.length > 0) {
      const wanted = new URLSearchParams(window.location.search).get('service');
      const match = productData.services.find((s) => s.id === wanted);
      setService(match ? match.id : productData.services[0].id);
      applyCity();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initProductPage);
  } else {
    initProductPage();
  }
})();

