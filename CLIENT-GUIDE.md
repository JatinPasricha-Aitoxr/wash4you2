# Wash4You Website — Owner's Guide

This is a plain-English walkthrough of your admin panel. No jargon — if
you can use WhatsApp and email, you can use this.

> **Note on screenshots:** this guide describes exactly what you'll see
> and click, but doesn't yet include actual screenshots — add them the
> first time you walk through each flow for real, so this stays accurate
> as the admin evolves.

## Logging in

1. Go to `https://admin.wash4you.in` (or `http://127.0.0.1:8811/admin`
   if you're testing locally).
2. Enter your email and password.
3. The first time you ever log in, you'll be asked to set your own
   password — the one you were given is temporary.
4. Forgot your password? Click "Forgot password?" on the login screen.

## Editing text on a page

1. Click **Pages** in the left menu.
2. Click **Edit** next to the page you want to change (e.g. "Home").
3. You'll see a preview of the page on the left, and a list of its
   sections on the right.
4. Click the little gear (⚙) icon next to the section you want to change.
5. Change the text in the boxes, then click **Save section**.
6. Your change is now a **draft** — it's not live yet. Look at the top of
   the screen: it'll say "N unpublished changes".
7. When you're happy, click **Publish** and confirm — it goes live within
   a minute or two.

## Changing a photo

1. Click **Media** in the left menu.
2. Click **Choose file**, pick your photo, and click **Upload**. It's
   automatically resized and optimised for you.
3. Go back to the page/section you want to update, open its settings
   (⚙), and paste the file path shown for your uploaded photo into the
   image field.
4. Save, then Publish as above.

## Adding a new section to a page

1. Open the page in **Pages → Edit**.
2. Scroll to the bottom of the section list on the right.
3. Choose a section type from the dropdown (e.g. "Testimonials", "FAQ
   Accordion") and click **+ Add section**.
4. Fill in the fields and **Save section**.
5. Use the ↑ / ↓ buttons on any section to move it up or down the page.
6. The 👁 button hides a section without deleting it (handy if you're not
   sure yet); 🗑 deletes it (you can restore it — see "Undoing a mistake"
   below).

## Adding a product/service

1. Click **Products** in the left menu.
2. Click **+ New product**.
3. Fill in the name, description, price and images.
4. Save — it appears on the site's Services page automatically.

## Writing a blog post

Everything for the blog is under **Blog posts** in the left menu.

**Write a new post**

1. Click **Blog posts**, then **New post**.
2. Fill in the **Title**. The web address is created for you (you can change
   it before you save the first time; after that it is locked so old links
   never break). A green tick means the address is free.
3. Pick a **Publish date** and a **Topic** (choose one that exists, or type a
   new one). Write a short **Summary** (this is the text on the blog page).
   The **Search description** is optional.
4. Choose a **Cover image** from your media library, or upload a new one.
5. Write the **Article**. The buttons above the box add headings, bold,
   links, lists, quotes and pictures. A blank line starts a new paragraph.
   The **Preview** on the right shows how it will read as you type.
6. Click **Save draft** whenever you like. A draft is private: it is not on
   the website. (The editor also saves for you every 30 seconds.)
7. When you're happy, click **Publish post**. The website rebuilds and the
   post appears in a few minutes, on the blog page and at its own address.

**Change a post that is already live:** open it from the list, edit it and
click **Publish changes**. Until you do, visitors still see the old version.
Changed your mind? **Discard changes** returns to the live version.

**Hide a post without deleting it:** set **Visibility** to *Hidden* and
publish. Set it back to *Visible* and publish to bring it back.

**Delete a post:** click **Delete** in the list, then **Publish deletion**
(or **Undo delete** to keep it).

Good to know:
- Links to other pages of the site start with `/` (for example `/pricing/`);
  links to other websites start with `https://`.
- Images in an article come from the media library. New uploads are
  published automatically together with the post that uses them.
- The post's own address can't be a name the website already uses (such as
  `pricing` or an area page) — the form tells you straight away.

## Handling an order

1. Click **Orders** in the left menu — this is where every booking or
   enquiry from the site shows up.
2. Click into an order to see the customer's details and what they asked
   for.
3. As you work the order, update its status at the top (New → Confirmed →
   In Progress → Ready → Out for Delivery → Completed). Everyone on your
   team sees the same up-to-date status.
4. When you mark an order **Completed**, the system automatically creates
   or updates that customer's profile under **Customers** — their order
   count, total spend, and tags like "repeat customer" update themselves.
   You don't have to do anything extra.

## Publishing

- The bar at the top of every page you're editing shows how many changes
  are waiting to go live.
- Click **Publish** to review exactly what's about to change, then
  confirm. You can also publish only some of your changes and leave the
  rest as drafts for later — just untick the ones you're not ready for.
- Made a mistake after publishing? Go to the page, open **Revision
  history**, and restore an earlier version.

## Undoing a mistake

- Deleted a section by accident? Open the page, click **Revision
  history**, and restore the version from just before you deleted it.
- Everything you or your team does is logged — ask a developer to check
  the audit log if you ever need to know exactly who changed what and
  when.

## Getting help

If something doesn't look right, don't panic — nothing you do here can
break the live site until you click Publish, and even then you can always
roll back to an earlier version.
