# Conversation attachments

This increment extends the inbox in [013 Inbox](013-inbox.md) with original input files. DeepSeek Harness
remains responsible for native attachment objects, image normalization, model message images and scoped subprocesses.
The operator selects files, waits for upload completion, then explicitly starts a task or sends a reply. Uploading alone
never dispatches work. Conversation messages retain the exact input names, digests and upload identities with authenticated
downloads and optional image previews.

## Storage and authority

`Attachments` stores original bytes as SHA256-checked SQLite chunks in the coordinator Store. The existing checkpoint
therefore includes source content without relying on coordinator-local attachment paths. Begin, chunk and finish operations
retain request identity; an identical retry resumes or returns its original result, and conflicting metadata/bytes fail.
Finish verifies every chunk and the complete source, streams through Harness `saveFileStream`, then reads the native object
back and verifies its exact bytes. Native attachment IDs are opaque; their spelling is not used as a content digest.
Recognized images also pass Harness image validation and normalization.

The ordinary inbox transaction binds ready uploads to the exact original input or reply. A failed dispatch rolls back that
binding. An ambiguous Send retry retains the original request, message, attachments and revision. Bound inputs cannot be
cancelled. Worker access requires an active task, current Runtime ownership, its allowed execution environment and an
explicit binding to that task. Uploaded names/content remain untrusted data and do not widen execution authority.

`workspace_attachments` lists task inputs; `workspace_attachment_read` returns bounded UTF-8 text, base64 or a native image
reference. Image reads check the selected provider/model's actual input modalities and refuse text-only routes. The normal
Harness tool renderer creates the image message. Before installing resumed Sessions, Runtime reconstructs bound native
image objects from their checkpoint-contained sources and checks the original normalized reference exactly. A changed
normalizer fails closed; use the matching backend for histories containing those references.

`workspace_attachment_copy` copies any file type into the worker's already-bound execution directory through its existing
Harness subprocess service. Both persona write and command capabilities are required. The actual mounted preset service is resolved explicitly and its
execution binding must match the task; an unavailable remote service cannot fall back to local execution. Fixed Node code receives bounded
chunks, verifies each digest and the final source, resumes matching partial writes, rejects links and conflicting files,
and publishes using create-if-absent linking. It checks file identity around publication and handles the link-before-cleanup
crash window. Remote copies use the existing owned process receipts and confinement boundary; no coordinator host path is
sent to workers. Node must be available in that execution environment; remote endpoints require it under their mounted
system runtime paths. The serialized helper receives the child process’s CommonJS loader explicitly, avoiding capture of a
bundler-local require helper. The resulting file is a task-owned working copy;
its initial read-only mode is not an immutable-storage guarantee. The original Store bytes remain authoritative.

## Limits and lifecycle

A file is limited to 64 MiB; one chunk to 256 KiB; a message to eight files and 128 MiB combined. Pending unbound selections
are limited to 64 and 256 MiB of declared bytes, including ready-but-unsent files. They expire after 24 hours on admission,
selection or status activity. Native Harness image limits also apply. Text/base64 reads return at most 48 KiB of source
bytes and a continuation offset; UTF-8 pagination preserves characters across boundaries.

Cancellation deletes unbound SQL source chunks and prevents a pending native write from becoming ready. Interrupted
uploads can resume with their original identity while retained. Native immutable objects may remain cached after a cancel;
reference-aware native-store garbage collection is not implemented. Bound-history content has no automatic retention quota
or deletion workflow in this increment; operators must account for Store, checkpoint and native-cache disk growth.

The browser hashes/uploads one file at a time, retains files for retry, blocks Send until all selections are ready, and
cancels selections on removal/navigation. Downloads use attachment disposition and octet-stream content; previews use only
native-normalized images. Both require the existing loopback same-origin management header, use no-store/nosniff, and never
render uploaded HTML. Preview URLs are revoked on replacement/unmount. Existing text-only behavior remains available when
the Harness attachment service is absent.

## Evidence and remaining acceptance

The service tests cover replay, conflicting bytes, dispatch rollback, exact reply binding, cross-task denial, stopped-task
revocation, UTF-8 boundaries, binary copies, partial-write/crash recovery, link refusal and staging substitution. Real
`dsh-attachment-local` tests exercise image validation and exact image reconstruction in a fresh native store; an API double
is used only for separate contract tests. Actual HTTP tests cover streamed bytes, headers, cross-origin refusal and source
corruption. DOM tests cover lost chunk/finish/Send responses, cancellation with delayed acceptance, selection limits and
preview cleanup. Native Linux runs additionally exercise the copy through the remote endpoint and bubblewrap.

`DSH_ATTACHMENT_QUALIFICATION=1` extends the existing opt-in installed-Harness drill. A real model requests inputs, receives
a CSV and image through an idempotent inbox reply, copies the CSV through an owned remote subprocess, verifies its sum,
and produces the existing checked artifact. Downloads/previews/history are checked before and after deletion of the private
native cache, Runtime restart, and installed checkpoint recovery. The selected DeepSeek Flash route is text-only; this drill
does not claim model vision acceptance. The macOS composition fixture maps a synthetic system Node path to the existing
Homebrew Node without changing the host or production endpoint policy. Actual OS confinement is qualified separately on Linux. The final local `pnpm check` passed typechecking, all six builds and 1,981 tests (16 skipped) in 127.59 seconds
for the test phase. The installed Harness / DeepSeek Flash owned-managed drill passed at revision
`ba44a813777991f59a9b8e355dd7827b0dc8f949`: one passed, four skipped, 253.21 seconds. It exercised actual remote CSV
copy/processing, checked artifact delivery, duplicate input/reply receipts, deleted native caches, restart, original-state
retirement and installed checkpoint recovery with original input history/downloads/previews. The same revision passed native Linux / Node 24 typechecking, all six builds and 1,989 tests (10 skipped;
284.29 seconds) in [run 42707238123](https://github.com/jonsutton86/dsh-superagent-prototype/actions/runs/42707238123).
The integration fixes also passed 26 focused local tests, repeated typechecking/builds and an actual byte-copy execution of
the helper extracted from the production bundle. The attachment model-tool surface has a
separate 2,200-character ceiling; the existing orchestration, library and check ceilings are unchanged.

Real browser file-picker/download acceptance, vision-provider qualification, PDF/office extraction quality, very large file
stress, storage retention/GC and cross-machine deployment remain open. The full article/product architecture remains the
objective; this increment does not declare it complete.

Qualification development exposed and corrected the Agent-context subprocess injection assumption and the bundled-helper
loader capture. The live fixture was also corrected to wait for the inbox’s human-question state, finalize uploads with POST,
and include its synthetic input files in the PR tree checked against the full captured workspace. No production verification
precondition was weakened. One intermediate native run hit an existing recovery-audit timeout; a subsequent unchanged suite
passed all 1,989 tests without weakening its assertions. The final exact-revision run above passed those same assertions. The original running application was not restarted.
