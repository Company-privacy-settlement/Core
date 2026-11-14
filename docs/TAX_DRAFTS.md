# AI tax and procedure preparation drafts

Organization → **Tax drafts** creates an English, cited preparation document from a verified US/Abu Dhabi component-rule report and selected-field receipts. The model arranges validated statement IDs; the service renders their exact source-bound text. It cannot introduce free-form legal advice, rates, deadlines or new sources. The deterministic outline is a separate, explicitly labelled option when no AI provider is configured.

## Prepare a draft

1. In **Rules**, export a calculation report for the correct jurisdiction, relationship and applicable date. Current signed rule acceptance requires a qualified review distributed under the operator's independently pinned policy; the bundled candidate rules have no professional approval.
2. In **Evidence receipts**, export a selected disclosure containing an amount and its declared fiat currency. Obtain its expected root independently. A token transfer amount is not inferred to be a salary/fiat amount; no conversion occurs.
3. In **Organization → Tax drafts**, enter a title, import the report and disclosure, enter the expected root, and bind the disclosed amount to an exact `*Minor` input fact. The browser supports one receipt per form; the SDK/API support 1–4 per revision. Currency must equal the report currency. SDK callers may also bind the disclosed currency/date literally to `currency`/`effectiveDate`.
4. Choose **Save grounded outline** or **Generate with configured AI**. The browser checks report arithmetic, receipt integrity and exact value bindings; the server independently repeats validation with its operator policy. Uploaded client trust documents cannot enable approval.
5. Inspect summary, calculation, evidence, internal preparation steps, unresolved facts and the source register. Export JSON or cited Markdown only while still authorized.

Official citations retain source URL, locator, checked date and document digest; report and receipt references retain exact hashes. Receipt proof integrity is checked against the caller-supplied root. It does not establish an independently anchored root, truthful declarations, actual employment/classification, payment finality, identity or tax acceptance. Unbound facts and all component limitations remain visible and mandatory. Preparation steps are identified as the internal workflow, not invented statutory filing instructions.

## Review and immutable revisions

| Action | Current permission / result |
| --- | --- |
| Read / export | Owner, Admin, Operator, Auditor; scoped to one organization |
| Create / submit | Owner, Admin, Operator; only the revision author submits |
| Approve, request changes, reject, withdraw | Another Owner/Admin; self-review is denied |
| Revise | Original author with create permission, or Owner/Admin; exact current version/hash required |

The workflow is `draft → in_review → approved / changes_requested / rejected`; approved drafts can become `withdrawn`. Changes create a new immutable revision with fresh review. Payload, citations, input, plan and producer are hash-bound. Review comments append to encrypted history. Previous revisions remain historical and cannot retain current approval after a new head is created.

Approval requires three explicit acknowledgements: rule basis reviewed, evidence reviewed and internal-preparation scope understood. The server requires current independently trusted signed rule acceptance and unchanged grounding. It rechecks current author and reviewer membership versions and permissions. Internal approval expires within 24 hours and no later than the rule review; source expiry/revocation, changed operator policy, author/reviewer membership changes, supersession and restore invalidate acceptance. This is an internal review status, not a qualified professional's opinion, statutory acceptance or payment authorization. Exported status is a snapshot; reconnect to the authorized service for current status.

## Constrained AI and privacy

The optional OpenAI Responses adapter sends only the public rule ID, section names and categorical statement IDs/kinds/required flags. Financial amounts, receipt fields, roots, labels, organization/account names, titles and comments stay outside the model request. The server does receive the report and selected disclosures for validation and encrypted storage. Do not upload full private documents or payment notes.

The request uses strict JSON schema, `store: false`, no tools, a fixed HTTPS endpoint, bounded output and a timeout. The service rejects refusals, incomplete/malformed responses, unknown/duplicate/misattributed IDs and omitted mandatory content. Failed AI calls do not silently become an outline. Model-selected ordering is the extent of AI composition; this feature does not summarize arbitrary uploaded documents or generate autonomous jurisdiction-specific legal prose. Provider processing remains subject to the configured provider account's terms; `store: false` does not promise zero provider retention.

A durable UUID reserves each generation. Exact completed retries return the same draft. Changed request bodies conflict; pending/failed/abandoned IDs are never automatically re-executed. One generation may be pending per organization. The list exposes the pending request for recovery after reload; authorized creators or reviewers can inspect and abandon it. Abandonment fences late persistence, including a response arriving after cancellation. A provider may already have processed or charged an uncertain request. A new explicitly initiated attempt needs a fresh UUID. Leaving the page discards browser uploads and late responses; it does not itself prove remote cancellation.

## Storage, backup and limits

