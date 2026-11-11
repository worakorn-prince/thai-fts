Task: Audit and improve worakorn-prince/thai-fts with evidence-backed,
minimal patches.

Important:
Previous review did NOT successfully execute this repository.
The only verified runtime result was that Node v20.20.1 could not
load node:sqlite in the review environment.

Treat every repository-specific claim from the previous review as
unverified until confirmed in source or reproduced locally.
Do not assume filenames, APIs, benchmark figures, or missing features.

GOALS
1. Establish a reproducible baseline.
2. Detect index/query processing incompatibility where applicable.
3. Lock down strict/loose search semantics with regression tests.
4. Measure retrieval quality separately from performance.
5. Optimize only a measured bottleneck.

PHASE 0 — DISCOVERY AND BASELINE

Inspect:
- package.json, lockfiles, workspace configuration
- runtime requirements and CI configuration
- public exports and supported module formats
- normalization, segmentation, dictionaries, synonyms
- index creation, persistence, reopening and rebuilding
- strict/loose query generation and result merging
- existing tests and benchmarks

Use the package manager selected by the repository.
Use the declared supported Node version. Do not upgrade dependencies
or regenerate lockfiles unless required and justified.

Record:
- commit SHA
- Node and package manager versions
- OS/architecture
- SQLite version if exposed
- exact commands
- test counts, failures and skipped tests

Run existing tests before modifications.
If tests fail, distinguish pre-existing failures from new regressions.

Create a discovery report mapping every proposed change to actual
source files and existing behavior.

PATCH 1 — RUNTIME PREFLIGHT

Check whether a clear runtime capability check already exists.
If adequate, do not duplicate it.

Otherwise add a small reusable check for the local SQLite engine:
- node:sqlite can be loaded
- required SQLite interface is present
- an in-memory FTS5 table can be created and queried
- Thai segmentation is available if required by the selected engine

Requirements:
- Run checks only where relevant.
- Do not make a generic core import fail merely because an optional
  SQLite backend is unavailable.
- Follow repository conventions for error types and module loading.
- Close temporary database resources on success and failure.
- Report detected runtime, missing capability and actionable guidance.
- Do not hardcode a new minimum Node version without verifying the
  APIs actually used and the existing support policy.
- Test capability-failure paths without requiring an unsupported
  runtime for the entire test suite.

PATCH 2 — INDEX/QUERY CONFIGURATION COMPATIBILITY

First determine whether equivalent protection already exists.

If missing, design persisted metadata for settings that affect the
indexed representation and its compatibility with query processing.

Requirements:
- Separate index-affecting settings from query-only settings.
- Use deterministic serialization and an explicit metadata version.
- Preserve order where order affects behavior.
- Canonicalize only settings whose order is genuinely irrelevant.
- Do not use Function.toString() as a stable tokenizer identity.
- Require an explicit stable version/id for custom processors when
  automatic compatibility checking cannot be reliable.
- Do not treat a runtime version difference alone as proof of
  incompatibility unless a supported compatibility policy says so.
- Explain mismatch categories in errors; do not silently rebuild.

Legacy indexes without metadata:
- Never claim compatibility has been verified.
- Define and document a backward-compatible handling policy.
- Require explicit opt-in before any destructive migration.

Rebuild:
- Inspect existing transaction/atomic replacement behavior.
- Never mark new metadata active before a successful rebuild.
- Preserve or restore the previous usable index on failure where
  the backend can support this guarantee.
- Document weaker guarantees rather than pretending every adapter
  supports atomic rebuilds.

Tests:
- same effective configuration reopens successfully
- semantically equivalent configuration serializes consistently
- relevant configuration change is detected
- query-only setting does not cause unnecessary rebuild
- custom processor without stable identity is handled explicitly
- legacy database behavior
- failed rebuild does not publish successful new metadata

PATCH 3 — STRICT/LOOSE SEMANTIC REGRESSION SUITE

Inspect current semantics before modifying ranking or normalization.

