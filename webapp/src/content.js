// All site content in one place — edit here, not in components.
// Sourced from the client's existing site data (src/data/*.json).

export const site = {
  name: 'Wash4You',
  phone: '+91 63 67 600 500',
  phoneHref: 'tel:+916367600500',
  email: 'care@wash4you.in',
  emailHref: 'mailto:care@wash4you.in',
  whatsapp: 'https://wa.me/6367600500',
  booking: 'https://app.wash4you.in/website/W10571',
  rating: '4.8',
  reviews: '2,000+',
  legalName: 'M/S VAARUNI VENTURES LLP',
  social: {
    facebook: 'https://www.facebook.com/profile.php?id=61581209511675#',
    instagram: 'https://www.instagram.com/wash4you._?igsh=b3Jvb2w1c2tmcWly',
    linkedin: 'https://www.linkedin.com/company/wash4you-eco-friendly-laundry-and-dryclean/',
    youtube: 'https://www.youtube.com/channel/UCji5ILTjdrl-DOXf8loAX8Q',
  },
}

export const stores = [
  {
    name: 'Wash4You Vyapar Kendra',
    address: 'Shop 180 GF, Sushant Vyapar Kendra, Sushant Lok 1, Gurugram 122022',
  },
  {
    name: 'Wash4You Arcadia',
    address: 'AG-75 GF, Block A, Unitech Arcadia, Sector 49, Gurugram 122018',
  },
]

export const nav = [
  { label: 'Services', href: '#services' },
  { label: 'How It Works', href: '#how-it-works' },
  { label: 'Pricing', href: '#pricing' },
  { label: 'Service Area', href: '#service-area' },
  { label: 'Contact', href: '#contact' },
]

export const services = [
  { icon: 'leaf', name: 'Eco-Friendly Laundry', from: '₹79/pc', text: 'Planet-safe cleaning using biodegradable, non-toxic solvents — ideal for delicate skin.' },
  { icon: 'hanger', name: 'Premium Dry Cleaning', from: '₹99/pc', text: 'Precision care for suits, sarees, silks, and delicates using gentle, garment-safe methods.' },
  { icon: 'iron', name: 'Steam Ironing', from: '₹29/pc', text: 'Sharp, crease-free results with steam press technology for a polished finish on every item.' },
  { icon: 'shoe', name: 'Shoe Cleaning', from: '₹299/pair', text: 'From sneakers to suede — deep-cleaned, deodorized, and restored to like-new condition.' },
  { icon: 'blanket', name: 'Blankets & Quilts', from: '₹299/pc', text: 'Deep cleaning for blankets and quilts to restore softness, freshness, and comfort.' },
  { icon: 'curtain', name: 'Curtains & Carpets', from: '₹39/sq ft', text: 'Dust, stains, and odours removed professionally — without compromising the fabric.' },
  { icon: 'bag', name: 'Bag & Leather Care', from: '₹499/pc', text: 'Handbags, jackets, and leather goods cleaned, conditioned, and reshaped by specialists.' },
  { icon: 'linen', name: 'Linens & More', from: '₹119/pc', text: 'Bed sheets, table linens, toys, and accessories — crisp, hygienic, hotel-fresh.' },
]

export const pricing = [
  {
    title: 'Laundry (per piece)',
    popular: true,
    items: [
      { name: 'Wash and Fold', price: '₹79' },
      { name: 'Wash and Steam Iron', price: '₹109' },
      { name: 'Premium Laundry', price: '₹149' },
      { name: 'Steam Iron only (from)', price: '₹29' },
    ],
  },
  {
    title: 'Dry Cleaning — Clothing',
    items: [
      { name: 'Shirt / T-Shirt / Trouser / Jeans', price: '₹99' },
      { name: 'Kurta', price: '₹119' },
      { name: 'Sweater', price: '₹149' },
      { name: 'Saree / Dress (from)', price: '₹199' },
      { name: 'Coat / Jacket / Kurta Fancy', price: '₹249' },
      { name: 'Men Suit 2 Pcs', price: '₹349' },
      { name: 'Lehenga (from)', price: '₹399' },
      { name: 'Sherwani', price: '₹449' },
      { name: 'Leather Jacket', price: '₹599' },
    ],
  },
  {
    title: 'Home & Footwear',
    items: [
      { name: 'Carpet (per sq ft)', price: '₹39' },
      { name: 'Single Bed Sheet', price: '₹119' },
      { name: 'Curtain (per panel)', price: '₹149' },
      { name: 'Double Bed Sheet', price: '₹199' },
      { name: 'Single Blanket (1 ply)', price: '₹299' },
      { name: 'Sports Shoes', price: '₹299' },
      { name: 'Double Blanket (1 ply)', price: '₹399' },
      { name: 'Leather Shoes', price: '₹499' },
    ],
  },
]

