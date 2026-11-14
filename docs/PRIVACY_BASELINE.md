# Privacy baseline measurement

[Privacy model](PRIVACY.md) · [Native testnet evidence](TESTNET_WALLET.md) · [Indexer](INDEXER.md)

Core provides a read-only baseline for public participation, funding concentration and time/amount correlations. It does not identify independent people from addresses or compute a proven effective anonymity set. Nothing in the measurement locks withdrawals, schedules cover traffic or broadcasts a transaction.

## Actual native testnet baseline — 2026-11-14

The collector reverified the original fourteen FINAL signed transactions, canonical historical snapshot, deployed code/key bindings and settlement balances, then read all eight immutable registry records. Each record was matched by fingerprint to a successful registry-executed receipt in one of the five deposit/withdrawal/recovery transactions. Record height/timestamp were checked against canonical receipt blocks. This is public-RPC verification, not a light-client proof.

[Public observation dataset](evidence/privacy-native-observations-2026-11-14.json) · [Measured report and chain verification](evidence/privacy-native-baseline-2026-11-14.json)

| Measurement | Observed result |
| --- | --- |
| Registry journal | 8/8 records, contiguous from genesis; all transaction attributions present |
| Deposit note outputs | 2, each 0.1 NEAR; 0.2 NEAR principal total |
| Public deposit / original-withdrawal signers | 1 / 1, the same payer |
| Declared controllers | 1, explicitly an operator declaration, not verified independent identity |
| Independent people / verified business customers | Unknown (`null`), never inferred from address count |
| Direct deposit-source largest share | 100% from the public payer |
| Direct deposit-source HHI / inverse HHI | 1 / 1 source-diversity unit |
| Upstream funding | Not collected; concentration is unknown, not zero |
| Original withdrawal requests | 2; failure/retry/completion do not create new requests |
| Same-amount historical output candidates | 2 for each original request |
| Same-amount candidates within 60 seconds | 0 for each; the time window misses the prior deposits |
| Same-amount candidates within 300 / 3,600 / 86,400 seconds | 2 for each |
| Nearest prior output lag | About 84.79 seconds and 101.12 seconds, one nearest timestamp each |
| Same-public-signer historical candidates | 2 for each request |

Two candidate notes from one public payer do not establish two independent users. A unique nearest timestamp is a heuristic association, not proof of the hidden input note. Zero candidates within a short window does not prove unlinkability. These results establish a concentrated single-operator baseline, **not effective anonymity**. The run's two note outputs are left `unclassified`; this does not mean two real customers or automated cover traffic.

## Reproduce from the published dataset

From Core, with Node.js 22.16+ and installed dependencies:

```bash
npm ci
npm run privacy:baseline -- \
  docs/evidence/privacy-native-observations-2026-11-14.json \
  3a06a382ba8ee8360d5b43aece4eda8197f7f3f972c0ec7db541ac5888afb58b \
  /tmp/new-privacy-baseline.json
```

The SHA-256 pins the exact observation file. Establish its source authenticity separately. Offline measurement validates structure, domain, accounting and chronology but makes no RPC request and keeps `chainReverifiedByAnalyzer: false`. `inputSha256` describes canonical parsed observations; `observationFileSha256` describes the original file bytes.

To re-collect the original native testnet run through its reviewed public RPC:

```bash
npm run privacy:baseline-wallet -- \
  docs/evidence/testnet-wallet-2026-11-14.json \
  e009bd0f600b23e0fabe30064ee3211446682946126d1b341aace34b5981a681 \
  /tmp/new-public-observations.json /tmp/new-public-baseline.json
```

The native collector is deliberately specific to the recorded two-note native qualification. It does not label the native policy as USDC or accept an arbitrary FT history as that run. Original deployment source revisions and development-SRS limits remain those in the native evidence. A separate `chainVerification` section records live receipt/snapshot checks; it does not upgrade the analyzer's identity/anonymity claims.

Both commands require new output paths and create outputs with mode 0600. The live collector reserves both paths before requests; failed collection writes explicit failure artifacts rather than a successful report. Inputs/responses are bounded. No private notes, witnesses, passwords, keys or legal identity records are needed or accepted in the dataset.

## Input and coverage

`core-privacy-observations-v1` contains one trusted `policy`, one finalized `snapshot`, `totalRecordCount`, bounded `records`, optional `controllers`, optional `fundingEdges` and configurable `windowsSeconds` (defaults 60, 300, 3,600 and 86,400; at most eight windows, each at most seven days).

A row wraps the existing public `ChainRecord` as `{record, transaction, traffic}`. `transaction` is `{hash, signer}` or `null`; `traffic` is `unclassified` or `declared-synthetic`. Indexer records already contain timestamp, amount, vault and lifecycle fields; use only a verified transaction attribution from provenance, or leave it unknown. Core validates the shared-record shape/fees, asset and fixed denomination. Never combine different registries, networks, tokens or denominations into one candidate set.

