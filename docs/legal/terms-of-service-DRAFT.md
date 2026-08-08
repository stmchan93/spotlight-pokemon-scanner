# Ekalight — Terms of Service / End User Licence Agreement

> ## ⚠️ DRAFT — NOT LEGAL ADVICE, REQUIRES REVIEW BY A QUALIFIED LAWYER
>
> This document was drafted by reading the Ekalight codebase and describing what the
> software actually does. It is a **well-researched starting point**, not a document to
> publish as-is. It has not been reviewed by a lawyer, is not tailored to any
> jurisdiction, and makes no warranty of legal sufficiency. Every `[PLACEHOLDER: …]`
> must be filled and the whole document reviewed by counsel before publication.
>
> See `docs/legal/README.md` for the full pre-publication checklist.

**Effective date:** [PLACEHOLDER: effective date, e.g. 22 August 2026]
**Last updated:** [PLACEHOLDER: last-updated date]

---

## 1. Agreement to these terms

These Terms of Service ("**Terms**") are a binding agreement between you and
[PLACEHOLDER: full legal entity name, e.g. "Ekalight, Inc."], a
[PLACEHOLDER: entity type and jurisdiction of incorporation, e.g. "Delaware corporation"]
("**Ekalight**", "**we**", "**us**", "**our**"), governing your use of the Ekalight mobile
application (bundle identifier `com.ekalight.app`), our backend services and APIs, and any
related websites (together, the "**Service**").

By creating an account, tapping through the sign-in screen, or otherwise using the Service —
**including using it as a guest without creating an account** — you agree to these Terms and
to our Privacy Policy at [PLACEHOLDER: hosted privacy policy URL]. If you do not agree, do
not use the Service.

## 2. Who may use the Service

You must be at least [PLACEHOLDER: minimum age — see README; commonly 13, or 16 in some
jurisdictions] years old to use the Service. The Service is **not directed to children**, and
we do not knowingly permit users under the minimum age to create an account or post content.

The Service currently includes **guest access**: you may begin scanning cards without
registering, using an anonymous session. Guest sessions are still governed by these Terms.
Guest users cannot post, comment, message, or hold a public profile until they convert their
session to a registered account.

You may not use the Service if you have previously been banned by us, or if applicable law
prohibits you from doing so.

## 3. Your account

You may register with an email address and password, with an email verification code, or by
using Sign in with Apple or Sign in with Google. You are responsible for keeping your
credentials secure and for all activity under your account. Notify us at **team@ekalight.com**
if you believe your account has been compromised.

You choose a display name, and optionally a handle, bio, location, avatar, cover image, and a
link to another profile. **These are public** — see Section 6 and the Privacy Policy.

You may delete your account at any time from inside the app. See Section 15.

---

## 4. User content and the licence you grant us

"**User Content**" means anything you submit through the Service: posts, images attached to
posts, comments, direct messages, your profile fields (display name, handle, bio, location,
avatar, cover image, link), reports you file, and the photographs you capture with the card
scanner.

**You own your User Content.** We do not claim ownership of it.

To operate the Service, you grant us a worldwide, non-exclusive, royalty-free,
sublicensable, transferable licence to host, store, reproduce, modify (for example to resize
and re-encode images, or to generate the normalised crop used to identify a card), publish,
publicly display, and distribute your User Content — **but only for the purposes of operating,
securing, improving, and providing the Service**, and only in a manner consistent with the
visibility settings and the Privacy Policy.

This licence continues for as long as we retain the content, including during the retention
periods described in Section 15 and in the Privacy Policy. It does not permit us to sell your
User Content or to make private content public.

### 4.1 Card scan images and machine learning

When you scan a card, the app sends the captured photograph to our servers to identify the
card. **These scan images are retained and are used to train and improve our card-recognition
models.** They are stored in a private bucket and are not made public. If you do not want your
scan images used this way, do not use the scanner. See the Privacy Policy for detail.

### 4.2 Feedback

If you send us suggestions or feedback, you grant us an unrestricted, perpetual right to use
them without obligation or compensation to you.

---

## 5. Acceptable use — objectionable content is prohibited

You agree **not** to post, upload, transmit, or otherwise make available through the Service —
including in posts, comments, images, profile fields, and direct messages — any content that:

- is sexually explicit, pornographic, or sexually suggestive;
- depicts, promotes, or facilitates the sexual exploitation or abuse of minors **(see Section 8)**;
- is hateful, or attacks, degrades, or promotes violence or hatred against people on the basis
  of race, ethnicity, national origin, religion, disability, disease, age, sex, gender identity,
  gender expression, sexual orientation, or veteran status;
