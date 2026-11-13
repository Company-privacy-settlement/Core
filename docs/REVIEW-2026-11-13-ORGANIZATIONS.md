# Organization access review — 2026-11-13

Scope: Core's organization API, identity transport, SQLite authorization store and browser client; Front's organization workspace and lifecycle handling. [Organization guide](ORGANIZATIONS.md) · [Roadmap](ROADMAP.md).

## Findings and fixes

| Priority | Reproduced behavior | Resulting change |
| --- | --- | --- |
| P1 | Identity transport accepted `FullAccess` from a key response reporting a different block than the finalized block requested. A stale/misrouted provider response could therefore supply an obsolete key authorization. | Require both response `block_hash` and `block_height` to equal the requested finalized snapshot; inconsistent/missing fields return identity unavailability. |
| P2 | Removing an inviter invalidated acceptance, but an unaccepted recipient's inbox still joined the organization's current name. It could reveal a later renamed workspace after invitation authority was lost, and the stale pending row blocked a replacement. | Revoke affected unexpired pending invitations atomically with membership/ownership changes and audit each revocation. Filter inbox results by the issuer's current role/status/version; reconcile older invalid grants when creating replacements. |
| P2 | Network errors, HTML proxy errors and version conflicts retained cached members, old role controls and organization details. A failed first access load could leave a partial signed-in session. | Clear all access snapshots on request failure, abort remaining requests, and clear initial-login credentials when loading access fails. Require a fresh read/reselection; no mutation is replayed. |
| P2 | Organization requests had no client deadline. Non-JSON error bodies threw a JSON parser exception and lost the HTTP denial status. | Apply a 25-second deadline combined with caller cancellation. Preserve error HTTP status; malformed successful responses become `502 INVALID_RESPONSE`. |
| P2 | HTTPS URL validation did not reject Node's global TLS certificate-verification disable flag. | Refuse organization identity transport construction when `NODE_TLS_REJECT_UNAUTHORIZED=0`. |

Oversized or incomplete rejected HTTP requests now close their connection rather than retaining a draining upload after its application work slot has ended. This follows the existing settlement API's input-failure behavior.

## Evidence

Before the fixes, four new Core regressions failed for snapshot mismatch, disabled TLS, inviter removal and ownership-transfer invalidation. Two additional browser-client regressions failed for non-JSON status preservation and request deadlines. Eight desktop/mobile cases failed for failed refresh, proxy HTML, version conflict and partial login. The corrected targeted suites passed afterward.

Core regression coverage also checks historical invalid invitation rows reopened from disk, replacement grants, per-organization revocation audit and connection closure for oversized input. Existing isolation, signature replay, session revocation, deadline admission and ownership invariants remain in [organization tests](../tests/organizations.test.ts). Front covers the failure paths in its [organization browser suite](https://github.com/Company-privacy-settlement/Front/blob/main/tests/browser/organizations.spec.ts).

Validation on 2026-11-13: all **256 Core tests** (including **24 organization regressions**), **120 Front desktop/mobile browser cases** (including **22 organization cases**), Core/Front type checks, SDK/static builds and both compiled-service runtime harnesses passed. Browser bundle synchronization and the documentation link/schema check also passed. Hosted Actions and public-network deployment were not run.

The stricter identity check uses the fields defined by nearcore's [RPC query response](https://github.com/near/nearcore/blob/master/chain/jsonrpc-primitives/src/types/query.rs). The unsafe environment setting is described in [Node's TLS configuration](https://nodejs.org/download/release/v22.23.0/docs/api/cli.html#node_tls_reject_unauthorizedvalue). Consistent RPC responses still depend on the selected provider; these checks do not turn it into a light client.

The changes use the existing database schema. Historical invalid invitations are hidden immediately by read-side checks and cleaned up during authorized mutation; no database deletion or role migration is required. No public-chain transaction, server provisioning or key removal is part of this review.