Duplicate indices, commitments, spend requests, inconsistent payout recovery bindings, invalid chronology/future heights, invalid amounts, duplicate windows and unknown/private fields fail closed. Partial data is allowed with explicit coverage/missing-attribution/orphan-lifecycle counters. A claimed complete journal cannot contain a lifecycle record before its original request. Candidate counts in partial data describe only the supplied subset and may omit real alternatives or correlations.

The source's record count and attribution are declarations in an offline dataset. File integrity alone does not authenticate them. The native live adapter independently checks its recorded chain source and every journal receipt.

## Participation and funding metrics

- **Public signer counts:** distinct known deposit and original-withdrawal transaction signers. These are accounts, not independent people, note holders or customers. Missing attributions remain explicit.
- **Declared controllers:** optional `{account, controller, basis: "operator-declaration"}` labels. The total controller count is reported only when every deposit's signer is attributed and mapped. Conflicting labels fail; declarations never verify independence. The native fixture's operator declares control of its payer.
- **Direct deposit-source concentration:** principal-weighted distribution by public deposit signer, excluding fees and internal transfers. This classifies by transaction signer, which can be a relayer/custodian rather than the economic owner, especially for FT or contract-mediated calls. Unknown principal is reported separately. If attribution is partial, the distribution covers only known principal; it must not be presented as total-history concentration.
- **Upstream funding:** optional observed edges `{transaction, from, to, amount, assetTokenId, blockHeight, timestampNs}`. Aggregate repeated same-transaction/from/to transfers into one edge before import. Only same-asset funding preceding an observed deposit by its destination is included. This input supports direct signer-origin edges (`transaction.signer == from`); contract-mediated funding needs separately established provenance and must not be relabelled as direct funding. Shared sources are association signals; a common exchange or faucet is not proof of common control. The collector does not silently invent upstream history.

For known principal/source weights `a_i`, `p_i = a_i / sum(a_i)`. Reports contain largest share, **HHI = sum(p_i²)**, **inverse HHI = 1 / HHI**, and **entropy = -sum(p_i log2(p_i))**. Monetary totals remain exact integer strings; descriptive floating metrics are rounded to twelve decimal places. Empty distributions return `null`. These describe source diversity, not the protocol's effective anonymity or a probability that a user is identified.

## Time and amount linkability

Each original `withdrawal_requested` is analyzed once. Retries, failed callbacks and completion update its lifecycle rather than multiplying the sample. Eligible candidates are earlier public deposit **and internal-transfer outputs** within the same proof domain and fixed principal amount. Future outputs are excluded. Public nullifiers do not identify which commitment was spent, so the tool does **not** subtract a particular prior output after a withdrawal.

For each request, the report gives historical candidate count, deposit/transfer breakdown, counts within each inclusive time window, nearest-prior time lag/ties, and same-public-signer counts. Unknown withdrawal signers yield `null` for signer-conditioned metrics. Each window separately reports zero/singleton/multiple-candidate requests and the singleton fraction; no inverse-count guess is claimed as a calibrated attack probability.

A parallel declared-label scenario excludes outputs explicitly marked synthetic. This is an experiment under knowledge of those labels, not a claim that outside observers can always recognize synthetic traffic. Artificial activity is never reported as verified customers or independent participants. Existing metadata such as recipients, external funding, wallet/network traffic and disclosure references may reveal additional links not quantified by this baseline.

The method is motivated by empirical studies of usage-pattern heuristics, including [Kappos et al.'s Zcash analysis](https://www.usenix.org/conference/usenixsecurity18/presentation/kappos). [Loopix](https://www.usenix.org/conference/usenixsecurity17/technical-sessions/presentation/piotrowska) studies cover traffic and delays in a network-mixing model; its results do not validate this on-chain baseline or prescribe protocol privacy guarantees.

## Validation

Core type checking and **535 tests** passed, including fifteen focused cases for source weighting/common declarations, unknown attribution, time boundaries/ties, internal transfers, lifecycle deduplication, synthetic labels, upstream funding, missing history and invalid/cross-domain data. The live native collector reverified fourteen signed FINAL transactions and all eight immutable journal records. Offline reproduction produced the same metrics as the RPC-backed report. CLI smoke checks passed hash, symlink and overwrite refusal, explicit partial-collection failure artifacts and mode 0600 on generated outputs. SDK/browser vendoring remains unchanged. No additional on-chain transactions were sent by this measurement task.

## Separate bounded cover experiment

The [cover experiment](COVER_TRAFFIC.md) adds an opt-in testnet signer and before/after comparison. It records artificial traffic separately from participation, explicitly labels controlled probes, and rejects changed baseline attribution or uncontrolled concurrent traffic. Its four new transactions and sixteen-row after snapshot do not replace the original eight-row baseline above. Older unknown attribution remains unknown, and later outputs do not change historical withdrawal observations.