Draft payloads, evidence, titles and comments use AES-256-GCM with domain-separated associated data and the protected organization invoice key ring. HMAC indexes bind request IDs/bodies. Operational IDs, actors, states, versions, timestamps and content hashes remain database metadata. Audit events contain action/hash metadata rather than private draft bodies or comments. Storage keys are required even for outlines; no plaintext fallback exists.

Creation/revision bodies are limited to 128 KiB after create-role admission; other organization bodies retain the 8 KiB limit. A draft write consumes five rate-limit points. Each organization supports 25 draft families, 50 total revisions and 500 generation requests; these are bounded hackathon limits, not archival retention. [Organization backups](ORGANIZATION_BACKUPS.md) include the three draft tables as an all-or-none optional inventory for compatibility with older backups. Restore invalidates every draft review and abandons pending generations, in addition to session invalidation and existing access quarantine. Preserve the encryption key ring separately.

## Operator setup

Direct Node startup uses the existing organization service and invoice encryption configuration plus:

```bash
CORE_AI_DRAFT_CONFIG_FILE=/secure/provider.ai-draft-config.json
CORE_DRAFT_RULE_POLICY_FILE=/secure/rule-trust.json
CORE_DRAFT_RULE_POLICY_SHA256=INDEPENDENT_CANONICAL_POLICY_SHA256
```

AI configuration is optional. Copy [the example](../ops/ai-draft-config.example.json) outside the repository, set an account-supported structured-output model and real API key, and use mode `0600`, service-user ownership and a regular file (no symlinks). There is no hard-coded default model. The policy file has the same owner-only requirements; derive its canonical digest with `npm run --silent rules -- policy-hash /secure/rule-trust.json` and independently verify the expected digest. See [reviewer policy format](RULES.md). The file and digest must be configured together. The policy is re-read when validating a draft; a changed/unavailable pin suspends acceptance rather than granting trust.

For Compose, apply the base, invoice-keys and [drafts overlay](../ops/organizations.drafts.compose.yaml), using the absolute host paths documented in [the environment example](../ops/organizations.env.example). Secret mounts are read-only and do not create missing host files. The container's runtime UID must own and read those files. Outline-only deployments can omit the AI overlay and configure policy directly; without a trusted policy drafts remain unapproved preparation material. Keep credentials out of the browser, repository and exported drafts.

## SDK and private API

`OrganizationTaxDraftClient` uses the authenticated `OrganizationClient` session. `draftBasis`, `validateDraftPlan`, `renderTaxDraft`, `verifyTaxDraft` and `exportTaxDraft` are available in the Node/browser SDK. Hash checking verifies transport integrity, not independent service authority or current professional review.

Base: `/v1/organizations/:organizationId/tax-drafts`.

| Method | Relative path | Purpose |
| --- | --- | --- |
| GET / POST | `/` | List current families and pending job / create |
| GET | `/:id` | Fetch a specific authorized revision and current acceptance |
| POST | `/:id/revise` | Create a new immutable head using parent version/content hash |
| POST | `/:id/submit`, `approve`, `changes_requested`, `reject`, `withdraw` | Versioned, content-bound review transition |
| GET | `/requests/:requestId` | Recover generation status |
| POST | `/requests/:requestId/abandon` | Fence a pending generation using its current version |

Creation accepts `{requestId,title,mode,basisInput:{report,evidence}}`; revision also requires parent `version` and `contentHash`. Decisions require `{version,contentHash,comment}`; approval additionally requires `basisReviewed`, `evidenceReviewed`, `scopeAcknowledged` all `true`. Changes/rejection require a meaningful comment. Unsupported/extra request fields are rejected. Backend permissions and membership checks apply regardless of UI controls.

## Validation and external dependencies

Local tests cover source/value integrity, AI request minimization, structured-response rejection, role/tenant isolation, independent review, immutable revisions, replay/abandon fencing, policy/membership expiry, encrypted storage, restore invalidation and SDK/HTTP behavior. Desktop/mobile browser coverage includes revision approval, outline-only mode, wrong roots, unsigned rule gating, role restrictions, cited exports and private-context disposal.

OpenAI transport is exercised against a controlled response fixture; no production API key or live model call was supplied. Operator credentials, model availability, independently qualified rule review and backend deployment remain external activation requirements. No filing connector, withholding execution or professional tax opinion is supplied. Implementation follows [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) and the [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create).

Local verification on **2026-11-14** passed **488 Core tests** (29 draft-specific), **256 desktop/mobile browser cases** (16 draft-specific), three Front unit tests, types, SDK/static builds, compiled service recovery and documentation/source-inventory checks. Provider/reviewer behavior used controlled fixtures.

The full browser gate completed as separate desktop (128/128) and mobile (128/128) runs, both exit 0. An earlier combined run was interrupted before its final report and is not counted as a passing run.