- harasses, bullies, threatens, stalks, intimidates, or incites others to do so;
- is violent, gratuitously graphic, or glorifies self-harm, suicide, or eating disorders;
- promotes or facilitates illegal activity, illegal goods, weapons, or controlled substances;
- is defamatory, libellous, or knowingly false;
- infringes anyone's intellectual property, privacy, or publicity rights;
- discloses another person's private or identifying information without their consent
  ("doxxing");
- impersonates any person or entity, or misrepresents your affiliation with one;
- is spam, a scam, a pyramid or Ponzi scheme, phishing, a fraudulent sale offer, or otherwise
  deceptive commercial content;
- contains malware, or is designed to disrupt, damage, or gain unauthorised access to any
  system.

You also agree not to:

- scrape, crawl, or harvest data from the Service, or access it by automated means, except as
  we expressly permit;
- reverse-engineer, decompile, or attempt to extract our models, embeddings, or source code,
  except where such restriction is prohibited by law;
- circumvent rate limits, moderation, blocking, access gates, or any security measure;
- resell, sublicense, or commercially exploit the Service or our card data without our written
  permission;
- use the Service to build a competing product, dataset, or model;
- create multiple accounts to evade a suspension or ban.

**There is no tolerance for objectionable content or for abusive users.**

---

## 6. Public and private surfaces — what others can see

You should understand what is public before you post:

- **Posts, post images, and comments are public.** They are visible to every signed-in user of
  the Service, including guest sessions. They are not followers-only, and the app does not
  currently offer per-post privacy settings.
- **Likes and follows are public.** Who follows whom, and who liked what, is readable by other
  signed-in users.
- **Your profile is public.** Display name, handle, bio, location, link, avatar, and cover
  image are visible to other users. **Your avatar and cover images are stored in a
  publicly-readable location and can be retrieved by anyone who has the image URL, including
  people who are not signed in.**
- **Your email address is never shown to other users.**
- **Direct messages are private to the participants** — but they are **not end-to-end
  encrypted**. We can technically access them, and we may do so to investigate reports, comply
  with law, or protect users. Do not send anything through direct messages that you would not
  want disclosed under those circumstances.
- **Your collection, holdings, cost basis, sales, and scan history are private to you.**

---

## 7. Moderation — automated and human

**Your content is scanned.** By using the Service you acknowledge and agree that content you
submit is subject to automated and human review:

1. **Automated wordlist prefilter.** Every post, comment, and direct message is checked
   against a blocked-terms list at the moment you submit it. Matching content may be removed
   immediately or held for review. This step also enforces per-user rate limits.
