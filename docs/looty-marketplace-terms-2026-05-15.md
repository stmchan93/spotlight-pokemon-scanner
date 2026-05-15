# Looty Marketplace Terms of Service

_Draft for legal review — not yet operative. Effective Date: TBD._

> NOTE TO LAWYER: This is a working draft prepared by the product team for the V1 launch of the Looty marketplace. Numbers, regulatory positions, and Delaware entity status are flagged inline. Please replace the bracketed entity name, confirm the arbitration provider, and validate the money-transmitter and merchant-of-record positions before this is presented to users.

## 1. Acceptance of Terms

These Terms of Service ("Terms") form a binding agreement between you and Looty, LLC, a Delaware limited liability company ("Looty," "we," "us," or "our"), governing your use of the Looty mobile application, the Spotlight card scanner embedded in it, and any related websites, payment flows, and services (together, the "Service"). By creating an account, scanning a card, initiating a sale, paying for an order, or otherwise using the Service, you agree to these Terms and to our Privacy Policy. If you do not agree, do not use the Service.

> NOTE TO LAWYER: Confirm "Looty, LLC" entity name and Delaware formation before this is signed off. The product team has not yet incorporated as of the draft date.

## 2. Definitions

- **Platform**: the Looty mobile application and any related web payment pages operated by Looty.
- **Spotlight**: the card scanning, identification, and pricing feature embedded in the Platform.
- **Seller**: a user who has completed Stripe Express onboarding through the Platform and is using the Service to accept payment from a Buyer for a Card.
- **Buyer**: a person who pays a Seller through a Looty-generated Stripe Checkout link, whether or not the Buyer holds a Looty account.
- **Order**: a single Stripe Checkout session initiated by a Seller through the Platform and paid by a Buyer.
- **Card**: a physical trading card, raw or graded and encapsulated in a third-party grading holder ("slabbed"), offered for sale by a Seller through the Platform.
- **Show**: an in-person trading-card event (convention, store event, meetup, or similar) where the Buyer and Seller transact face to face.
- **Stripe Connected Account**: a Stripe Express account opened by a Seller and connected to the Platform through Stripe Connect.
- **Platform Fee**: the fee Looty charges on each Order, set out in Section 7.
- **Hold Period**: the period between Buyer payment and the earliest moment funds become available to the Seller for payout, set out in Section 8.

## 3. Eligibility

You must be at least 18 years old, have the legal capacity to enter contracts, and reside in the United States to use the Service. The Service is available only in the United States and only in U.S. dollars at this time. You must comply with all federal, state, and local laws that apply to your use of the Service, including laws governing the sale of trading cards, sales tax collection where applicable, and reporting of income. Sellers are responsible for determining and complying with their own tax obligations.

> NOTE TO LAWYER: V1 is U.S.-only. Please confirm whether a separate disclaimer is needed for users who attempt to access the app from outside the U.S. (e.g., a geo-block or an "available only in the United States" notice in the app store listing).

## 4. Account Registration

You may create a Looty account using Apple Sign-In or Google Sign-In via our authentication provider, Supabase. You agree to provide accurate information, to keep your account credentials secure, and not to impersonate any other person or entity. You are responsible for all activity that occurs under your account. Buyers may pay for an Order without creating a Looty account; account creation is required only to act as a Seller or to claim a purchased Card into a Spotlight collection.

## 5. Seller Onboarding via Stripe Connect

To accept payment through the Platform, you must complete Stripe Express onboarding and maintain a Stripe Connected Account in good standing. Stripe collects the identity information it requires to comply with U.S. know-your-customer ("KYC") and anti-money-laundering ("AML") rules, including your legal name, date of birth, the last four digits of your Social Security Number, and your bank account details. Looty does not collect or store full Social Security Numbers. Looty receives only status flags and limited account metadata from Stripe.

