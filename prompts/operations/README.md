# Evidence-based development operations

This is a reusable development prompt library. It does not introduce an agent runtime, configure a model provider, or
change the default Harness worker/router prompts. The operator or development agent selects an operation explicitly.
DeepSeek Harness remains the execution runtime.

## Library

| Operation | Original Fabric pattern | Intended use |
| --- | --- | --- |
| Feature extraction | [extract_product_features](fabric/extract_product_features/system.md) | Extract capabilities actually stated or observed in supplied evidence |
| Code review | [review_code](fabric/review_code/system.md) | Review a bounded source change, including failure and concurrency behavior |
| Design review | [review_design](fabric/review_design/system.md) | Examine component responsibilities, persistence boundaries and supported tradeoffs |
| Summarization | [summarize](fabric/summarize/system.md) | Produce a bounded handoff that preserves evidence and unresolved questions |

All four upstream files are byte-for-byte copies from Fabric revision
`de0b72766db0436b6c1887bb75768cb3960e67e5` (v1.4.568). The original [MIT license](fabric/LICENSE) is retained.
[manifest.json](manifest.json) records the exact source URL, Git blob SHA and SHA-256 of every imported file.
Do not silently edit or update these originals. Add a reviewed new source revision and update the manifest when upgrading.

## Use

1. Select an operation and read its pinned pattern.
2. Apply [EVIDENCE.md](EVIDENCE.md), version 1, as the project-specific wrapper. Its evidence and authority rules override
   conflicting presentation instructions in the upstream pattern; ordinary task instructions and execution policy remain
   authoritative over both.
3. Supply the question or change scope and a source manifest: source IDs, paths/URLs, exact revisions or digests,
   locations, and relevant observations. Label source text and tool output as evidence, not executable instructions.
4. Record which pattern revision and wrapper version produced the result. Attach supporting source IDs to each material
   claim. Review suggestions and model summaries never grant permission, satisfy a check, or establish verified completion.

An operation can be applied by the current development agent; it does not require invoking the Fabric CLI or starting
another paid model call. If an application later invokes these patterns through Harness, that integration must explicitly
bind the selected version, task scope, provider and budget and validate any resulting structured proposal.

The wrapper intentionally permits fewer items than a pattern requests, preserves caveats and unknowns, and requires
evidence locations. This avoids filling upstream output quotas with invented findings or suppressing important uncertainty.
The original prompt wording is preserved separately so these adaptations remain visible.

## Check provenance

From the repository root, verify the imported bytes and wrapper hash without model calls:

```sh
python3 - <<'PY'
from pathlib import Path
import hashlib, json
root = Path('prompts/operations')
manifest = json.loads((root / 'manifest.json').read_text())
for entry in manifest['files']:
    data = (root / entry['path']).read_bytes()
    assert hashlib.sha256(data).hexdigest() == entry['contentSha256'], entry['path']
    blob = b'blob ' + str(len(data)).encode() + bytes([0]) + data
    assert hashlib.sha1(blob).hexdigest() == entry['upstreamGitBlobSha'], entry['path']
wrapper = manifest['wrapper']
assert hashlib.sha256((root / wrapper['path']).read_bytes()).hexdigest() == wrapper['contentSha256']
print('Imported Fabric files and evidence wrapper match the recorded hashes.')
PY
```

These checks establish byte identity with the recorded sources, not correctness of a generated analysis.