2. **Automated AI review.** Posts, comments, and images attached to posts are additionally
   sent to a third-party AI moderation service (OpenAI's moderation model) for classification
   across categories including sexual content, violence, harassment, hate, and self-harm.
   **Images you attach to a post are hidden from other users until this review approves
   them.** Direct messages are not sent to the AI reviewer; they are covered by step 1,
   blocking, and reporting.
3. **Community reporting.** Any user can report a post, comment, message, or profile. Content
   that is reported by enough distinct users is automatically hidden pending review.
4. **Human review.** Our moderators can review reported and flagged content and take action.

### 7.1 Consequences

If you violate these Terms, we may — with or without notice, and at our discretion:

- remove or hide the offending content;
- restrict the reach of your content ("shadowban");
- **suspend your account**;
- **permanently ban your account and terminate your access**;
- withhold, restrict, or revoke access to features; and
- report you to law enforcement where we believe the law requires or permits it.

We aim to act proportionately and to act on reports promptly, but we do not guarantee any
particular response time, and we are not obliged to remove content that does not violate these
Terms.

### 7.2 Reporting and blocking

- **Report:** use the report control on any post, comment, message, or profile, or email
  **team@ekalight.com**. Tell us what you saw and where.
- **Block:** you can block another user. A blocked user cannot message you, and blocked users
  are hidden from each other's content.
- **Mute:** you can mute another user to remove them from your feed without blocking them.

We keep a record of reports and moderator actions so that we can enforce these Terms
consistently. A record of a report may be retained even after the reported content or account
is deleted.

### 7.3 Appeals

If you believe we removed your content or restricted your account in error, email
**team@ekalight.com** and we will review it. [PLACEHOLDER: state an appeal response-time
commitment if you wish to make one, and check whether the EU Digital Services Act or any other
regime imposes specific appeal, statement-of-reasons, or notice obligations on you.]

---

## 8. Child sexual abuse material — zero tolerance

We prohibit any content that sexually exploits or endangers minors. Accounts that upload such
material will be terminated immediately and permanently.

[PLACEHOLDER: **Legal review required.** Providers in the United States have mandatory
reporting duties to NCMEC under 18 U.S.C. § 2258A once they obtain actual knowledge of
apparent child sexual abuse material, and there are related obligations in other
jurisdictions. Confirm with counsel what applies to your entity, and confirm the internal
process before launch. The codebase notes that the current AI classifier is **not** a
substitute for hash-matching detection (e.g. PhotoDNA), and that this is not yet
implemented.]

---

## 9. Card prices are informational — not financial advice

The Service displays card prices, price history, portfolio values, profit and loss figures,
and links to third-party marketplaces. **All of it is provided for general information only.**

- Prices come from third-party data providers and from public marketplace listings and sold
  data. They are **estimates**, may be **stale**, may be **wrong**, and may not reflect what
  any card would actually sell for.
- Portfolio values, cost basis, and profit figures are calculations based on data you enter
  and on those third-party prices. We do not verify them.
- **Nothing in the Service is financial, investment, tax, appraisal, or trading advice**, and
  nothing in it is an offer to buy or sell anything.
- **You are solely responsible for any buying, selling, trading, grading, insurance, or
  valuation decision you make.** Do your own research and seek professional advice where
  appropriate.
- We are not a party to any transaction you enter into with anyone else, whether or not you
  found them through the Service.

We do not guarantee that a card scan will identify a card correctly. Scanning is a
probabilistic machine-learning process and **will sometimes be wrong**, including about the
card's identity, set, variant, or grade. Verify before you rely on it.

## 10. Third-party services and links

The Service integrates and links to third parties, including card catalogue and pricing
providers and marketplaces such as eBay and TCGplayer. When you tap a marketplace link you
leave the Service, and that third party's own terms and privacy policy apply to you. We do not
control and are not responsible for third-party content, listings, sellers, pricing, or
conduct.

## 11. Our intellectual property

The Service — including the app, the backend, our recognition models, our design, our
compilations of card data, and the Ekalight name and marks — is owned by us or our licensors
and is protected by intellectual property laws. Subject to these Terms, we grant you a
limited, personal, non-exclusive, non-transferable, revocable licence to use the Service for
your own non-commercial use. All rights not expressly granted are reserved.

Pokémon, trading card names, card images, set names, and related marks are the property of
their respective owners. **Ekalight is not affiliated with, endorsed by, or sponsored by The
Pokémon Company, Nintendo, Wizards of the Coast, PSA, CGC, BGS, eBay, TCGplayer, or any card
publisher or grading company.** Card images and catalogue data are used to identify and
describe collectible cards.

[PLACEHOLDER: confirm with counsel that your use of third-party card imagery and catalogue
data is permitted by your licence agreements with your data providers, and that the
disclaimer above matches those agreements.]

## 12. Copyright complaints

If you believe content on the Service infringes your copyright, send a notice to
**team@ekalight.com** including: identification of the work, identification of the infringing
material and where it is, your contact details, a statement of good-faith belief, a statement
that the notice is accurate, and your signature.

[PLACEHOLDER: if you are relying on the US DMCA safe harbour you must designate an agent with
the US Copyright Office and publish the agent's details. Confirm with counsel and add the
designated agent's name and address here.]

## 13. Purchases and subscriptions

[PLACEHOLDER: **Confirm before launch.** The app contains paywall UI and a purchases
integration, but at the time of this draft **no live subscription is configured for
production** — no store product is charged, and premium features unlock locally without
payment. If you launch with a paid subscription, this section must be written to cover: price
and billing period, auto-renewal, how to cancel through the App Store or Google Play, refund
policy (noting that Apple and Google handle refunds under their own terms), free-trial terms,
and price-change notice. Apple's Guideline 3.1.2 requires specific auto-renewable subscription
disclosures in the binding EULA. Delete this section entirely if you launch without
purchases.]

## 14. Availability, changes, and beta features

We may change, suspend, or discontinue any part of the Service at any time. We may impose
limits on features or restrict access without notice or liability. Some features are
experimental and may be removed. We do not guarantee uninterrupted or error-free operation.

## 15. Termination and deletion

**You may terminate** at any time by deleting your account in the app
(Account → Delete Account) or by emailing **team@ekalight.com**.

**We may terminate or suspend** your account immediately, without notice, if you breach these
Terms, if we are required to by law, or if we reasonably believe your continued access poses a
risk to other users or to us.

**What happens on deletion** is described in detail in the Privacy Policy. In summary: your
account and your private data (collection, scan records, transactions) are deleted; but for
safety, legal, and integrity reasons **some material is retained**, including moderation
records, records of reports made about you, and content archives required to keep other users'
conversations intelligible. Deletion of your account does not automatically withdraw the
licence in Section 4 with respect to content that is lawfully retained.

Sections 4.2, 9, 11, 15, 16, 17, 18, and 19 survive termination.

## 16. Disclaimers

THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
NON-INFRINGEMENT, ACCURACY, AND QUIET ENJOYMENT.

WITHOUT LIMITING THE ABOVE, WE DO NOT WARRANT THAT: CARD IDENTIFICATIONS WILL BE CORRECT;
PRICES OR VALUATIONS WILL BE ACCURATE, CURRENT, OR COMPLETE; THE SERVICE WILL BE
UNINTERRUPTED, SECURE, OR ERROR-FREE; OR THAT MODERATION WILL DETECT ALL OBJECTIONABLE
CONTENT.

**We are not responsible for User Content.** You may be exposed to content you find offensive
or inaccurate, and you use the Service at your own risk.

Some jurisdictions do not allow the exclusion of implied warranties, so some of the above may
not apply to you.

## 17. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEITHER EKALIGHT NOR ITS OFFICERS, EMPLOYEES, OR
AGENTS WILL BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR
PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, DATA, GOODWILL, **OR ANY LOSS ARISING
FROM A BUYING, SELLING, TRADING, OR VALUATION DECISION**, ARISING OUT OF OR RELATING TO THE
SERVICE, WHETHER IN CONTRACT, TORT, OR OTHERWISE, EVEN IF ADVISED OF THE POSSIBILITY.

TO THE MAXIMUM EXTENT PERMITTED BY LAW, OUR TOTAL AGGREGATE LIABILITY ARISING OUT OF OR
RELATING TO THE SERVICE WILL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID US IN THE
TWELVE MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM, OR (B)
[PLACEHOLDER: cap amount, e.g. USD 100].

Some jurisdictions do not allow these limitations, so some of the above may not apply to you.
Nothing in these Terms excludes liability that cannot lawfully be excluded.

## 18. Indemnity

You agree to indemnify and hold harmless Ekalight and its officers, employees, and agents from
any claim, demand, loss, or expense (including reasonable legal fees) arising out of your User
Content, your use of the Service, or your breach of these Terms or of any law or third-party
right.

## 19. Governing law and disputes

These Terms are governed by the laws of [PLACEHOLDER: governing law, e.g. "the State of
Delaware, United States"], without regard to conflict-of-laws rules. You and we agree to the
exclusive jurisdiction of the courts located in [PLACEHOLDER: venue, e.g. "New Castle County,
Delaware"].

[PLACEHOLDER: **Decide with counsel** whether to include an arbitration clause and a class-
action waiver. If you do, most jurisdictions require it to be conspicuous, and many require an
opt-out mechanism. If you serve EU/UK consumers, mandatory local consumer-protection rights
and forum rules may override this section — counsel should confirm.]

## 20. Apple App Store — additional terms

These Terms are between you and Ekalight only, **not with Apple**. Apple is not responsible for
the Service or its content.

- Apple has no obligation to furnish maintenance or support for the Service.
- If the Service fails to conform to any applicable warranty, you may notify Apple, and Apple
  will refund the purchase price (if any). To the maximum extent permitted by law, Apple has no
  other warranty obligation.
- Apple is not responsible for addressing any claim by you or a third party relating to the
  Service, including product liability, failure to conform to legal requirements, and consumer
  protection or privacy claims.
- Apple is not responsible for the investigation, defence, settlement, or discharge of any
  third-party claim that the Service infringes intellectual property rights.
- You represent that you are not located in a country subject to a US Government embargo or
  designated as "terrorist supporting", and are not on any US Government prohibited-parties
  list.
- **Apple and its subsidiaries are third-party beneficiaries of these Terms and may enforce
  them against you.**

## 21. Google Play — additional terms

Where you obtained the app from Google Play, your use is also subject to the Google Play Terms
of Service. Google is not a party to these Terms and is not responsible for the Service.

## 22. General

These Terms, together with the Privacy Policy, are the entire agreement between you and us
about the Service. If any provision is held unenforceable, the rest remains in effect. Our
failure to enforce a provision is not a waiver. You may not assign these Terms; we may assign
them in connection with a merger, acquisition, or sale of assets.

**Changes.** We may update these Terms. If we make a material change we will give reasonable
notice — for example, in the app or by email — and update the "Last updated" date. Continuing
to use the Service after a change takes effect means you accept the revised Terms.

## 23. Contact

[PLACEHOLDER: full legal entity name]
[PLACEHOLDER: registered postal address — required for App Store, Google Play, and most
consumer-protection regimes]

Email: **team@ekalight.com**
