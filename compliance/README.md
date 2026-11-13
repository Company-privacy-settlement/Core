# Business verification and tax-preparation scope

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md)

Core implements private settlement first. Initial preparation targets are the United States and Abu Dhabi, UAE. The US state/federal scope and ADGM versus Abu Dhabi mainland must be resolved for each business/payment; these are not interchangeable jurisdictions. [Service overview](../docs/SERVICE.md) · [Roadmap](../docs/ROADMAP.md).

## Implemented

Front’s six-page `/kyb/` flow separates overview, business, people/beneficial ownership, documents, review and status. It is **sample intake**, with drafts held in memory and discarded on reload or leaving the KYB layout. File contents are never read/uploaded. Complete fields and an authority acknowledgement allow downloading local preparation; edits invalidate preparation and jurisdiction changes clear dependent data.

Exports explicitly state `verified: false`, `credentialIssued: false`, `providerSubmission: not_sent`. No provider receives the request, legal entity is approved or payment eligibility is issued.

The separate KYB SDK validates Ed25519 signatures from explicitly trusted issuers, subject binding, expiry and supplied revocations. Its cryptographic checks do not perform identity review, fetch current provider decisions automatically or enforce admission inside the current circuit.

Receipts commit to declared fields and allow selected integrity proofs. Separate evidence verification can anchor selected transaction records to finalized events. Neither establishes declaration truth, legal identity, complete company history, tax certification or filing acceptance. Invoice checkout requires its signed unit reference; an arbitrary receipt root cannot replace it.

## Planned preparation process

1. Classify B2B, employee or contractor payments and establish the parties’ relevant jurisdictions and effective date.
2. Resolve US state/federal obligations or ADGM/mainland status before selecting dated, versioned official rules.
3. Calculate using deterministic reviewed rules; use AI to prepare cited, reviewable explanations and document drafts.
4. Integrate a real KYB/KYC provider for entity/beneficial-owner review, trusted credentials and current revocation handling. Circuit-enforced eligibility requires separately versioned contract/circuit work.
5. Keep supporting documents encrypted off-chain, with access controls and retention/deletion rules; disclose selected evidence to an authorized reviewer.
6. Route drafts through appropriate review and a separately implemented filing/payment process. Preparation is not approval or submission.

Tax rates/calculation, payroll withholding, treaty analysis, AI legal drafts, real provider calls, statutory filing and fiat conversion are **not implemented**. No rates or legal outcomes are inferred from the current UI.

Do not put legal names, beneficial-owner documents, salary details or raw tax forms on-chain. Detailed payment/evidence boundaries: [privacy](../docs/PRIVACY.md), [browser receipts](../docs/BROWSER_RECEIPTS.md), [invoices](../docs/INVOICES.md).
