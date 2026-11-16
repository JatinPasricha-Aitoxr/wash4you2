#!/usr/bin/env python3
"""Generate src/data/coverage-pages.json — the registry for the non-Gurugram
service-area ("coverage") pages.

Why this file exists
--------------------
areas.json lists localities in Delhi, Noida & Greater Noida, Faridabad and
Ghaziabad as covered. Wash4You has NO shop, counter or processing unit in any
of those cities — both stores are in Gurugram. So these pages are deliberately
a different page type from the Gurugram area pages in area-pages.json:

  * they never name a "nearest store" in that city,
  * they carry an explicit line saying there is no branch there and that the
    cleaning happens in Gurugram,
  * their schema is a Service with an areaServed Place — never a LocalBusiness
    with a local address,
  * they promise no turnaround time, no same-day delivery, no local landmark
    knowledge, and invent no societies, builders or testimonials.

Copy is composed from structured fields (city, zone, locality, locality kind)
against per-city sentence banks, with the variant chosen deterministically from
a hash of the slug, so no two pages are the same paragraph with the name
swapped. Re-running this script is idempotent.

Usage:  python3 tools/gen-coverage-pages.py
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "src" / "data"

PHONE = "+91 63 67 600 500"

# Localities listed under more than one city in areas.json. They are real
# places in exactly one of them, so the page is built once, under the city it
# actually belongs to; the other city's coverage list links to that same page.
CANONICAL_CITY = {
    "Indirapuram": "ghaziabad",
    "Vaishali": "ghaziabad",
    "Kaushambi": "ghaziabad",
}

CITY_META = {
    "delhi": {
        "label": "Delhi",
        "state": "Delhi",
        "hub_slug": "laundry-service-delhi",
        "short": "Delhi",
    },
    "noida": {
        "label": "Noida",
        "state": "Uttar Pradesh",
        "hub_slug": "laundry-service-noida",
        "short": "Noida",
    },
    "faridabad": {
        "label": "Faridabad",
        "state": "Haryana",
        "hub_slug": "laundry-service-faridabad",
        "short": "Faridabad",
    },
    "ghaziabad": {
        "label": "Ghaziabad",
        "state": "Uttar Pradesh",
        "hub_slug": "laundry-service-ghaziabad",
        "short": "Ghaziabad",
    },
}

# ---------------------------------------------------------------------------
# Sentence banks. Everything here is either true of the business everywhere
# (free doorstep pickup, counted at the door, eco solvents, 15 services) or is
# an honest statement about NOT having a presence in that city. Nothing here
# names a building, a society, a landmark or a turnaround time.
# ---------------------------------------------------------------------------

# The disclosure. One of these appears, in full, on every coverage page.
DISCLOSURE = {
    "delhi": [
        "Wash4You is a Gurugram business. We do not run a shop, a counter or a "
        "processing unit anywhere in Delhi — every piece we collect is cleaned at "
        "our Gurugram facility and brought back. {loc} sits inside the Delhi "
        "coverage area we list, which means we will take a booking from here and "
        "agree the collection day with you on the phone before anything moves.",
        "There is no Wash4You branch in Delhi. Both our shops are in Gurugram, and "
        "so is the plant, so an order from {loc} is a run into the city and back "
        "rather than a local drop-off. We say that plainly up front, because the "
        "day we can collect depends on it.",
        "To be clear about what this page is: a service-area page, not a branch "
        "page. Wash4You has no address in Delhi. {loc} is on our Delhi coverage "
        "list, the cleaning is done in Gurugram, and the pickup day is something "
        "we confirm with you rather than something we advertise.",
    ],
    "noida": [
        "Wash4You has no shop in Noida or Greater Noida. Both counters and the "
        "plant are in Gurugram, and {loc} is on the coverage list we publish for "
        "this side of the river — so a booking here is arranged by phone, with the "
        "collection day agreed before we set off.",
        "This is a coverage page, not a branch page. There is no Wash4You address "
        "in {city}; what we have is Gurugram, and a van that crosses for booked "
        "orders. If you are in {loc}, tell us what you have and we will tell you "
        "honestly when we can be there.",
        "Wash4You is based in Gurugram and cleans everything in Gurugram. We list "
        "{loc} as covered, which means we take bookings from it — it does not mean "
        "there is a counter round the corner, and we would rather say so than let "
        "you find out on the day.",
    ],
    "faridabad": [
        "Wash4You does not have a branch in Faridabad. The two shops and the plant "
        "are in Gurugram. {loc} is inside the Faridabad coverage area we list, so "
        "we will take the booking — the collection day is agreed with you on the "
        "phone first, because it is a scheduled run rather than a local pickup.",
        "Straight answer first: there is no Wash4You counter in {city}. Everything "
        "is washed, dry cleaned and pressed in Gurugram. {loc} is on the coverage "
        "list, and an order from here is collected on a day we fix with you.",
        "This page covers {loc} as a service area. It is not a shop listing — "
        "Wash4You has no premises in Faridabad, and pretending otherwise would only "
        "waste your time. What we do have is free doorstep collection on an agreed "
        "day, and a Gurugram plant doing the actual work.",
    ],
    "ghaziabad": [
        "Wash4You has no premises in Ghaziabad. Our shops and our plant are in "
        "Gurugram, at the other end of the NCR. {loc} appears on the coverage list "
        "we publish, which means we accept bookings from it and agree the pickup "
        "day with you before we come.",
        "Worth being blunt: there is no Wash4You counter in {loc} or anywhere else "
        "in {city}. The cleaning happens in Gurugram. This page exists so you know "
        "what we will and will not do from here, not to suggest a branch that does "
        "not exist.",
        "A service-area page, honestly labelled. Wash4You operates out of Gurugram "
        "— two shops, one plant, no Ghaziabad address. {loc} is covered in the "
        "sense that we will take a booking and fix a collection day with you.",
    ],
}

LEDE = {
    "delhi": [
        "{loc} is on the Delhi list of areas Wash4You collects from. Pickup and "
        "delivery are free, everything is counted at your door against a written "
        "receipt, and the cleaning itself is done at our Gurugram plant.",
        "Laundry, dry cleaning and household textiles collected from {loc} on a day "
        "we agree with you. Free doorstep pickup, a written count at the door, and "
        "biodegradable solvents rather than the harsh stuff.",
        "If you are in {loc} and tired of carrying bags anywhere, Wash4You will come "
        "and take them. We are a Gurugram operation serving {loc} as a booked "
        "collection — free pickup, free delivery, itemised receipt.",
        "Fifteen services, one collection: wash and fold, dry cleaning, steam "
        "ironing, curtains, carpets, sofas, shoes and leather, picked up free from "
        "{loc} and returned to the same door.",
    ],
    "noida": [
        "{loc} is inside the Noida coverage area Wash4You books collections from. "
        "Free pickup and delivery, an itemised count at your door, and eco-friendly "
        "cleaning done at our Gurugram plant.",
        "Wash4You collects laundry, dry cleaning and home textiles from {loc} on an "
        "agreed day. Nothing is weighed out of sight — every piece is counted in "
        "front of you and written down.",
        "Booked doorstep collection from {loc}: everyday wash, formal wear, "
        "woollens, curtains, upholstery and shoes, taken away free and brought back "
        "to the same address.",
        "From {loc}, Wash4You takes the whole load — clothes, linen and the heavy "
        "household things a home machine cannot manage — with free pickup and a "
        "written receipt at the door.",
    ],
    "faridabad": [
        "{loc} is on the Faridabad coverage list. Wash4You collects free from your "
        "door on an agreed day, counts every piece in front of you, and cleans it "
        "at the Gurugram plant.",
        "Laundry and dry cleaning collected from {loc} without you leaving the "
        "house. Free pickup, free delivery, biodegradable solvents, and a receipt "
        "that lists what we actually took.",
        "Wash4You books doorstep collections in {loc} — shirts and everyday wash, "
        "sarees and suits, quilts, curtains, carpets, shoes and bags — all of it on "
        "one pickup.",
        "A booked pickup from {loc} covers everything in the price list: wash and "
        "fold, premium dry cleaning, steam ironing and the bulky household items.",
    ],
    "ghaziabad": [
        "{loc} is on the Ghaziabad coverage list Wash4You books collections from. "
        "Free doorstep pickup and delivery, an itemised count at your door, cleaning "
        "done in Gurugram.",
        "Wash4You will collect laundry, dry cleaning and home textiles from {loc} on "
        "a day agreed with you — free both ways, with everything written down before "
        "it leaves your hands.",
        "From {loc}: everyday wash, office shirts, sarees and suits, winter quilts, "
        "curtains and upholstery, collected free and returned to the same door.",
        "One booking from {loc} covers the whole list — fifteen services, one van, "
        "one written receipt, no trip to a shop.",
    ],
}

# Second body section: how a booking from a non-Gurugram address actually works.
HOW_IT_WORKS = [
    "## How a collection from {loc} is arranged\n\n"
    "You call or WhatsApp **{phone}** and tell us roughly what is coming — a weekly "
    "wash, four suits, a set of curtains, a quilt. Because {loc} is outside "
    "Gurugram, we do not hand you a two-hour slot on the spot; we tell you which "
    "day we can be in {city} and fix a window on that day. At the door everything "
    "is counted in front of you and written on a receipt, so the list you sign is "
    "the list we clean. The same receipt comes back with the order.",

    "## What actually happens after you book\n\n"
    "A booking from {loc} is a scheduled run, not a local errand, so the first "
    "thing we do is agree a day. After that it is the same process as anywhere "
    "else: we count the pieces with you at the door, note anything already stained "
    "or already damaged, and give you a written receipt. The load travels to "
    "Gurugram, is sorted by fabric rather than by customer, and comes back to the "
    "same address. Call or WhatsApp **{phone}** to start it.",

    "## Booking from outside Gurugram\n\n"
    "Tell us what you have and where in {city} you are, and we will tell you the "
    "next day we can reach {loc} — a real answer rather than a promise we cannot "
    "keep. Nothing is collected before that day is agreed. Everything is counted at "
    "your door against a written receipt, and delicate or dry-clean-only pieces are "
    "flagged there and then rather than discovered later. **{phone}**.",

    "## The practical part\n\n"
    "Collections in {loc} run to an agreed day rather than an on-demand slot, "
    "because the van is coming from Gurugram. Once the day is set, the rest is "
    "ordinary: doorstep count, written receipt, sorted and cleaned by fabric at our "
    "plant, returned to the same door. Free both ways, whatever the size of the "
    "load. Book on **{phone}** or over WhatsApp.",

    "## From the first call to the doorstep\n\n"
    "Step one is a conversation, not a form: ring or message **{phone}**, say you "
    "are in {loc} and describe the load. Step two is a date — we name the next day "
    "we are running into {city} and you say whether it works. Step three is the "
    "doorstep count, itemised and signed. After that the order is out of your hands "
    "until it comes back, and the receipt is how you check it.",

    "## What we ask you to do, and what we do\n\n"
    "Your side is short: tell us what you have, be there when we said, and take the "
    "curtains down before we arrive if curtains are part of it. Our side is the "
    "rest — the run out to {loc}, the count at the door, the sorting by fabric, the "
    "cleaning at the Gurugram plant and the return to the same address. Free both "
    "ways. **{phone}**.",
]

# First body section: what people in this kind of locality typically send.
WHAT_WE_TAKE = {
    "highrise": [
        "## What comes out of a high-rise flat\n\n"
        "In a tower block the laundry problem is rarely the shirts. It is the things "
        "that will not fit the machine in the utility balcony: the winter quilts that "
        "come out for eight weeks and then need cleaning before they go back into "
        "storage, the living-room curtains nobody has taken down in two years, the "
        "sofa covers that have quietly gone a shade darker. Those are the pieces we "
        "are asked for most from flats in {loc}, alongside the weekly wash-and-fold "
        "and a steady run of office shirts that want proper steam pressing rather "
        "than a domestic iron.",

        "## The usual load from {loc}\n\n"
        "Weekly wash and fold, office wear pressed properly, and — on a slower "
        "rhythm — the heavy household textiles. Curtains and blinds, carpets and "
        "rugs, mattress and upholstery cleaning, quilts and blankets at the turn of "
        "the season. There is also the specialist end of it: leather jackets and "
        "bags, shoes, and the sarees and suits that should go out for dry cleaning "
        "rather than into a drum with everything else.",
    ],
    "plotted": [
        "## Big houses, different laundry\n\n"
        "A plotted house or builder floor generates a different list from a flat. "
        "More rooms means more drapes, more rugs and more linen in rotation, and "
        "those are exactly the items a home machine cannot take. From {loc} we are "
        "most often asked for curtains, carpets, sofa covers and seasonal woollens, "
        "with the everyday wash and the ironing pile underneath it all.",

        "## What we usually collect here\n\n"
        "The everyday half is simple enough: wash and fold, shirts and trousers "
        "steam pressed, school and office wear on a weekly cycle. The other half is "
        "the household stuff that builds up quietly in an older, larger home in "
        "{loc} — curtains, rugs, upholstery, quilts and blankets, plus the sarees, "
        "suits and woollens that need dry cleaning rather than washing.",
    ],
    "mixed": [
        "## What we take from {loc}\n\n"
        "The full list, in one collection: wash and fold for the everyday clothes, "
        "premium dry cleaning for sarees, suits and formal wear, steam ironing for "
        "the pile that has been waiting on a chair, and the bulky items — quilts, "
        "blankets, curtains, carpets, mattresses, sofa covers — that are the real "
        "reason most people call a laundry service in the first place. Shoes, bags "
        "and leather are handled as their own processes, never thrown in with a "
        "normal load.",

        "## Everything in one pickup\n\n"
        "People in {loc} tend to book us for one of two reasons: the weekly wash has "
        "become a chore, or something bulky needs cleaning and there is no way to do "
        "it at home. We take both on the same visit. Clothes are sorted by fabric "
        "and colour rather than by household; curtains, carpets and upholstery are "
        "counted separately and priced by the piece; leather and shoes go to the "
        "people who do only that.",

        "## The range we actually cover\n\n"
        "Fifteen services, and you do not have to choose in advance. A single "
        "collection from {loc} can carry a week of ordinary clothes, two suits for "
        "dry cleaning, a quilt, a pair of shoes and a set of curtains — each priced "
        "on its own line, each counted at the door. The price list on this site is "
        "the price list; there is no separate out-of-Gurugram rate card.",
    ],
    "student": [
        "## Shared flats, PGs and hostels\n\n"
        "Around the institutes and the rented blocks in {loc}, the laundry is "
        "high-volume and low-drama: a lot of everyday clothes, bedsheets that need "
        "doing far more often than anyone admits, and a jacket or a formal shirt "
        "before an interview. Wash and fold plus steam ironing covers most of it, "
        "and bulk arrangements exist for PGs, hostels and co-living operators who "
        "would rather not run machines themselves.",

        "## The usual list here\n\n"
        "Everyday wash and fold, bedsheets and towels, a steady trickle of formal "
        "wear before placements and interviews, and quilts at both ends of winter. "
        "Where {loc} has PGs, hostels or co-living blocks, we can quote for the "
        "whole building rather than flat by flat — ask when you call.",
    ],
    "market": [
        "## A working locality's laundry\n\n"
        "{loc} mixes homes with shops and offices, and the laundry reflects it: "
        "uniforms and staff wear that has to look presentable every day, table and "
        "kitchen linen, alongside the ordinary household wash. We take commercial "
        "and domestic loads on the same visit, counted and billed separately so "
        "nobody has to untangle them later.",

        "## Homes and businesses both\n\n"
        "Some of what we collect around {loc} is household — the weekly wash, the "
        "ironing pile, the seasonal quilts. Some of it is not: staff uniforms, "
        "linen, covers and curtains from shops and small offices. Both are welcome "
        "on the same pickup, and both are counted piece by piece at the door.",
    ],
}

# Closing body section, used on roughly half the pages for length variation.
CLOSING = [
    "## Pricing and what is not different here\n\n"
    "The rate card on this site applies to {loc} exactly as it applies in Gurugram — "
    "there is no distance surcharge and no separate out-of-city price list. Pickup "
    "and delivery are free. What is different is scheduling, not money: we agree a "
    "day rather than promising one.",

    "## Before you book\n\n"
    "Two things worth knowing. First, we will not quote you a turnaround time over "
    "the phone for a load we have not seen — heavy lined curtains and a rug take "
    "longer than a bag of shirts, and we would rather be right than fast on the "
    "phone. Second, anything already stained, shrunk or damaged is noted on the "
    "receipt at pickup, in front of you.",

    "## Honest limits\n\n"
    "We are not local to {city} and we do not claim to be. That means no "
    "round-the-corner counter, no walk-in drop-off in {loc}, and no same-hour "
    "collection. What it does mean is a proper plant doing the cleaning, free "
    "collection and return, and a written count you can check.",
]

# Extra variants, kept separate so the banks above stay readable. They widen the
# combination space: with four openings per locality kind, six process sections,
# seven closing options (six plus none) and two section orders, two pages only
# land on the same skeleton by coincidence, not by construction.
WHAT_WE_TAKE["highrise"] += [
    "## Room by room, not just the wardrobe\n\n"
    "Households in {loc} tend to call us about a room rather than a basket. The "
    "drawing room, because the drapes and the sofa covers have gone dull. A bedroom, "
    "because the mattress and the quilts want doing. The whole floor, because there "
    "are rugs nobody has ever cleaned properly. All of it is collected on the same "
    "visit as the week's clothes, counted separately and priced by the piece.",

    "## Two piles, one collection\n\n"
    "There is the pile that repeats — shirts, trousers, uniforms, bed linen — and "
    "the pile that appears twice a year, which in a flat in {loc} usually means "
    "curtains, upholstery covers and woollens going into or coming out of storage. "
    "We take both together, and dry-clean-only pieces are pulled out and flagged at "
    "the door rather than discovered in the wash.",
]
WHAT_WE_TAKE["plotted"] += [
    "## The slow-burn items\n\n"
    "Everyone remembers the clothes. What builds up unnoticed in a house in {loc} is "
    "everything else: the drapes in the front room, the rug under the dining table, "
    "the cushion covers, the spare quilts on top of the cupboard. Those are priced "
    "per piece, counted at the door with the rest, and they are usually the reason "
    "the first booking happens at all.",

    "## A whole-household list\n\n"
    "From {loc} we are typically asked for a mix: the weekly wash and ironing, dry "
    "cleaning for sarees, suits and formal wear, and one or two bulky things — a "
    "carpet, a set of curtains, a mattress — that have no sensible home solution. "
    "Leather and shoes are handled as their own processes rather than added to a "
    "general load.",
]
WHAT_WE_TAKE["mixed"] += [
    "## One van, the whole list\n\n"
    "There is no need to sort anything before we arrive. A collection from {loc} can "
    "hold the week's clothes, a suit for dry cleaning, a quilt, a pair of shoes and a "
    "set of curtains at once; we separate them at the door, count each group and put "
    "them on their own lines. Fabrics are sorted at the plant, not in your hallway.",
]
WHAT_WE_TAKE["student"] += [
    "## High volume, low fuss\n\n"
    "The laundry that comes out of rented rooms and shared flats in {loc} is mostly "
    "repetitive: everyday clothes, bedsheets, towels, the occasional jacket. Wash and "
    "fold plus steam ironing handles nearly all of it, and where a whole PG or hostel "
    "wants doing we quote for the building rather than room by room.",
]
WHAT_WE_TAKE["market"] += [
    "## Shopfronts and living rooms\n\n"
    "Around {loc} the two loads sit side by side. Households send the weekly wash, "
    "the ironing pile and the seasonal quilts; shops and small offices send uniforms, "
    "linen, covers and curtains. Both are collected on the same run, counted "
    "separately at the door and billed on their own lines.",
]
CLOSING += [
    "## What we will not tell you\n\n"
    "We will not put a delivery time on this page. A bag of shirts and a lined "
    "curtain set are not the same job, and a rug that has not finished drying is a "
    "rug that will smell. When we see what you have at your door in {loc}, you get a "
    "real timeline from the person holding it.",

    "## Free means free\n\n"
    "There is no collection charge from {loc}, no return charge and no minimum order "
    "dressed up as a convenience fee. You pay the per-piece rates published on this "
    "site. Everything else — the van, the distance from Gurugram, the second trip to "
    "bring it back — is ours to worry about.",

    "## If something goes wrong\n\n"
    "Anything already stained, shrunk, faded or coming apart is written on the "
    "receipt at pickup in {loc}, before it leaves, and pointed out to you. If a stain "
    "will not lift, we say so rather than returning the piece and hoping you do not "
    "look. The refund and delivery policy on this site applies here exactly as it "
    "does in Gurugram.",
]

# FAQ pool. Each is (question, answer) with {loc}/{city}/{phone} slots.
FAQ_POOL = [
    ("Do you have a shop in {loc}?",
     "No. Wash4You has two shops, both in Gurugram, and the cleaning is done at our "
     "Gurugram plant. {loc} is covered in the sense that we take doorstep bookings "
     "from it — there is nowhere in {city} to walk in and drop something off."),
    ("Is there a Wash4You branch anywhere in {city}?",
     "There is not. Both counters are in Gurugram — Sushant Lok Phase I and Sector "
     "49. We collect from {loc} by arrangement and bring the order back to the same "
     "door; nothing is processed locally."),
    ("Is pickup and delivery really free from {loc}?",
     "Yes. Doorstep collection and return are free, with no distance charge added "
     "for {city}. The prices you pay are the per-piece rates on the price list."),
    ("How soon can you collect from {loc}?",
     "That depends on when we are next scheduled to run into {city}, so we will give "
     "you a real day when you call rather than a figure on a web page. Once the day "
     "is agreed we hold it."),
    ("How do I book?",
     "Call or WhatsApp **{phone}**, say where in {city} you are and roughly what you "
     "have, and we will fix a collection day. You can also use the booking link at "
     "the top of this page."),
    ("How is my laundry counted?",
     "Piece by piece at your door, in front of you, and written onto a receipt "
     "before it leaves. The same receipt comes back with the order so you can check "
     "it off yourself."),
    ("Do you take curtains, carpets and sofa covers from {loc}?",
     "Yes — those are among the most common reasons people outside Gurugram call "
     "us, because they are the things a home machine cannot handle. Tell us how many "
     "panels or how large the rug is when you book so we send the right vehicle."),
    ("What about quilts and blankets?",
     "Blanket and quilt cleaning is a standard service and it is priced per piece. "
     "The sensible time to send them from {loc} is at the end of winter, before they "
     "go into storage for the year."),
    ("Can you handle leather and shoes?",
     "Yes, as separate specialist processes — leather cleaning and shoe cleaning are "
     "never run through a normal dry-clean or wash load. Say what you are sending "
     "when you book so it is logged correctly at pickup."),
    ("What detergents and solvents do you use?",
     "Biodegradable, non-toxic ones, chosen to be safe on sensitive skin and on "
     "babies' clothes. That is the standard everywhere we work, {loc} included."),
    ("Can you do a bulk arrangement for a PG, hostel or office in {loc}?",
     "Bulk plans exist for PGs, hostels, co-living operators and corporate sites. "
     "Volumes and collection frequency decide the quote, so call **{phone}** and "
     "describe the site rather than expecting a number off a page."),
    ("What if something is already stained or damaged?",
     "We note it on the receipt at pickup, in front of you, before anything is "
     "taken. Some stains do not come out and we will tell you that at the door "
     "rather than after the fact."),
    ("Do you charge more because {loc} is outside Gurugram?",
     "No. The rate card is the same one published on this site, and collection and "
     "delivery are free. The difference is scheduling, not price."),
    ("Can I drop clothes off myself instead?",
     "Only at the Gurugram counters — Sushant Lok Phase I, Sector 43, or Unitech "
     "Arcadia in Sector 49. There is no drop-off point in {city}, which is exactly "
     "why the doorstep collection is free."),
    ("Which services can I combine in one pickup from {loc}?",
     "All fifteen. Wash and fold, dry cleaning, steam ironing, curtains, carpets, "
     "sofas, mattresses, blankets, shoes, bags, leather and accessories can travel "
     "on the same collection and are billed line by line."),
]

# The first FAQ on every page is always a disclosure question, so nobody has to
# read to the bottom to find out there is no local branch.
DISCLOSURE_FAQ_IDS = [0, 1]


def slugify(text: str) -> str:
    text = text.lower().replace("&", "and")
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def pick(options: list, key: str, salt: str):
    """Deterministic choice, so re-running the generator is idempotent."""
    h = int(hashlib.sha256(f"{salt}:{key}".encode()).hexdigest(), 16)
    return options[h % len(options)]


def locality_kind(city_slug: str, zone: str, name: str) -> str:
    z = zone.lower()
    n = name.lower()
    if city_slug == "noida":
        if "greater noida" in z:
            return "student" if name in ("Knowledge Park", "Alpha 1", "Alpha 2") else "mixed"
        if "key localities" in z:
            return "market"
        num = int(n.replace("sector ", "")) if n.startswith("sector ") else 0
        if num >= 100:
            return "highrise"
        if num in (15, 16, 17, 18, 19, 20, 27, 28, 29, 30, 31, 32, 33, 39, 40, 41, 44, 46, 47, 50, 51, 52, 55, 56):
            return "plotted"
        if num in (62, 63, 64, 65, 58, 59, 60, 57):
            return "market"
        return "mixed"
    if city_slug == "faridabad":
        if "greater faridabad" in z:
            return "highrise"
        if "landmarks" in z:
            return "market"
        if "ballabgarh" in z:
            return "mixed"
        if "old faridabad" in z:
            return "plotted"
        return "plotted"
    if city_slug == "ghaziabad":
        if "indirapuram" in z or name in ("Crossing Republik", "Raj Nagar Extension"):
            return "highrise"
        if "vaishali" in z:
            return "mixed"
        if name in ("Navyug Market", "Mohan Nagar", "Sahibabad", "Hapur Road", "NH-24", "NH-58", "Kaushambi"):
            return "market"
        return "plotted"
    # Delhi
    if name in ("Dwarka", "Vasant Kunj", "Rohini"):
        return "highrise"
    if name in ("Kamla Nagar", "Karol Bagh", "Lajpat Nagar", "Atta Market", "Krishna Nagar", "Uttam Nagar"):
        return "market"
    if name in ("Hauz Khas", "Saket", "Malviya Nagar", "Mayur Vihar", "Laxmi Nagar"):
        return "student"
    return "plotted"


def build_entry(city_slug: str, zone: str, name: str, coverage_name: str) -> dict:
    meta = CITY_META[city_slug]
    city = meta["label"]
    slug = f"laundry-service-{slugify(name)}-{city_slug}"
    kind = locality_kind(city_slug, zone, name)
    fmt = dict(loc=name, city=city, phone=PHONE, zone=zone)

    disclosure = pick(DISCLOSURE[city_slug], slug, "disc").format(**fmt)
    lede = pick(LEDE[city_slug], slug, "lede").format(**fmt)

    what = pick(WHAT_WE_TAKE[kind], slug, "what").format(**fmt)
    how = pick(HOW_IT_WORKS, slug, "how").format(**fmt)
    # Some pages lead with the process and some with the load, so the set does
    # not read as one document repeated.
    sections = [what, how] if int(hashlib.sha256((slug + "order").encode()).hexdigest(), 16) % 2 else [how, what]
    # Roughly two thirds carry a closing section, for length variation.
    if int(hashlib.sha256(slug.encode()).hexdigest(), 16) % 3:
        sections.append(pick(CLOSING, slug, "close").format(**fmt))
    body = "\n\n".join(sections)

    # FAQs: one disclosure question plus four rotated from the pool.
    d_id = pick(DISCLOSURE_FAQ_IDS, slug, "dfaq")
    pool_ids = [i for i in range(len(FAQ_POOL)) if i not in DISCLOSURE_FAQ_IDS]
    start = int(hashlib.sha256((slug + "faq").encode()).hexdigest(), 16) % len(pool_ids)
    chosen = [d_id] + [pool_ids[(start + step * 3) % len(pool_ids)] for step in range(4)]
    seen, faq_ids = set(), []
    for i in chosen:
        if i not in seen:
            seen.add(i)
            faq_ids.append(i)
    for i in pool_ids:  # top up if the rotation collided
        if len(faq_ids) >= 5:
            break
        if i not in seen:
            seen.add(i)
            faq_ids.append(i)
    faqs = [{"q": FAQ_POOL[i][0].format(**fmt), "a": FAQ_POOL[i][1].format(**fmt)} for i in faq_ids]

    title_forms = [
        f"Laundry & Dry Cleaning in {name}, {city} | Wash4You",
        f"{name}, {city} — Laundry Pickup & Dry Cleaning | Wash4You",
        f"Laundry Service in {name}, {city} | Wash4You",
        f"Dry Cleaning & Laundry Pickup in {name}, {city} | Wash4You",
    ]
    desc_forms = [
        f"Free doorstep laundry and dry cleaning pickup in {name}, {city}. "
        f"Cleaned at our Gurugram plant — no {city} branch. Call {PHONE}.",
        f"Wash4You collects laundry, dry cleaning, curtains and quilts from {name}, "
        f"{city} on an agreed day. Free pickup and delivery. Call {PHONE}.",
        f"{name}, {city} is in our coverage area: free doorstep collection, itemised "
        f"count, eco-friendly cleaning done in Gurugram. Call {PHONE}.",
        f"Book a free laundry and dry cleaning pickup in {name}, {city}. Gurugram-based, "
        f"no local branch, everything counted at your door. Call {PHONE}.",
    ]
    h1_forms = [
        f"Laundry & Dry Cleaning in {name}, {city}",
        f"Laundry Pickup in {name}, {city}",
        f"Dry Cleaning & Laundry Collection in {name}, {city}",
        f"Wash4You in {name}, {city} — Service Area",
    ]

    return {
        "name": name,
        "coverage_name": coverage_name,
        "slug": slug,
        "city": city,
        "city_slug": city_slug,
        "state": meta["state"],
        "zone": zone,
        "kind": kind,
        "hub_slug": meta["hub_slug"],
        "page_type": "coverage",
        "coverage_note": disclosure,
        "meta_title": pick(title_forms, slug, "title"),
        "meta_description": pick(desc_forms, slug, "desc"),
        "h1": pick(h1_forms, slug, "h1"),
        "lede": lede,
        "body": body,
        "faqs": faqs,
        "keywords": [
            f"laundry service {name} {city}",
            f"dry cleaning {name}",
            f"laundry pickup and delivery {name} {city}",
            f"{name} {city} laundry near me",
            f"curtain and sofa cleaning {name}",
        ],
    }


def main() -> int:
    areas = json.loads((DATA / "areas.json").read_text(encoding="utf-8"))

    entries: list[dict] = []
    hubs: list[dict] = []
    by_slug: dict[str, dict] = {}

    for city in areas["cities"]:
        cs = city["slug"]
        if cs == "gurugram":
            continue
        meta = CITY_META[cs]
        city_entries: list[dict] = []
        zones: list[dict] = []
        for column in city["columns"]:
            items = list(column["items"])
            # Indirapuram and Vaishali appear in areas.json only as a Noida
            # "key locality" and as a Ghaziabad zone heading. They are really
            # Ghaziabad localities, so the page is built once here, at the top
            # of its own zone, and Noida's list links to it.
            if cs == "ghaziabad" and column["title"] in ("Indirapuram", "Vaishali"):
                items.insert(0, {"name": column["title"]})
            zone_items: list[dict] = []
            for item in items:
                name = item["name"]
                # "Sector 1" under the Vaishali heading means Vaishali Sector 1,
                # not Ghaziabad Sector 1 — spell it out so the page title, the
                # H1 and the slug all say which place this is.
                if cs == "ghaziabad" and column["title"] == "Vaishali" and name.startswith("Sector "):
                    name = f"Vaishali {name}"
                canonical = CANONICAL_CITY.get(name)
                if canonical and canonical != cs:
                    # Built once, under the city it actually sits in. This
                    # city's list links to that page instead of duplicating it.
                    zone_items.append({
                        "name": name,
                        "slug": f"laundry-service-{slugify(name)}-{canonical}",
                        "external": True,
                    })
                    continue
                if any(e["name"] == name for e in city_entries):
                    continue
                entry = build_entry(cs, column["title"], name, item["name"])
                if entry["slug"] in by_slug:
                    raise SystemExit(f"duplicate slug {entry['slug']}")
                by_slug[entry["slug"]] = entry
                entries.append(entry)
                city_entries.append(entry)
                zone_items.append({"name": name, "slug": entry["slug"]})
            zones.append({"title": column["title"], "items": zone_items})

        hubs.append({
            "name": city["name"],
            "city_slug": cs,
            "slug": meta["hub_slug"],
            "state": meta["state"],
            "page_type": "coverage-hub",
            "count": len(city_entries),
            "zones": zones,
            "meta_title": f"Laundry & Dry Cleaning Service Areas in {city['name']} | Wash4You",
            "meta_description": (
                f"Every {meta['short']} locality Wash4You collects laundry and dry cleaning "
                f"from — {len(city_entries)} areas. Gurugram-based, no {meta['short']} branch. "
                f"Call {PHONE}."
            ),
            "h1": f"Wash4You service areas in {city['name']}",
            "lede": (
                f"These are the {len(city_entries)} {meta['short']} localities on our coverage "
                f"list. Pickup and delivery are free and every piece is counted at your door."
            ),
            "coverage_note": (
                f"Wash4You is a Gurugram business with two shops, both in Gurugram, and no "
                f"premises anywhere in {city['name']}. Everything we collect here is cleaned at "
                f"the Gurugram plant and returned to the same address. Collections in "
                f"{city['name']} run on a day agreed with you rather than an on-demand slot — "
                f"call {PHONE} and we will tell you the next day we can reach you."
            ),
            "intro": city.get("note", ""),
        })

    # Sibling links: five other localities in the same zone, so no coverage page
    # is a dead end and the internal link graph is not a hub-and-spoke star.
    by_zone: dict[tuple, list[dict]] = {}
    for e in entries:
        by_zone.setdefault((e["city_slug"], e["zone"]), []).append(e)
    for (cs, zone), group in by_zone.items():
        for i, e in enumerate(group):
            ring = [group[(i + step) % len(group)] for step in range(1, 6)]
            e["nearby"] = [o["slug"] for o in ring if o["slug"] != e["slug"]][:5]

    out = {
        "_source": (
            "Generated by tools/gen-coverage-pages.py from the non-Gurugram cities in "
            "areas.json. One entry per locality Wash4You lists as covered outside "
            "Gurugram, plus one hub page per city. Re-run the generator to rebuild."
        ),
        "_honesty_note": (
            "Wash4You has NO shop, counter or plant in Delhi, Noida, Greater Noida, "
            "Faridabad or Ghaziabad — both stores are in Gurugram. These pages are "
            "service-area pages, not branch pages: every one carries a coverage_note "
            "saying so in plain words, none names a 'nearest store' in that city, none "
            "promises a turnaround time, and their schema is a Service with an "
            "areaServed Place rather than a LocalBusiness with a local address."
        ),
        "_fields": (
            "name, slug, city, city_slug, state, zone, kind, hub_slug, page_type, "
            "coverage_note, meta_title, meta_description, h1, lede, body, faqs, "
            "keywords, nearby. Hubs additionally carry zones[] and count."
        ),
        "hubs": hubs,
        "areas": entries,
    }
    path = DATA / "coverage-pages.json"
    # `indexable` is hand-maintained (SEO: thin pages stay noindex until
    # rewritten), so carry it over from the existing file on every re-run.
    if path.exists():
        prev = {a["slug"]: a["indexable"] for a in json.loads(path.read_text(encoding="utf-8")).get("areas", []) if "indexable" in a}
        for e in entries:
            if e["slug"] in prev:
                e["indexable"] = prev[e["slug"]]
    path.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(entries)} coverage pages + {len(hubs)} city hubs to {path}")
    for h in hubs:
        print(f"  {h['name']}: {h['count']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
