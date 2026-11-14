# Hackathon instant KYB

The hackathon deployment can show immediate **Demo approved** status without waiting for a verification provider. This is a separate demo result; it never establishes verified legal identity, issues a credential or grants wallet signing or organization permissions.

## Enable explicitly

The frontend build uses `NEXT_PUBLIC_MONEY_STATION_DEMO_KYB=1`. Entering `/kyb/` or `/kyb/status/` initializes an approved, clearly labelled sample business in memory. No identity document contents are read or uploaded. Editing intake details invalidates approval until the completed request is reviewed again. Reloading restores the sample rather than retaining entered business data. Exported evidence includes `demoApproval` while `verified`, `credentialIssued` and provider-submission claims remain false/not sent.

The Organization API uses `CORE_ORGANIZATION_DEMO_KYB=true` (default false). For an authorized organization with no existing provider case, its verification response adds:

```json
{"demo":{"mode":"hackathon","state":"approved","identityChecksPerformed":false,"credentialIssued":false}}
```

The actual provider `case` remains null and provider configuration remains separate. Existing provider cases, including revoked or stale cases, never receive this shortcut. A real Sumsub provider and demo mode cannot be enabled together. Anonymous requests, wrong tenants, unprivileged/revoked memberships and revoked wallet keys retain their existing denial behavior. `/v1/me` and organization `kybVerified` claims remain false. Readiness reports `demoKybEnabled: true` when enabled, while `identityClaimsVerified` remains false.

For the owner-managed Ubuntu backend, prepare a clean reviewed commit with:

```bash
MONEY_STATION_DEMO_KYB=true node ops/ubuntu/prepare-backend.mjs
```

The generated private config contains `demoKyb: true`; the supervisor passes the explicit runtime flag only to the Organization API. Preserve existing databases and encryption keys during restart. The APIs and wallet identity source remain on their existing NEAR testnet configuration.

## Return to provider review

Set the backend switch to false and rebuild the frontend with `NEXT_PUBLIC_MONEY_STATION_DEMO_KYB=0`. Demo approval is a presentation of the explicit runtime setting, not a stored provider decision, so disabling it cannot leave a historical approved provider case behind. The full frontend deployment gate rejects a hackathon flag. Configure the actual provider separately before relying on real business verification.

## Validation

Core's authenticated HTTP tests cover immediate/default-off behavior, unchanged identity claims, tenant/role/session/key boundaries, existing/revoked cases and mutually exclusive provider setup. Front unit and desktop/mobile browser cases cover automatic sample approval, export claims, edit invalidation, review and reload. Live deployment observations are recorded separately from fixtures.
