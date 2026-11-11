# 084 Operator tooling

These host tools extend the coordinator and worker sessions. A prompt cannot grant them, and they do not change accounts,
credentials, or the worker command shims.

## Operator messages

A message typed into the coordinator session, including a file the operator attaches there, is stored as its own trigger
before the model turn reads it. The id is derived from the message id. Read `triggers` and pass that id to
`orchestrator_route`. An id that was never stored, including one guessed from the chat position, is `Unknown trigger`.

The actor is the local operator. The message is explicit and addressed, so accept works without adding the operator to a
source allow-list. Host relays are not triggers. Each message has its own thread, so a later message is not a follow-up
on the first ticket.

## Repository profile

In local execution, `orchestrator_read` `repository/file/<path>` and `repository/directory/<path>` read the checkout in
the `repository` source. An empty path lists the checkout root. Set it from the panel or the management API:

```json
{ "enabled": true, "config": { "root": "/absolute/checkout", "repository": "owner/name", "branch": "main" } }
```

`root` is the local clone. Reads stay inside it, skip hidden names and `node_modules`, and stop at 64 KiB. The response
is untrusted context. When a GitHub source is configured, the same resources keep using that repository's API. With
neither a GitHub source nor `root`, the read says GitHub is unavailable in local execution mode and to use a repository
profile.

## Public fetch

Workers have `orchestrator_fetch`. It sends one `GET` to an https URL that is either a prefix in the operator source
`fetchAllowlist` or the exact URL written in an operator trigger. Redirects that leave those URLs are refused. The body
is text, at most 256 KiB, with a 15 second limit. No credentials are sent. While a GitHub source is configured the tool
refuses and repository reads are used instead.

## Attachment files

`orchestrator_file_read` reads a file whose path was saved with the operator trigger, or any text file inside the ticket
directory, up to 64 KiB. Before the worker session starts, those attachment bytes are copied into
`<ticket>/attachments` when that name is free, so the filesystem provider and the subprocess provider see the same
bytes. The copy does not replace a file already there. The coordinator does not get this tool or a general write tool.

## Prepare

`settings/executor.prepare` runs before a worker assignment when the ticket directory is absent, in local mode and in
repository mode. Its `PATH` starts with the worker shims, so a name in `blockedCommands` fails inside the command. A
useful command fails on its own when clone or checkout fails:

```sh
git clone --branch main https://github.com/jonsutton86/rea.git "$DSH_SUPERAGENT_DIR"
```

Do not append `|| true` or hide stderr. If the command leaves files, the directory stays and later assignments do not
run the command again. If it leaves the directory empty, that directory is removed and the next assignment runs the
command again.
