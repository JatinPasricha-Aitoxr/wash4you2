/* Wash4You — bundle entry.

   Built by `npm run build:js` into src/assets/js/main.js as a minified IIFE,
   loaded with `defer` from base.html. Motion is bundled in and tree-shaken;
   there is no CDN request and no separate vendor file.

   Everything that animates lives in ./motion/. This file owns only the three
   behaviours that are pure DOM logic:
     - marking the current nav link
     - the contact form's WhatsApp handoff
     - booting the modules

   Each init is called inside its own try/catch. These modules are independent,
   and a throw in one must not stop the rest of the page from working.
*/

import { initReveal } from './motion/reveal.js'
import { initHero } from './motion/hero.js'
import { initFlowRail } from './motion/flowRail.js'
import { initScroll } from './motion/scroll.js'
import { initUI } from './motion/ui.js'
import { initBeforeAfter } from './ba.js'
import { initCart } from './cart.js'
import { initReviewModal } from './reviewModal.js'
import { initPriceFilter } from './priceFilter.js'
import { initCoverageFilter } from './coverageFilter.js'
import { initSvcFilter } from './svcFilter.js'

const boot = (name, fn) => {
  try {
    fn()
  } catch (err) {
    // Never let one broken module take the page down with it.
    console.error(`[wash4you] ${name} failed to init`, err)
  }
}

/* ---------------------------------------------------------------------------
   Mark the nav link for the section the visitor is in.
   Href values are relative ("../services/"), so normalise to a root path
   before comparing — the site is served from nested directories.
   --------------------------------------------------------------------------- */
function markActiveNav() {
  const path = window.location.pathname
  document.querySelectorAll('.header__link, .mobile-nav__link').forEach((link) => {
    const href = link.getAttribute('href')
    if (!href || href.startsWith('http')) return
    const target = href.replace(/^(\.\.\/)+/, '/').replace(/\/+$/, '/')
    if (target !== '/' && path.startsWith(target.startsWith('/') ? target : '/' + target)) {
      link.classList.add('is-active')
      link.setAttribute('aria-current', 'page')
    }
  })
}

/* ---------------------------------------------------------------------------
   Contact form → WhatsApp.
   Static host, so there is no form backend. Submitting composes a WhatsApp
   message instead. The form keeps its mailto: action as the no-JS fallback,
   so this only ever intercepts when the script is actually running.
   --------------------------------------------------------------------------- */
function initContactForm() {
  const form = document.getElementById('contact-form')
  if (!form) return

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const data = new FormData(form)
    const lines = [
      'Hello Wash4You! I have an enquiry.',
      'Name: ' + (data.get('name') || '-'),
      'Phone: ' + (data.get('phone') || '-'),
      'Service: ' + (data.get('service') || '-'),
      'Message: ' + (data.get('message') || '-'),
    ]
    const wa = form.getAttribute('data-whatsapp') || 'https://wa.me/916367600500'
    window.open(wa + '?text=' + encodeURIComponent(lines.join('\n')), '_blank', 'noopener')
  })
}

boot('nav', markActiveNav)
boot('contact-form', initContactForm)
boot('before-after', initBeforeAfter)
boot('cart', () => initCart(document))
boot('hero', initHero)
boot('flow-rail', initFlowRail)
boot('reveal', initReveal)
boot('scroll', initScroll)
boot('ui', initUI)
boot('review-modal', initReviewModal)
boot('price-filter', initPriceFilter)
boot('coverage-filter', initCoverageFilter)
boot('svc-filter', initSvcFilter)
