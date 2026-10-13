# R1 native assessor-B container (stock omp 18.9.2): security review (13 Oct 2026)

AI static review by the `reviewer` agent (`openai-codex/gpt-6.1-sol`). Not a human review. The reviewer did not authenticate the image contents or observe runtime behaviour.

## Reviewed artifacts

- **Image:** `stadtstack-omp-b:review`, built at `49ff6a0` with `scripts/build-omp-b-image.sh`.
  - imageId `sha256:91c2c2c451fbc0273b97d25523bab3308b7077edca33efaaf26af923209711df`
  - omp binary `647237242329897c3a7c0f3591fdd9cafe4a4e13872baa9bbdfe45b84f9d8992` (`omp/18.9.2`)
  - settings `a6211ded7fb160dccb61e0f27dd80ab7e2a31c747e6661f54f4841c13f22ae0a`
  - Docker daemon `1ab1306d-8f9b-4eaa-9c3a-599dc2697c1f`
- **Code:**
  - `docker/omp-b/{Dockerfile,settings.yml,entry.sh}`
  - `src/district-omp-b-runner.ts`
  - the `omp-b` profile in `civic-docker.ts` / `civic-opt-out.ts`
  - the broker's native-result acceptance path

## Verdict

No P0–P3 findings. The image is **conditionally eligible** for authorization once the owner's #74 conditions hold. Those conditions are: subscription usage only, no extra usage, and usage-limit errors hold. The root-owned `/etc/stadtstack/omp-b-review.json` must also pin the image, host binary, runner contract, local socket and daemon.

## Disclosed limits

The authorization must not claim any of the following.

- **The bearer is in the child environment.** `entry.sh:3–7` reads the first stdin line and exports `ANTHROPIC_OAUTH_TOKEN` for omp's lifetime. The parent wipes its token and output buffers and keeps the bearer out of the Docker configuration, argv and persisted receipts. Zeroing of the child's memory is not verified.
- **Networking is not limited to the provider.** The container uses ordinary bridge networking, so it can reach whatever the host's routing and firewall allow.
- **Stock behaviour remains.** Provider retries, generated prompt wrappers, model-catalog requests and private tmpfs logs/databases still happen despite the settings and the no-tools/extensions/MCP/skills/rules flags.
- **The upstream model identity is not independently attested.** `message.model` echoes omp's catalog ID.
- **Recovery after an abrupt crash is not immediate.** A crashed worker needs the existing explicit operator recovery; teardown is not guaranteed to happen at once.

## Controls confirmed (static)

- **Container isolation** (`civic-docker.ts:55–65`):
  - non-root, read-only root filesystem, private tmpfs;
  - exactly one read-only control bind mount;
  - all capabilities dropped and Docker logging disabled;
  - no owner home, repository, SSH material, credential store or Docker socket mounted;
  - no API-key or auth-broker environment.
- **Output acceptance:**
  - input, output, stderr and run time are bounded;
  - a successful exit and newline-delimited JSON are required;
  - the runner rejects unsupported events, tool use, extra starts or turns, inconsistent response copies, non-stop outcomes and a wrong provider/API/model;
  - the result must satisfy the strict assessment schema.
- **Lifecycle:**
  - resources are registered durably before creation;
  - removal is confirmed before scratch deletion;
  - uncertain resources stay as partial leases and execution holds.
