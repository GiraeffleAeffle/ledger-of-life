# R1 parser isolation: security re-review of the sentinel fixes (13 Oct 2026)

AI static review by the `reviewer` agent (`openai-codex/gpt-6.1-sol`), orchestrated by the R1 lead. Not a human review. No Docker, builds or tests were run by the reviewer; runtime evidence comes only from the sentinel runs recorded in `docs/R1_STATUS.md`.

Base: the whole-boundary review in [r1-parser-security-review-2026-10-12.md](r1-parser-security-review-2026-10-12.md) (no P0–P2 at `f14bb20`).

## Round 1 — uncommitted debug fixes on top of `2d58335`

Verdict: **NO**.

- **P2, crash cleanup regression:** the debug fix dropped `docker run --rm` from `parserContainerArgs`. That function is used only by the unenrolled source-free branch, so a crashed controller could strand probe containers outside `recover-scratch`. Real-source jobs still use the durable civic-docker lifecycle and were unaffected.
- **No finding** in the other changes:
  - `--disable-wasm-trap-handler`, with the 8 GiB `RLIMIT_AS` retained;
  - creation of the regional directory;
  - the content-free PDF cache temp name;
  - the PDF deadline move. The 15 s deadline now bounds each dispatched command. A `TimeoutError` becomes `unavailable/metadata_timeout`, only `checked` findings are cached, and unavailable policy never grants permission (`pdf-tdm-policy.ts:25–29, 54–76`; `source-policy.ts:146–149`).
- **Tests:** compared against `git show HEAD:<file>`. Every original assertion and attack input is preserved, including all 11 archive attacks, the 5 PDF-origin fixtures and the XML/reference/CDATA/DTD/code-point/cache regressions.

## Round 2 — `4cc08c3` (`--rm` restored; absence proof via `docker container inspect`)

Verdict: **NO**.

- **P2:** `fail()` SIGKILLs the attached Docker CLI on a timeout or failure. The cleanup treated any CLI exit as completed daemon removal and skipped `docker rm --force`. A worker could therefore still be running, and the immediate inspect would report `unavailable` instead of the original `TimeoutError`.

## Round 3 — `103abc5ef938816d4db03efe128eacec9db19412`

Verdict: **YES**, from the static source-security standpoint. No P0–P3 findings remain in the reviewed changes.

- Daemon-side removal is trusted only when the CLI exits within 10 s with code 0 and no signal.
- Every other outcome (timeout, signal, non-zero exit) gets a forced removal and then an independent absence proof.
- Unknown removal or inspection results fail closed.

Conditions attached to the YES:

- the actual immutable image ID and contract hash are bound;
- a privileged review file is installed;
- the runtime sentinel gates pass.

## Authorization installed

`/etc/stadtstack/parser-isolation-review.json` (root:root 0644, installed 2026-10-13T04:53:06Z):

| Field | Value |
| --- | --- |
| Image | `sha256:e60dd9b091c92033371ed3d0057e882f13f897926faa29dc5092534a25690e25` |
| Contract | `82e0f14017e93922392a247de987c38fffbad8ab3a3b4bfda72061dc9ceb32db` |
| Built from | `103abc5` |
| Label | `[final]`; reviewer named as an AI static review |
