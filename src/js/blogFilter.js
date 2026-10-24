/* Blog index — filter articles by topic.

   Progressive enhancement: the server renders every article, so with no JS
   (or if this throws) the page is simply the full list. The chosen topic is
   mirrored in ?topic=… so a filtered view can be linked to — the article
   pages link their topic chip here. */

export function initBlogFilter(root = document) {
  const grid = root.querySelector('[data-blog-grid]')
  const buttons = Array.from(root.querySelectorAll('[data-blog-filter]'))
  if (!grid || !buttons.length) return

  const cards = Array.from(grid.querySelectorAll('[data-blog-card]'))
  const empty = root.querySelector('[data-blog-empty]')
  const topics = new Set(buttons.map((b) => b.dataset.blogFilter))

  function apply(topic, updateUrl) {
    if (!topics.has(topic)) topic = ''
    let shown = 0
    cards.forEach((card) => {
      const match = !topic || card.dataset.topic === topic
      card.hidden = !match
      if (match) shown += 1
    })
    // The first visible card leads the grid, whatever the topic.
    cards.forEach((c) => c.classList.remove('post-card--feature'))
    const first = cards.find((c) => !c.hidden)
    if (first && !topic) first.classList.add('post-card--feature')
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.blogFilter === topic)))
    if (empty) empty.hidden = shown !== 0
    if (updateUrl) {
      const url = new URL(window.location.href)
      if (topic) url.searchParams.set('topic', topic)
      else url.searchParams.delete('topic')
      window.history.replaceState(null, '', url)
    }
  }

  buttons.forEach((b) => b.addEventListener('click', () => apply(b.dataset.blogFilter, true)))
  apply(new URLSearchParams(window.location.search).get('topic') || '', false)
}
