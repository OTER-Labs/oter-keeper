# oter-keeper

`oter-keeper` keeps OTER's public calls moving. It finds work from the Radix Gateway, builds a
transaction for it, previews that transaction, and submits it only when you have turned live
submission on and every spending limit allows it. It also checks the tallies the platform
asserts and reports a document that does not verify. Disputes are off by default.

Anyone with Node and a funded Radix account can run it. Use your own account and your own key.

## What it never does

- It does not take custody of anything beyond the key you give it. The key stays in memory and is
  never logged, written, or sent anywhere.
- It never submits a transaction while `live_submit = false`, which is the default.
- It reads only the Radix Gateway, plus the platform API that publishes tally documents.
- It never moves another account's assets. Every transaction is paid for and signed by the
  configured account.
- It never forces a transaction whose preview the network refused.

## Install

`package.json` requires Node 20 or later.

```sh
npm install
npm run build
```

The build writes `dist/`. To run the built command directly:

```sh
node dist/src/cli.js check --config keeper.toml
```

`npm link` installs the `oter-keeper` command from the `bin` entry.

To run from source without building, use Node 22.6 or later and its TypeScript stripping flag:

```sh
node --experimental-strip-types src/cli.ts check --config keeper.toml
```

Run the tests with `npm test` and the type check with `npm run typecheck`.

## The key

The keeper needs an Ed25519 private key as 32 bytes of hex, with or without a `0x` prefix. One of
`key_file` or `key_env` must be set, and not both.

A key file:

```sh
openssl rand -hex 32 > key.hex
chmod 600 key.hex
```

`key_file` may be relative. The keeper resolves it against the directory holding the config file,
so a keeper started from cron finds the same key as one started in your checkout.

To keep the key outside the config file, name an environment variable instead:

```toml
key_env = "OTER_KEEPER_KEY"
```

The variable must hold 64 hex characters. The keeper prints the account address and the key
source, never the key itself. A key that is missing or malformed is refused with a message that
does not echo its value.

The repository's `.gitignore` covers `key.hex` and `*.key`.

## Configuration

The keeper reads one TOML file, `keeper.toml` by default. This example sets every key and shows
the defaults in comments. Values for `network`, `account`, one key source, and the three fee
settings are required.

```toml
network = "stokenet"                  # "stokenet" or "mainnet"
dapp_definition = "account_tdx_2_..." # required unless [components] is present
account = "account_tdx_2_..."         # the fee payer and signer
key_file = "key.hex"                  # or key_env, exactly one
# key_env = "OTER_KEEPER_KEY"

# gateways = ["https://stokenet.radixdlt.com"] # default for the network; up to four
live_submit = false                            # default
max_fee_xrd_per_tx = 0.1
max_fee_xrd_per_day = 1.0
reserve_floor_xrd = 10.0

# [components]              # optional; when present, discovery is off
# oracle = "component_tdx_2_..."
# registry = "component_tdx_2_..."
# consultation_identifier = "component_tdx_2_..."
# election_identifier = "component_tdx_2_..."
# hub = "component_tdx_2_..."
# grant_escrow = "component_tdx_2_..."
# space_treasuries = ["component_tdx_2_..."]
# distributions = ["component_tdx_2_..."]

[jobs.finalize]
enabled = true          # default
interval_secs = 60      # default

[jobs.open_reveal]
enabled = true
interval_secs = 60

[jobs.open_vote]
enabled = true
interval_secs = 60

[jobs.burn_seat]
enabled = true
interval_secs = 60

[jobs.settle]
enabled = true
interval_secs = 60

[jobs.redeem_own_bonds]
enabled = true
interval_secs = 60

[jobs.dispute]
enabled = false         # default; this flag gates bond spending only
interval_secs = 300     # default
max_bond = 5
max_bonds_per_day = 2
# tally_api = "https://api.example.org" # the platform API that publishes tally documents
```

A `[jobs.<name>]` table accepts `enabled` and `interval_secs`. A job not named in the file is
enabled by default, except `dispute`, and uses the default interval for its kind. The dispute job
requires `max_bond` and `max_bonds_per_day` when its table is present. Without `tally_api` the
watcher cannot fetch documents, so it reports that it cannot check tallies.

### Components: discovery or an explicit table

When `[components]` is absent, `dapp_definition` is required. The keeper reads that account's
`claimed_entities` metadata, asks the Gateway for each entity's blueprint name, and uses the
entities it recognizes. A redeploy updates the ledger, so nobody's config goes stale.

When `[components]` is present, discovery is off and `dapp_definition` is optional. The keeper
checks each address's blueprint before using it and refuses a table key it does not know. The
table names at most one oracle, registry, consultation identifier, election identifier, hub, and
grant escrow, plus lists of space treasuries and distributions.

## Commands

```text
oter-keeper <run|once|check> [--config keeper.toml]
```

- `check` validates the config, reports the key source, discovers the components, reads today's
  figures from the Gateway when it is reachable, and prints what each job would do. It builds and
  signs nothing. It runs without a key and without a reachable Gateway.
- `once` runs every enabled job one time and exits. It is the cron form.
- `run` runs the enabled jobs on their intervals until it receives SIGINT or SIGTERM.
- `--config` or `-c` names the file. `--help` or `-h` prints the usage.

