# US and Abu Dhabi rule engine

Front **Rules** (`/rules/`), the browser/Node SDK and the local CLI prepare defined components using a versioned catalog. Selection requires an exact jurisdiction, employment/payment relationship and payment/termination date. Calculations produce exact fiat minor-unit amounts or explicit reporting decisions, with input/catalog hashes, assumptions, intermediate arithmetic and official source references. They never change an invoice, sign a settlement, deduct a token fee or file a return.

## Review status is explicit

The seven bundled definitions are **source-checked candidates**, not professional tax/legal approvals. Development checked official material on **2026-11-14** and tested arithmetic. No qualified external reviewer, approved organization policy or signing key was supplied. Preview is always `preview_unapproved`. `reviewed` mode refuses to calculate without an Ed25519-signed approval of the exact catalog/rule and an independently trusted reviewer policy digest. A signature establishes the operator-trusted key's approval, not professional qualifications or the truth of payroll/classification facts.

Current consolidated UAE labour-law and ADGM October 2025 regulation downloads were unavailable from the primary hosts. The source capture log records those errors instead of inventing document hashes. The mainland candidate references the official Article 51; the ADGM candidate uses the official EAO February 2025 FAQ and explicitly requires comparison with current amendments before signing an operational review. These candidates must not be treated as a substitute for that review.

## Supported components

| Jurisdiction / relationship | Rule coverage | Preparation |
| --- | --- | --- |
| US federal / employee | Calendar 2025 and 2026, separately versioned | Standard covered-wage Social Security, Medicare and employee Additional Medicare withholding components using the declared same-employer tax-year YTD |
| US federal / contractor or B2B | Calendar 2025 and 2026, separately versioned | Potential 1099-NEC reporting trigger for reviewed reportable direct services to a US noncorporate payee, including a backup-withholding occurrence flag |
| Abu Dhabi mainland or ADGM / B2B or contractor | Standard VAT candidate, 2018–2026 coverage | Explicitly classified domestic standard-rated tax-exclusive supply from a VAT-registered supplier |
| Abu Dhabi mainland / employee | Statutory candidate, 2022-02-02 through 2026 | Standard full-time foreign private-sector gratuity path, reviewed creditable service, monthly Basic Wage and a separately declared two-years-Wage cap basis |
| ADGM / employee | ER 2024 candidate, 2025-04-01 through 2026 | Standard full-time non-UAE/GCC statutory gratuity path, annual wage basis, minimum Basic Wage floor and annual daily divisor |

Effective intervals are the supported catalog coverage, not a claim that a law stops applying on the final date. No 2027 value is inferred. ADGM before 1 April 2025 is unsupported rather than falling back to mainland law. A US state is required as context but **no state/local taxes are implemented**; output covers federal components only. Tax year must match the payment date. Unknown/overlapping scope, stale/invalid reviews and missing applicability facts remain unresolved; they do not become zero tax.

Corporate income tax, federal wage income-tax withholding tables, FUTA, state/local payroll and sales taxes, self-employment tax, treaties, foreign payees, corporate exceptions, card/platform reporting, withholding/filing deadlines, exempt/zero-rated/reverse-charge VAT, pension/savings substitutions, leave/salary deductions and full final settlements are outside this version. An employment or transaction classification is supplied by the reviewer/user; KYB or wallet ownership does not establish it.

## Arithmetic and facts

Inputs are `core-rule-input-v1` JSON: `{jurisdiction, relationship, effectiveDate, currency, facts}` plus the format identifier. Fiat currency is USD for US federal components and AED for Abu Dhabi components. Amounts are **integer strings in cents/fils**, bounded to 18 digits. Negative, floating, exponent, noncanonical and oversized monetary inputs are rejected. No USD/USDC/AED parity or exchange rate is assumed. The catalog and inputs contain no wallet key, document or identity-number field.

- FICA uses separate current Social Security and Medicare taxable wage amounts and prior same-employer YTD bases. Social Security applies only to remaining capped wages; Medicare is uncapped; the additional employee component applies to the increment above the employer withholding threshold, without an employer match. It is not an individual's final income-tax liability or net pay.
- Reporting compares the declared annual reportable total to that year's threshold; actual backup withholding can trigger reporting even below it. The result is a potential reporting obligation, not a tax amount or filed form.
- Standard VAT multiplies the explicitly reviewed tax-exclusive taxable base by its rate. Merely choosing ADGM does not exempt a supply.
- Gratuity takes reviewed complete service years and a rational residual year (`fractionNumerator / fractionDenominator`, denominator 1–366). The engine does not infer date counting, unpaid absence, worker eligibility or alternate schemes. Below one complete year it returns no statutory component for this supported case; a contract may grant more. Mainland uses its monthly basis and cap; ADGM uses annual Basic Wage subject to its annual-Wages floor and does not import the mainland cap.

Every amount step records a numerator, denominator, input basis, cap/threshold/rate where applicable and **half-up rounding only at the final fiat minor unit**. Intermediate daily wages and fractions are not rounded. This is the explicit arithmetic preparation policy that the reviewer must approve, not a claim that every authority or payroll system uses identical reporting/adjustment rules. Separate employee/employer liabilities and unlike components are not combined into a misleading net payment or tax-expense total.

## Browser workflow

1. Open Rules; choose jurisdiction, relationship and applicable payment/termination date. Enter exact facts. **Load sample facts** is an explicit synthetic example; its checked classifications do not verify a real worker or supply.
2. **Calculate unapproved preview** shows candidate arithmetic, sources and uncovered scope. Changing context/facts clears the previous result. No automatic signing or filing action exists.
3. For reviewed evaluation, import a reviewer trust JSON and signed review, and enter the trust-policy SHA-256 received **independently** from the operator. A public key and digest supplied together by an untrusted sender do not establish authority.
4. **Evaluate reviewed rules** checks the catalog hash, covered rule ID, signature, trusted key dates, review dates and supplied revocation hashes before calculating. Status is `reviewed_component`, never full payroll/legal approval.
5. Export a readable JSON evidence snapshot, or import it to recompute exact calculation integrity. Current reviewer-policy checks are reported separately: arithmetic can remain intact after review revocation/expiry. Reverification does not establish that the declared inputs are true.

