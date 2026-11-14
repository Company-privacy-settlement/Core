# KYB provider and independent rule-review qualification

[KYB integration](VERIFICATION.md) · [Rule engine](RULES.md) · [Tax drafts](TAX_DRAFTS.md)

This runbook separates implemented state handling, authenticated provider observations, official source-byte checks and independently trusted signed rule reviews. A successful local test or a locally generated signing key is not a live provider decision or independent professional review.

## Current result — blocked

The [2026-11-14 qualification report](evidence/provider-qualification-2026-11-14.json) records an actual fetch of the six unique official source URLs used by the catalog. Four exact document hashes matched: IRS Publication 15 for 2025 and 2026, the UAE Ministry of Finance overview and the ADGM February 2025 FAQ. The UAE FTA FAQ was unavailable to this fetch, and the UAE legislation download returned HTTP 403; the latter also lacks a pinned catalog document hash. These failures do not establish a legal change.

No Sumsub configuration, authorized live-case list, independently supplied reviewer-policy pin or external signed review was present in this environment. **No authenticated Sumsub request was made.** All seven rules remain without a verified external review in this report. The CLI exited **2** and kept `productionQualified: false`; the development catalog was not rewritten or promoted to approved rules. The actual-provider completion criterion remains open.

## Adapter corrections

The official Sumsub contract check found two real compatibility gaps: a profile's `deleted: true` could retain its old GREEN decision, and `companyStructureChanged` was rejected by the applicant-only event filter. The adapter now treats that flag as revocation, rejects malformed deactivation flags, accepts authenticated structure-change invalidation and fences a root deactivation observed during graph traversal. Revoked subjects are not treated as approved because an obsolete review endpoint remains GREEN. Local case revocation remains irreversible even if Sumsub later reactivates the profile; starting a new case requires an explicit action.

TLS certificate verification must remain enabled at provider construction and before each credential-bearing request. Official contract references: [deactivation response](https://docs.sumsub.com/reference/deactivate-applicant-profile), [webhook events](https://docs.sumsub.com/docs/user-verification-webhooks), [request authentication](https://docs.sumsub.com/reference/authentication), [environment-bound app tokens](https://docs.sumsub.com/docs/app-tokens).

## Prepare actual provider inputs

Copy the [qualification template](../examples/provider-qualification.template.json), [Sumsub configuration](../examples/sumsub-config.template.json) and [authorized-case template](../examples/sumsub-qualification-cases.template.json) into an owner-only directory outside the repository. All input files must be regular, mode 0600, process-user-owned files; symlinks are refused. Relative paths resolve from the qualification file's directory. Use a read-only app token where supported. Do not paste secrets or identity documents into chat, commit them, or use a customer key as an API secret.

Supply:

1. `sumsubConfigFile`: the operator's real sandbox or production account configuration, including client, environment, hosted region and the exact company/individual review levels.
2. `casesFile`: explicitly authorized **existing** provider cases. Cover `in_review`, `needs_information`, `approved`, `expired` and `revoked`, with both USA and ARE country coverage. Use generic report references, not names. Remove every `REPLACE_…` placeholder before use.
3. `ruleTrustFile` and `trustedRulePolicySha256`: the actual reviewer trust policy and its canonical SHA-256 obtained through an independent operator channel. A policy and hash delivered together by an untrusted sender do not establish reviewer authority.
4. `ruleReviewFiles`: external reviewers' Ed25519-signed review artifacts for the exact catalog and rules. A review must be current, covered by current reviewer dates, unrevoked in the supplied policy and valid for each selected rule. This qualification checks all seven bundled rules.
5. `ruleAuthorIds`: the operator's declared rule-author identities. A signature by a listed author does not count as independent review. Different identifiers or keys alone do not establish different people, professional licensing or organizational independence; verify those facts outside the tool.

This code currently supports Sumsub and the existing independent signed-rule workflow. It does not invent a tax-filing provider connection, professional identity, credentials or a qualified signature. A separate commercial tax provider needs its actual account, supported API and agreed review scope before qualification can be claimed.

## Run and interpret

```bash
npm run providers:qualify -- check /secure/providers/qualification.json \
  /secure/providers/new-qualification-report.json
```

To collect only the public source check:

```bash
npm run providers:qualify -- sources /tmp/new-rule-source-report.json
```

The output path is reserved exclusively before network work, mode 0600, and never overwritten. Exit **0** means the checks passed for this stated scope, **2** means a valid report contains blockers, and **1** means input/execution failure. Pre-write failures leave a structured failure artifact when the output can be reserved. Generated reports are point-in-time observations; protect them and re-run after policy, source, authority or provider changes.

After `npm run build:service`, use `npm run providers:qualify:compiled -- check ...` with the same arguments on a host without development-only `tsx`.

Sumsub qualification makes authenticated **GET requests only**. It does not create applicants, upload documents, choose a decision, request a recheck or deactivate a customer. The company, beneficial-owner graph, client, country and review levels are checked by the same adapter as the Organization API. Reported expiry derives from the oldest accepted review time and configured local validity days; it is not a provider-imposed universal deadline. Existing-case state coverage is distinct from observing every transition of one real business. Use the live Organization workflow and signed webhook delivery logs to qualify that operational journey after account setup.

For webhook qualification, configure the actual HTTPS Organization API callback, verify real HMAC-signed delivery and replay the same provider delivery to confirm deduplication. Manual test-send payloads containing `testMode` are rejected as real decisions. Company/beneficiary changes invalidate cached approval; events never authorize GREEN by themselves. The server polls current provider data, backs off failures, expires old approval without extending it on repeated GREEN, and preserves revocation across restore. Local, fixture-backed cases exercise those lifecycle paths; live callback delivery remains unobserved here.

The source checker fetches the catalog's HTTPS official hosts with bounded bodies/timeouts and approved redirects only. It records HTTP status, final URL, exact bytes and SHA-256; PDF URLs must return PDF bytes. Missing pins, changed bytes and inaccessible bodies require review. It does not update a pin, infer a law change from dynamic HTML, or prove that an old FAQ includes later amendments. The ADGM FAQ hash is not a verification of the unavailable consolidated regulations.

Rule checks verify the catalog/rule binding, independently supplied policy hash, Ed25519 signature, author exclusion, authority/review dates and supplied revocations. The report explicitly leaves automatic professional-qualification verification, tax filing integration and production qualification false. The accepted policy is a supplied snapshot, not a live licensing or revocation-registry lookup. Existing KYB/rule status does not authorize a payment or change permissionless settlement contracts.

## Validation

The lifecycle and qualification suites cover profile/beneficiary revocation, late deactivation, structure-change events, TLS rejection, exact source bytes, duplicate source locators, changed/missing sources, unsafe redirects/files, absent credentials, authenticated read-only state coverage, private-data exclusion and invalid/self-authored/expired/revoked reviews. Provider responses and reviewer keys used in these tests are controlled fixtures, never external approval evidence. The published qualification report contains real public-source retrieval and an explicit missing-input result.

Local verification passed **595 Core tests**, including the **40 lifecycle/qualification cases**; the latest seven qualification cases also verify that unfinished case-list placeholders send no provider request. Types, service build, compiled CLI failure/redaction/overwrite checks and sequential compiled API/indexer/organization restart/backup/recovery checks passed. The browser SDK bytes remain unchanged. None of these local results changes the blocked actual-provider result above.
