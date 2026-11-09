# 035 Destination Session verification

An authenticated Session archive does not prove that the destination Harness backend contains the same history.
[Held receipt preparation](031-recovery-receipt-preparation.md) now requires that proof from the actual
`SessionPersistence` service selected by the maintenance profile. All existing receipt, ownership and
[execution configuration](034-execution-configuration-recovery.md) checks remain required. Both recovery holds remain in force.

## Selecting and importing the destination

Stop the coordinator and its watchdog before maintenance. Use [checkpoint import](023-checkpoint-recovery.md) to restore
the authenticated logical Sessions, then configure `prepare-receipts` with the same destination backend. For JSONL, the
maintenance patch selects that backend's destination root:

```yaml
- id: session-persistence-jsonl
  config:
    root: /private/restores/selected-sessions
    compression: none
```

The remaining `prepare-receipts` configuration is documented in the receipt-preparation design. The maintenance plugin
injects `ctx.sessionPersistence`; the exported `prepareCheckpointReceipts` helper now requires `persistence` explicitly.
Neither a caller-supplied backend name nor the archived files stand in for this service. The implementation uses public
Harness methods and makes no assumption about JSONL filenames, a local filesystem or physical event serialization.
Alternative backends still need qualification against the same Harness storage contract.

## Exact logical history under writer ownership

Preparation validates every complete authenticated Session archive before claiming destination writers. It lists the
destination and requires every checkpoint Session with the original immutable header, including parent, creation time,
working directory, agent preset and delegation depth. The Harness-defined absent delegation depth is equivalent to zero.
An additional child of any selected Session is refused. Independent unrelated Sessions can remain in a shared backend.

It opens every selected Session with exclusive write access in deterministic order before comparing any destination event.
The writer handles remain held throughout receipt reconciliation, private file checks, image signing and publication.
This excludes another conforming writer from appending to those Sessions while the result is prepared. The helper never
calls `create` or `append`, changes a header, truncates a log or repairs a short prefix. Opening and closing writer handles
still performs the storage backend's normal ownership and durability bookkeeping.

Comparison checks the exact inherited-event boundary and streams logical events in batches of at most 128. Every event
is validated through Harness's registered vocabulary and contiguous sequence contract. Backend reads can return smaller
pages. Logical values are compared deeply, so JSON property order does not create false divergence. A missing, shorter,
divergent or newer destination history is refused; the latter cannot be silently rolled back to the checkpoint.
Archive bytes and offsets are revalidated during comparison as well as before claiming writers.

The destination catalog is checked again after comparison and immediately before image publication. A newly visible related
Session or changed service instance aborts preparation. Writer handles are released on success, failure and cancellation;
partial acquisition releases earlier claims. The source stays held, and ordinary failures remove the unpublished image.

## Evidence scope and retries

New signed images include `sessionBackend: { sessions, events }`, recording only the number of verified Sessions and events.
No event content, backend path or credentials are included in that summary. The checkpoint digest already binds the selected
Session identities and history. The optional appended field preserves authentication of older images; an absent field
provides no destination-backend evidence.

An original-ID retry authenticates and returns the original published image. It does not silently perform a new validation,
even when a backend or external resource has changed since preparation. An unfinished attempt can retry the same intent
after the destination has been correctly imported, subject to all original audit and authority checks.

Harness exposes per-Session writer ownership, not a global catalog lock or a durable backend identity portable across hosts.
Another actor may create a related Session after the final catalog read, and history can change after the handles are
released. This is point-in-time held preparation evidence, not a reusable activation permit. A future activation operation
must freshly verify its actual configured backend and solve the coordinated handoff to live Session ownership. It must also
validate runtime/account configuration, authoritative input/state reconciliation and any explicit path remapping.

## Acceptance and remaining work

Real JSONL tests cover a separate imported backend, absent and zero delegation depth, bounded partial pages, inherited fork
history, missing/short/divergent/newer histories, immutable metadata changes, extra related Sessions, competing writers,
service replacement, corrupted archives and cancellation. Preparation integration tests check that a Session writer remains
claimed during receipt application, reject a descendant created during preparation, preserve source holds and return original
historical evidence on retry. The installed-Harness qualification selects the imported destination for preparation and checks
the signed Session/event counts through the actual maintenance plugin and installed event catalog.

This increment does not complete clean-host activation, authoritative input/state reconciliation, broader private runtime
and account configuration, remapping, failover drills or the full article and Agentic OS requirements.

Code `915cfc28f6b2ca10425a185376f85ae3d3c6b4e0` passed 1,562 local tests (seven skipped), typechecking and all four
builds. The focused recovery run passed 108 tests; the complete run also includes the older-manifest authentication case.
The two tests that retain unrelated durable Sessions passed separately after their empty fixtures were explicitly flushed.

Both owned installed-Harness / DeepSeek Flash scenarios passed in 192.86 seconds. The managed scenario imported into a
separate destination backend, prepared through that backend, verified the signed Session/event counts and authenticated an
original-ID retry. The dedicated scenario retained its expected refusal for intentionally unrecorded publication probes.
Provider-message traffic used local contract servers; inference used the configured model API.

The same code passed 1,564 tests with native Linux confinement (five skipped), typechecking and all builds in
[run 42562981301](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42562981301). The original app
remained running. These checks qualify destination verification during held preparation, not restored activation or a
cross-host catalog lock.