A first dry run:

```sh
node dist/src/cli.js check --config keeper.toml
node dist/src/cli.js once --config keeper.toml
```

Both print the dry-run state on the first line. With the default `live_submit = false`, `once`
previews each transaction and stops.

## What each job does

Work is found from each watched component's event stream and, where an event does not say
enough, from its state. Every transaction is previewed first. A refused preview is not an error:
it usually means another keeper did the work first, so the item is retried on a later pass.

A window closes only when its deadline has passed and the network's epoch has reached the
window's minimum epoch. The keeper applies both conditions before it acts on a window.

| Job | When it acts | Public call | Cost |
|---|---|---|---|
| `finalize` | A request's dispute or reveal window has closed | oracle `finalize_request` | network fee |
| `open_reveal` | A round has committed ballots past its reveal start and no reveal has opened | oracle `open_reveal_window` | network fee |
| `open_vote` | A delayed vote is past its start and has no recorded opening | registry `open_vote` | network fee |
| `burn_seat` | A seat is revoked or its term has ended and it has not been burned | registry `burn_seat` | network fee |
| `settle` | A distribution or grant meets its conditions | hub `settle_distribution`, `settle_grant`, `collect_grant_refunds`; distribution `return_unclaimed`; escrow `deliver_fallback` | network fee per call |
| `redeem_own_bonds` | The configured account holds a bond ticket | oracle `redeem_bond_ticket` | network fee |
| `dispute` | A tally assertion does not verify, disputes are on, and every bond limit allows it | identifier `dispute_resolution` or `dispute_election_result` | network fee plus the bond |

When the escrow refuses a grant delivery, `settle` falls back to `collect_grant_refunds` on the
space treasury. `redeem_own_bonds` looks only at tickets held by the configured account.

`check` output also lists an internal `noop` job. It never acts and costs nothing.

## Disputes and what they risk

The dispute watcher reads tally assertions from the consultation and election identifiers,
fetches the published tally document, and runs `radix-tally-verify` against the document's
snapshot at the configured Gateway.

- MATCH: the document matches the asserted hash. Nothing happens.
- MISMATCH: the document does not verify. The keeper reports it. If disputes are enabled, the
  bond is within `max_bond`, the daily count is below `max_bonds_per_day`, the account would stay
  above `reserve_floor_xrd`, and the window is still open, it posts a counter-claim with the
  bond.
- UNKNOWN, or a document that cannot be fetched or parsed: report only. The keeper never posts a
  bond on an incomplete verification or a missing document.

The bond comes from your account and is forfeited if the vote goes against the counter-claim.
Disputes are off by default. A bond is also skipped when the recomputed outcome equals the
on-ledger proposal, because the oracle refuses a counter-claim that agrees with it.

Mirror tallies of the official DAO are fetched from the platform's `/api/official` listing,
verified, and reported only. They have no on-ledger hash to dispute.

The keeper caches the last verified result for each official vote with a hash of the document
body. An unchanged document is not verified again. A MATCH is reported once. A MISMATCH or
UNKNOWN is repeated at most once per UTC day. A changed document is verified again.

## Limits

The keeper checks these before every submit:

- `max_fee_xrd_per_tx` caps the fee locked for one transaction.
- `max_fee_xrd_per_day` caps the day's total. The day is UTC.
- `reserve_floor_xrd` stops a submit that would leave the account below that balance.
- `max_bond` caps one dispute bond.
- `max_bonds_per_day` caps disputes posted in a UTC day.

At the start of `run` and `once`, the keeper reads the configured account's committed
transactions for the current UTC day from the Gateway. It counts only transactions whose fee the
account paid and whose manifest calls a keeper method. From that history it totals the XRD fees
paid and the disputes posted. For each figure it uses the larger of the history value and the
local value, and prints both once:

```text
fees today: local 0, ledger 0.5614281253, using 0.5614281253
disputes today: local 0, ledger 1, using 1
```

`check` prints the same figures without writing them to the state file.

A history read that fails is not fatal. The keeper logs a warning, keeps the local figures, and
makes disputes report-only for that run, because a bond must not be spent against a count that
cannot be checked. The read is paginated; hitting the page cap is treated as a failed read.

## State file

The keeper keeps `.oter-keeper/state.json` in the working directory. It holds:

- the event cursor for each watched emitter, so a restart does not re-read history;
- the day's fee total and dispute count, as recorded locally;
- the last verified result and document hash for each official vote.

Deleting the file is safe. Cursors start over, the fee and dispute figures are read back from
the account history at the next start, and mirror documents are verified again. A file that
cannot be parsed is refused rather than silently replaced.

Two keepers on one item are safe. Both may find the same work, and the loser's preview fails.
The keeper logs the refusal and retries on a later pass. That is "already done", not an error.

## Exit codes

- `0`: the command completed. `check` returns this even when no Gateway is reachable; `run`
  returns it when it stops on a signal; `once` returns it when no job reported a failure.
- `1`: a state file, Gateway, or unexpected error stopped the command, or `once` finished with at
  least one failed job.
- `2`: the command line was wrong, the command was unknown, or the config file was refused.

## License

Apache-2.0. See `LICENSE`.