Create isolated fixtures for:
- tone-distinct forms such as ปา / ป่า / ป้า
- exact matches and loose-only matches
- short Thai queries with combining marks
- Thai/English mixed text and punctuation
- multi-term queries with and without spaces
- documents matching both channels
- equal-score ordering
- insert/update/delete consistency
- empty and punctuation-only input
- quote characters and FTS query operators as user text

Test the documented contract:
- Strict search does not accidentally use loose normalization.
- Loose expansion does not produce duplicate document results.
- If exact-first ranking is promised, verify that promise.
- If exact-first is not promised, document the actual policy and
  propose an explicit option rather than silently changing behavior.
- Pagination remains stable under the documented ordering.
- Query analysis and indexing use compatible preprocessing.
- Plain text input cannot accidentally become advanced FTS syntax
  unless that behavior is explicitly part of the API.

For short-query fallback:
- Establish whether one exists.
- Establish what "length" means in current code.
- Test behavior for Thai combining marks and mixed scripts.
- Do not change UTF-16/code-point/grapheme semantics silently.
- Test literal % and _ handling if SQL LIKE is used.
- Keep all SQL values parameterized.

Avoid brittle assertions about segmentation boundaries that vary
across supported ICU versions. Where exact boundaries are essential,
use a controlled tokenizer fixture.

PATCH 4 — RETRIEVAL QUALITY BENCHMARK

Use existing benchmark infrastructure where possible.

Add version-controlled, deterministic Thai retrieval fixtures:
- document IDs and text
- queries
- relevant document IDs
- relevance grades where available
- category labels
- expected search mode
- provenance/license information for non-synthetic data

Separate:
A. deterministic correctness regression fixtures
B. labeled retrieval-quality evaluation
C. performance workloads

Do not present synthetic fixture scores as real-world accuracy.

Compare supported variants:
- minimal segmentation + FTS baseline
- strict mode
- loose/rescue mode
- optional preprocessing features only if they exist

Metrics:
- Precision@5
- Recall@20
- MRR@10
- nDCG@10 when graded labels are available
- zero-result rate
- rescue wins and added irrelevant results

Define denominators and edge cases explicitly:
- fewer than k returned results
- no relevant documents
- duplicate results
- queries excluded from a metric

Output machine-readable JSON or CSV plus a readable summary.
Preserve per-query results so aggregate regressions can be diagnosed.
Do not add strict millisecond thresholds to shared CI.

PATCH 5 — PERFORMANCE DIAGNOSIS, THEN TARGETED OPTIMIZATION

Do not implement an optimization until a repeatable bottleneck is found.

Use deterministic datasets with controlled:
- document length
- term distribution
- vocabulary size
- query distribution
- feature configuration

Measure:
- indexing throughput over successive batches
- search p50/p95/p99
- index size
- peak memory where measurable
- time spent in processing stages where instrumentation is feasible

Compare single-document writes and batching only if supported.
Separate warm-up, index build and query measurements.
Report repetition counts and environment details.

If a bottleneck is found:
- add a focused change
- retain identical semantics in regression tests
- publish before/after measurements on the same workload
- explain tradeoffs

Do not add unbounded caches.
Do not weaken durability, transaction guarantees or search semantics
to produce better benchmark numbers without explicit opt-in.

DELIVERY REQUIREMENTS

Prefer separate commits:
1. baseline/tests
2. runtime preflight, if needed
3. configuration compatibility, if needed
4. semantic regression coverage and justified fixes
5. quality benchmark
6. measured optimization, only if justified

For each commit report:
- actual files changed
- reproduced issue or verified missing guarantee
- implementation decision
- commands executed and results
- backward compatibility impact
- remaining limitations

Return:
- a reviewable diff
- tests and benchmark artifacts
- concise before/after report

Do not:
- fabricate benchmark results
- assume previously mentioned features exist
- rewrite unrelated modules
- add dependencies without explaining necessity
- silently change public API behavior
- claim production readiness from unit tests alone