Facts, trust/review files and results remain in browser memory. Page-hide/history-cache return, unmount and explicit clear discard the workspace and abort pending work. No organization API, provider or browser storage receives these figures. An exported JSON contains readable financial facts; protect it. Review-expired results cannot be exported as currently accepted; reload current trust/review material and evaluate again.

## Review governance and CLI

Use the independently distributed trust document shape:

```json
{
  "format": "core-rule-trust-v1",
  "reviewers": [{
    "id": "YOUR_AUTHORIZED_REVIEWER",
    "publicKey": "REPLACE_WITH_CANONICAL_32_BYTE_ED25519_PUBLIC_KEY_BASE64",
    "validFrom": "2026-11-14",
    "validThrough": "2026-12-31"
  }],
  "revokedReviewHashes": []
}
```

Reviewer identity/qualifications and policy distribution are operator responsibilities. The engine checks the supplied policy and revocations, not an online professional registry or live global revocation service. Distribute an updated independent digest when keys/approvals are removed; an old still-valid policy cannot reveal a revocation that was never supplied. No default key or professional approval is shipped.

```sh
npm run --silent rules -- catalog /secure/catalog.json
npm run --silent rules -- catalog-hash
npm run --silent rules -- review-template YOUR_AUTHORIZED_REVIEWER /secure/claims.json
```

The claims template intentionally has **no approved rule IDs** and a replacement rationale. The reviewer must inspect the catalog, current primary law and captured-source gaps, choose the exact IDs, complete rationale/validity and check fixtures/rounding/classification before signing. Review timestamps cannot predate the source-check date or be in the future; review/key validity is checked at evaluation time. The signature binds a domain-separated canonical claims message, including the entire catalog hash and selected IDs. The catalog also binds a SHA-256 of the rules implementation and canonical/hash helpers; the source consistency test enforces that digest. Editing those engine sources, a rate, source, limit, interval or engine/catalog version requires an updated catalog and invalidates earlier approvals. This is release/review integrity, not remote execution attestation.

```sh
npm run --silent rules -- review-sign /secure/claims.json /secure/reviewer.key /secure/review.json --acknowledge-reviewed-rules
npm run --silent rules -- policy-hash /secure/trust.json
npm run --silent rules -- evaluate /secure/input.json preview /secure/preview.json
npm run --silent rules -- evaluate /secure/input.json reviewed /secure/review.json /secure/trust.json INDEPENDENT_POLICY_SHA256 /secure/result.json
npm run --silent rules -- verify /secure/result.json /secure/trust.json INDEPENDENT_POLICY_SHA256
```

The CLI never generates a trusted key automatically. The sign command requires a caller-owned regular Ed25519 key file with mode 0600, no symlink and an explicit review acknowledgement; signing is not itself a legal review. JSON outputs use exclusive creation and mode 0600 so existing evidence is not overwritten. Without an output path results go to stdout; avoid sending sensitive facts to shared logs. `build:service` also emits this CLI for `npm run rules:compiled -- ...`, with no proving/Rust/tsx requirement at runtime.

The Node/browser SDK exports `ruleCatalog`, `ruleCatalogHash`, `ruleInputExample`, `parseRuleInput`, `parseRuleTrust`, `ruleReviewMessage`, `verifyRuleReview`, `evaluateRules`, `exportRuleResult` and `verifyRuleResult`. The SDK catalog matches [catalog.json](../compliance/rules/catalog.json). [Source capture manifest](../compliance/rules/sources.json) records downloaded document byte hashes and explicit failures; raw source files were not bundled. There is no automatic network refresh or approval of changed law. Rule/source updates require a new catalog hash, fixtures and reviewer approval; report verification requires the matching catalog/engine version.

Official source links and locators are embedded in each result. Core [compliance scope](../compliance/README.md), [service boundaries](SERVICE.md) and [roadmap](ROADMAP.md) distinguish this component engine from future AI drafts, statutory filing and real-world qualification.

Validation on **2026-11-14**: 31 focused rule-engine cases in 459 passing Core tests, 16 Rules desktop/mobile cases in 240 passing browser cases, SDK/static builds, compiled CLI preview/export/reverification and service recovery checks. Browser mobile cases emulate Chromium, not qualified real mobile devices. Source consistency and synthetic signatures validate implementation behavior, not professional rule approval or tax filing.

## Source-bound tax preparation drafts

[AI tax and procedure drafts](TAX_DRAFTS.md) connect verified rule reports and exact selected-receipt bindings to cited English preparation, encrypted organization storage and independent versioned review. AI only arranges verified statement IDs; deterministic outlines are labelled separately. Source/policy/membership expiry suspends internal approval. Restore invalidates all draft reviews and abandons pending generations. No statutory filing or payment is authorized. See the guide for permissions, API, provider configuration and independently pinned reviewer policy.

## Provider qualification and fresh source checks

The [provider qualification CLI](PROVIDER_QUALIFICATION.md) re-fetches exact official source bytes and checks independently pinned reviewer policy, signed catalog/rule coverage, author exclusion, current dates and supplied revocations. It never creates an independent reviewer or rewrites a catalog pin/rate. Four of six unique catalog source hashes matched in the dated run; two sources were unavailable and no external review artifacts were configured. Those rules remain candidates; source-byte matches do not establish current legal applicability or professional approval.