export const pricingNote = 'GST extra — all prices exclusive of GST. Full rate list available on request.'

export const areas = [
  'Cyber City',
  'DLF Phase 3',
  'Golf Course Road',
  'Golf Course Extension',
  'Sector 29',
  'Sushant Lok',
  'Palam Vihar',
  'Sohna Road',
]

export const whyUs = [
  {
    icon: 'truck',
    title: 'Free pickup & delivery',
    text: 'Doorstep service across Gurugram and Delhi NCR at no extra charge.',
  },
  {
    icon: 'clock',
    title: '24-hour turnaround',
    text: 'Clothes back clean, crisp, and ready to wear within a day.',
  },
  {
    icon: 'leaf',
    title: 'Eco-friendly cleansers',
    text: 'Biodegradable, non-toxic formulas — gentle on skin and the planet.',
  },
  {
    icon: 'shield',
    title: 'Satisfaction guaranteed',
    text: "Quality checks at every step. Not happy? We'll make it right.",
  },
]

export const testimonials = [
  {
    quote:
      'Wash4You has completely changed how I manage laundry. The pickup is always on time and clothes come back perfectly folded.',
    author: 'Priya S.',
    location: 'Gurugram',
  },
  {
    quote:
      'Their dry cleaning is excellent. My suits and sarees have never looked better, and the free delivery is a huge plus.',
    author: 'Rahul M.',
    location: 'Delhi NCR',
  },
  {
    quote:
      "Eco-friendly cleaning that actually works. I feel good using Wash4You for my family's clothes.",
    author: 'Anita K.',
    location: 'Sector 29, Gurugram',
  },
]

export const faqs = [
  {
    q: 'How fast will I get my clothes back?',
    a: 'Standard turnaround is 24 hours from pickup to delivery. Delicate items like lehengas, leather, or curtains can take longer — we confirm the timeline when we collect them.',
  },
  {
    q: 'Is pickup and delivery really free?',
    a: 'Yes. Doorstep pickup and delivery are free across our Gurugram service areas — no hidden charges.',
  },
  {
    q: 'Which areas do you serve?',
    a: 'We serve Gurugram including Cyber City, DLF Phase 3, Golf Course Road & Extension, Sector 29, Sushant Lok, Palam Vihar, and Sohna Road. Use the area checker above or message us on WhatsApp to confirm your locality.',
  },
  {
    q: 'What cleaning technology do you use?',
    a: 'European hydrocarbon dry-cleaning technology — a low-temperature, fabric-safe method that preserves the texture, shape, and colour of delicate garments, plus biodegradable detergents for laundry.',
  },
  {
    q: 'How do I pay?',
    a: 'Nothing to pay when you book — payment is due on or before delivery. Our team shares payment options when your order is ready.',
  },
  {
    q: 'What if something goes wrong with my order?',
    a: "Every item is quality-checked before delivery. If you're not happy, contact us within 24 hours of delivery and we'll re-clean the item or make it right under our satisfaction guarantee.",
  },
]

export const steps = [
  {
    title: 'Schedule a pickup',
    text: 'Book in seconds on WhatsApp or our booking app. Pick a time slot that suits you — pickup is always free.',
  },
  {
    title: 'We collect & clean',
    text: 'Your clothes are digitally tagged, sorted by fabric, and cleaned with eco-friendly Italian hydrocarbon technology.',
  },
  {
    title: 'Delivered fresh in 24 hrs',
    text: 'Folded or on hangers, quality-checked, and returned to your door the very next day.',
  },
]