By onboarding as a Seller, you also agree to the [Stripe Connected Account Agreement](https://stripe.com/connect-account/legal) and to Stripe's Services Agreement, each as updated by Stripe from time to time. Stripe makes its own decisions about onboarding, identity verification, ongoing eligibility, account holds, and reserves; Looty does not control those decisions and is not responsible for them. If Stripe restricts, suspends, or closes your Connected Account, your ability to receive payouts through the Platform will be affected, and Looty may not be able to release pending funds outside of Stripe's process.

> NOTE TO LAWYER: We rely on Stripe Connect Express destination charges so that Stripe is the merchant of record and Looty's regulatory exposure as a payments intermediary is limited. Please confirm this position and the related representation that Looty is not acting as a money transmitter under federal or state law.

## 6. The Service — Buying and Selling

### 6.1 Listings and Point-of-Sale

The Service is a point-of-sale tool for in-person Shows. There is no persistent public listing. For each Order, the Seller selects one or more Cards in the app, sets a total price, and generates a Stripe Checkout link presented to the Buyer as a QR code or shareable link. The Order does not exist until the Seller initiates it; Looty does not create offers on a Seller's behalf and does not match Buyers and Sellers in advance.

### 6.2 Payment Flow

The Buyer pays through Stripe Checkout in a standard web browser. Supported payment methods include credit and debit cards, Apple Pay, and Google Pay, as offered by Stripe. Stripe processes the payment, acts as the merchant of record for card-network purposes, and remits funds to the Seller's Stripe Connected Account subject to the Hold Period and to Stripe's payout schedule. The Buyer is the payor; the Seller is the payee; Looty is the platform that facilitates the connection and collects the Platform Fee.

### 6.3 In-Person Delivery

Cards are delivered hand-to-hand at the Show. Looty does not ship, store, escrow, transport, insure, authenticate, grade, or otherwise handle Cards. Looty does not verify that a Card was actually handed over, that the Card delivered matches the Card described in the app, or that the parties met at all. Sellers are responsible for delivering the Card; Buyers are responsible for inspecting and accepting it.

### 6.4 Buyer Responsibility to Inspect

All Cards are sold "as is." The Buyer is responsible for inspecting each Card before leaving the Show and confirming its identity, condition, and (for slabbed Cards) the integrity of the grading holder and label. Looty does not authenticate Cards, does not verify grades, and does not independently confirm condition. The pricing shown by Spotlight is informational only and is not a guarantee of resale value, fair market value, or any specific price level.

> NOTE TO LAWYER: Pricing is sourced from Scrydex and other third-party feeds. Please confirm whether we need a more specific disclaimer for the pricing display itself, separate from the "as-is" disclaimer for Cards.

## 7. Platform Fee

Looty charges a Platform Fee equal to **4%** of the total Order amount (excluding any applicable taxes). The Platform Fee is disclosed to the Buyer in the Stripe Checkout flow before payment is authorized and to the Seller in the app before the Order is generated. Stripe charges its own processing fee on top of the Order amount (approximately **2.9% plus $0.30** per successful card payment, subject to Stripe's then-current pricing), which is deducted from the Seller's proceeds by Stripe. We may change the Platform Fee on **30 days'** advance notice delivered through the app or by email. Fees in effect at the time an Order is generated apply to that Order.

> NOTE TO LAWYER: 4% Platform Fee, ~2.9% + $0.30 Stripe processing fee, and 30-day notice are all current product-team numbers and may change before launch.

## 8. Hold Period and Payouts

Funds collected from a Buyer are subject to a **3-day** Hold Period before they are released to the Seller's Stripe Connected Account for payout. The Hold Period is measured from the time the Buyer's payment is captured by Stripe. After the Hold Period, payouts to the Seller's bank account follow Stripe's standard payout schedule, typically arriving within approximately two business days, and are controlled by the Seller through the Stripe dashboard. Looty may extend the Hold Period or pause payouts for a specific Order or Seller if we have a reasonable basis to suspect fraud, a chargeback risk, a violation of these Terms, or a regulatory or Stripe-imposed requirement.

> NOTE TO LAWYER: 3-day Hold Period is a product choice intended to mitigate chargeback exposure during the show window. Please advise if a longer or risk-tiered hold is recommended.

## 9. Refunds

In V1, refunds are **Seller-initiated only**. A Seller may issue a full or partial refund through the app for up to **30 days** from the date of the Order. The Platform Fee is non-refundable, except that if a Seller issues a full refund within **24 hours** of the original payment, Looty will refund the Platform Fee to the Seller. Stripe's processing fee is governed by Stripe's own refund policy and may not be returned to the Seller even if a full refund is issued.

Looty may, at its discretion, step in to investigate or resolve a refund request if a Buyer escalates a dispute to us in writing and the Seller is unresponsive, but Looty is not obligated to issue refunds on a Seller's behalf and does not guarantee any particular outcome.

> NOTE TO LAWYER: 30-day refund window, 24-hour platform-fee-reversal window, and seller-only refund initiation are V1 product choices. Please flag any consumer-protection implications (state-level marketplace seller laws, etc.).

## 10. Disputes and Chargebacks

Card-network chargebacks initiated by a Buyer's bank are adjudicated by Stripe under the applicable card-network rules. Looty does not adjudicate chargebacks and does not have authority to reverse a card-network decision. If a Buyer files a chargeback against a Seller, the Seller is responsible for the disputed amount and any chargeback fees imposed by Stripe or the card networks; Looty may deduct or recover those amounts from Seller proceeds or from the Seller's Stripe Connected Account through Stripe's standard process.

Looty may freeze a Seller's pending payouts while a dispute is open, and may suspend or terminate a Seller's access to the Service if the Seller experiences repeated chargebacks, exhibits a pattern consistent with fraud, or fails to respond to dispute inquiries.

## 11. Prohibited Items and Conduct

You will not use the Service to sell, transfer, or accept payment for:

- counterfeit, replica, or reproduction Cards represented as authentic;
- Cards you do not own or have the legal right to sell;
- stolen Cards or Cards subject to a pending recovery claim;
- any item prohibited by applicable federal, state, or local law;
- any item requiring age verification beyond the 18+ eligibility required by these Terms;
- any item that is not a physical trading card;
- any sale that contemplates shipping or remote delivery — the Service is for in-person transactions only.

You will not use the Service to launder funds, evade taxes, structure transactions to avoid reporting thresholds, harass other users, or interfere with the technical operation of the Platform. You will not attempt to reverse-engineer Spotlight, scrape pricing data, or use the Service to build a competing product.

## 12. User Content and Scans

You retain ownership of the scans, photographs, notes, and other content you upload to the Service ("User Content"). You grant Looty a worldwide, non-exclusive, royalty-free license to host, store, process, transmit, and display your User Content for the purpose of operating and improving the Service, including identifying Cards, computing pricing, training and evaluating the Spotlight scanner model, generating internal datasets, and providing support. Scans you upload are treated as private to your account by default and are not shown to other users.

You represent that you have the right to upload the User Content you submit and that doing so does not infringe any third party's rights. You may delete your scans at any time through the app, subject to limited retention for fraud prevention, dispute handling, and legal compliance.

> NOTE TO LAWYER: Please confirm the model-training license language is sufficient and that we do not need a separate opt-in or opt-out mechanism for using scans as training data.

## 13. Intellectual Property

Looty, Spotlight, the Looty logo, and the app's interface are the property of Looty and its licensors. You may not copy, modify, distribute, sell, or lease any part of the Service except as expressly permitted by these Terms.

"Pokémon" and related names, marks, and card designs are trademarks and copyrighted works of Nintendo, Creatures Inc., and GAME FREAK inc. Looty is not affiliated with, endorsed by, or sponsored by Nintendo, Creatures Inc., GAME FREAK inc., The Pokémon Company, or any related entity. Card images displayed in the Service are used to identify physical Cards in users' possession and to facilitate informational pricing.

## 14. Privacy and Data Sharing with Stripe

Our collection and use of personal information is described in the Looty Privacy Policy, which is incorporated into these Terms by reference. Stripe is a sub-processor for payments and Seller onboarding. KYC information collected during Seller onboarding (including full Social Security Numbers) is submitted directly to Stripe and is not retained by Looty; Looty retains only status flags (for example, "onboarding complete," "payouts enabled") and limited account metadata necessary to operate the Service. Looty does not sell personal information to third parties.

> NOTE TO LAWYER: Please align this section with the separately drafted Privacy Policy, and confirm whether a state-specific disclosure (e.g., CCPA/CPRA) is required at the Terms level or only in the Privacy Policy.

## 15. Termination

You may stop using the Service at any time and may close your Looty account through the app or by contacting us. Closing your Looty account does not automatically close your Stripe Connected Account, which is governed by Stripe's terms.

We may suspend or terminate your access to the Service, with or without notice, if we reasonably believe you have: violated these Terms; engaged in fraud, chargeback abuse, or money-laundering; listed prohibited items; misrepresented Cards; harmed other users; or created risk for Looty, Stripe, or the payments system. Sections that by their nature should survive termination — including payment obligations for completed Orders, intellectual property, disclaimers, limitation of liability, indemnification, and dispute resolution — will survive.

## 16. Limitation of Liability

To the maximum extent permitted by law, Looty and its officers, directors, employees, and agents will not be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, or for any loss of profits, revenue, data, goodwill, or business opportunity, arising out of or related to the Service, even if we have been advised of the possibility of such damages.

Our total aggregate liability for any claim arising out of or related to the Service will not exceed the greater of (a) the total Platform Fees you paid to Looty in the **12 months** immediately preceding the event giving rise to the claim, or (b) **one hundred U.S. dollars ($100)**.

Looty is not liable for in-person conduct between Buyers and Sellers, including misidentification of Cards at the table, condition disputes, counterfeit Cards, theft, physical altercations, or failure to deliver. Disputes between Buyers and Sellers about the physical exchange of Cards are between those parties.

> NOTE TO LAWYER: 12-month lookback and $100 floor are the product-team starting position. Please advise if this is enforceable in our target jurisdictions and whether we should switch to "lesser of" to reduce exposure.

## 17. Indemnification

You will indemnify, defend, and hold harmless Looty and its officers, directors, employees, and agents from and against any third-party claims, losses, damages, liabilities, costs, and expenses (including reasonable attorneys' fees) arising out of or related to: (a) your use of the Service; (b) your violation of these Terms; (c) your violation of any applicable law; (d) the Cards you sell, including their authenticity, condition, ownership, or legality; or (e) your interactions with other users at a Show.

This indemnification does not apply to the extent a claim arises from Looty's own gross negligence or willful misconduct.

## 18. Disclaimers

The Service is provided "as is" and "as available." Except as expressly stated in these Terms, Looty disclaims all warranties, whether express, implied, statutory, or otherwise, including warranties of merchantability, fitness for a particular purpose, title, and non-infringement. Without limiting the foregoing, Looty does not warrant that:

- Spotlight will correctly identify any particular Card;
- pricing displayed in the Service is accurate, current, or representative of any actual transaction price;
- any Seller is honest, solvent, or competent;
- any Buyer will appear at the Show, pay, or behave appropriately;
- the Service will be uninterrupted, error-free, or secure against every form of attack.

Card identification and pricing are informational tools to help users make their own decisions, not guarantees.

## 19. Modifications

We may update these Terms from time to time. If we make material changes, we will notify users in-app and, where reasonably practical, by email, at least **14 days** before the changes take effect. Non-material changes (such as clarifications, typo fixes, or updates to contact details) take effect when posted. Your continued use of the Service after the effective date of an update constitutes acceptance of the updated Terms. If you do not agree to an update, you must stop using the Service before it takes effect.

> NOTE TO LAWYER: 14-day notice period is a product-team default. Please confirm it is sufficient for material changes affecting fees, arbitration, or other rights, and whether longer notice or affirmative re-consent is advisable for specific change types.

## 20. Governing Law and Dispute Resolution

These Terms are governed by the laws of the State of Delaware, without regard to its conflict-of-laws rules. The United Nations Convention on Contracts for the International Sale of Goods does not apply.

**Informal resolution first.** Before filing any formal claim, you and Looty agree to try to resolve the dispute informally for at least 60 days after written notice describing the dispute is sent to `legal@looty.app` (for claims against Looty) or to the email address on your account (for claims by Looty).

**Binding arbitration.** Any dispute not resolved informally will be resolved by binding individual arbitration administered by the American Arbitration Association ("AAA") under its Consumer Arbitration Rules. The arbitration will take place in Delaware, or by video or telephone where AAA rules permit, in the English language. The arbitrator may award the same individual remedies that a court could award, but may not award relief beyond the individual claimant.

**Class action waiver.** You and Looty each waive any right to bring or participate in a class, collective, or representative action. The arbitrator may not consolidate more than one person's claims and may not preside over any form of representative or class proceeding. If this waiver is found unenforceable, the arbitration agreement is void as to the affected claim.

**Small claims carve-out.** Either party may bring an individual action in small-claims court for disputes within that court's jurisdiction in lieu of arbitration.

> NOTE TO LAWYER: Please confirm Delaware governing law and AAA Consumer Rules are appropriate, and whether mass-arbitration protections or a JAMS alternative should be added.

## 21. Contact

Questions, notices, and legal correspondence may be sent to:

Looty, LLC
Attn: Legal
`legal@looty.app`

> NOTE TO LAWYER: Add a physical mailing address before the Terms are made operative.

## 22. Effective Date

These Terms are dated **2026-05-15** (placeholder) and are not operative until reviewed, finalized, and posted in the Service.

> NOTE TO LAWYER: Replace placeholder date with the date these Terms are first presented to users and update Section 1 accordingly. Confirm whether existing users (if any during private beta) need affirmative re-consent.
