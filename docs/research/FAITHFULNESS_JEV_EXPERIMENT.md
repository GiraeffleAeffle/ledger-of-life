# Faithfulness and Jev calibration

## Jev and the DeepEval modes

Jev is TypeSafe AI's hosted “System One” decision model. Unlike a text-generating LLM, it returns typed bounded decisions (such as yes/no probabilities, a choice, or a score); TypeSafe describes its training as reinforcement learning for calibrated decisions. In DeepEval `system_one`, Jev receives the raw test case in one request, makes the metric's bounded judgments, and DeepEval computes a weighted score and a reason from those answers. It does not call an LLM. In `hybrid`, the configured LLM extracts claims and writes the reason while Jev decides each claim; an LLM is still required. In `llm`, the configured LLM does extraction, decisions, and reason generation.

Jev is **not a local model**. DeepEval's TypeSafe model sends requests to TypeSafe's hosted `POST https://api.typesafe.ai/v1/systemone`; it downloads no Jev weights. The TypeSafe Python client is an SDK, not the model. The TypeSafe quickstart requires an account/API key (`TYPESAFE_API_KEY`). The public model page lists Jev 1.13.0 at $0.042 per million input tokens (outputs free), text input, and 64k request context (32k for state plus a question). TypeSafe's launch blog claims 70–500 ms service latency; this is vendor-reported, not a measurement from this experiment. Model-weight licensing is not published on the model page; the website terms say access to TypeSafe products/services is governed by a separate agreement. Do not treat Jev as open weights or use the website terms as a model-weight license. TypeSafe says inputs are not used for training; enterprise customers can request zero-data-retention terms. Jev's documentation says English is its primary language and asks users to test non-English use; this German calibration is therefore necessary.

## Setup and availability

Installed the newest DeepEval available from pip into the separate, ignored environment `stadtstack-data/cache/venv-jev`; it resolved to `deepeval 4.2.6`, which exposes `eval_mode` (`llm`, `hybrid`, `system_one`) and `penalize_ambiguous_claims`. Installed `typesafe-sdk 0.7.2` there as DeepEval's TypeSafe integration dependency. The existing `cache/venv` was not changed.

The experiment used `FaithfulnessMetric(threshold=0.8, async_mode=False, include_reason=True)` and the repository's current Codex/GPT-6 Luna custom judge for both LLM configurations. The only varied setting between those configurations is `penalize_ambiguous_claims=False/True`. Measurements use the same claim/context pairs and expected labels. A score of at least 0.8 is a pass. Each LLM measurement requires an LLM call; TypeSafe reports no cost for custom LLM providers whose price is unknown.

Jev configurations could not be measured here. `TYPESAFE_API_KEY` is unset in this environment. After installing the SDK, creating `FaithfulnessMetric(eval_mode="system_one")` fails immediately with DeepEval's explicit `TypeSafe AI API key is not configured` error. Creating `eval_mode="hybrid"` with the Codex custom model fails at initialization for the same missing TypeSafe key. No Jev request was sent. Per DeepEval's mode contract, hybrid would require both the Codex LLM and Jev; system_one would require Jev but no LLM. Jev scores, reasons, latency, and actual cost are therefore unavailable rather than inferred.

## Calibration cases

The contexts below are excerpts transcribed from cached source text, not synthetic evidence. Ordinance cases use `cache/budget-ordinance.txt`; council cases use the indicated cached page-one PDF text. Expected verdict means whether the full actual-output claim is supported by its supplied context.

| Case | Expected | Source | German actual output |
| --- | --- | --- | --- |
| Supported paraphrase | Pass | `budget-ordinance.txt` | Der Haushaltsplan der Stadt Strausberg sieht 2025 Investitionsauszahlungen in Höhe von 17.941.270 Euro vor. |
| Supported planned amount | Pass | `budget-ordinance.txt` | Für 2026 sind 12.609.320 Euro an Auszahlungen aus Investitionstätigkeit im Haushalt festgesetzt. |
| Swapped years | Fail | `budget-ordinance.txt` | Für 2025 sind 12.609.320 Euro an Auszahlungen aus Investitionstätigkeit im Haushalt festgesetzt. |
| Wrong amount | Fail | `budget-ordinance.txt` | Der Haushalt setzt 2025 Investitionsauszahlungen von 17.491.270 Euro fest. |
| Unsupported “already spent” | Fail | `budget-ordinance.txt` | Die Stadt hat die für 2025 geplanten 17.941.270 Euro bereits ausgegeben. |
| Plan stated as actual | Fail | `budget-ordinance.txt` | Strausberg gab 2025 genau 17.941.270 Euro für Investitionen aus. |
| Wrong committee | Fail | `pdf/0347ab78cdbde4a45940fd61.txt` (Münster) | Der Ausschuss für Soziales entscheidet am 30.09.2026 über die Zuschüsse. |
| Wrong date | Fail | `pdf/d416c45c6cc9fe27d2958571.txt` (Wuppertal) | Der Planungsbeirat BUGA entscheidet am 29.09.2026 über den Bürgerantrag. |
| Wrong place | Fail | `pdf/a631fcb6c8ff69937419254c.txt` (Köln/Chorweiler) | Der Änderungsantrag sieht 37.500 Euro für das Stadtklimaprogramm im Stadtbezirk Nippes vor. |
| Partially supported, extra invented project | Fail | `budget-ordinance.txt` | Für 2025 sind 17.941.270 Euro für Investitionsauszahlungen vorgesehen, darunter der Bau einer neuen Feuerwache. |
| Vague but true | Pass | `pdf/0347ab78cdbde4a45940fd61.txt` (Münster) | Die Vorlage behandelt Zuschüsse für Projekte und Veranstaltungen. |
| Invented next step | Fail | `pdf/d416c45c6cc9fe27d2958571.txt` (Wuppertal) | Nach der Ablehnung startet die Stadt am 1. Oktober 2026 mit dem Aufbau der Informationsseite zur BUGA 2031. |

## Results

`Pass` means score `>= 0.8`; accuracy compares that threshold result with the expected label. All 24 measured rows needed the current Codex LLM judge. The reason column concisely summarizes DeepEval's returned reason.

| Case | Configuration | Expected | Score / result | Runtime | LLM call needed? | Reason |
| --- | --- | --- | --- | ---: | --- | --- |
| Supported paraphrase | `llm` | Pass | 1.0 / pass | 29.85s | Yes | No contradictions were provided; the output is consistent with the retrieval context. |
| Supported planned amount | `llm` | Pass | 1.0 / pass | 31.35s | Yes | No contradictions were identified; the output is faithful to the retrieval context. |
| Swapped years | `llm` | Fail | 0.0 / fail | 31.80s | Yes | The output assigns €12,609,320 to 2025 and €17,941,270 to 2026, reversing the stated years. |
| Wrong amount | `llm` | Fail | 0.0 / fail | 30.57s | Yes | The output gives 2025 outflows as €17,491,270, while the context states €17,941,270. |
| Unsupported “already spent” | `llm` | Fail | 1.0 / pass | 34.04s | Yes | No contradictions are listed, so the output is judged fully faithful. |
| Plan stated as actual | `llm` | Fail | 1.0 / pass | 33.63s | Yes | No contradictions were identified; the output aligns with the retrieval context. |
| Wrong committee | `llm` | Fail | 0.0 / fail | 34.54s | Yes | It names the Social Affairs Committee, while the context says the Committee for Equal Opportunity and Integration decides on 30.09.2026. |
| Wrong date | `llm` | Fail | 0.0 / fail | 39.73s | Yes | It gives 29.09.2026, but the meeting is scheduled for 30.09.2026. |
| Wrong place | `llm` | Fail | 0.0 / fail | 35.60s | Yes | It places the proposal in Nippes, but the context concerns Chorweiler. |
| Partially supported | `llm` | Fail | 1.0 / pass | 34.10s | Yes | No contradictions are listed, so the output is judged aligned with the context. |
| Vague but true | `llm` | Pass | 1.0 / pass | 32.38s | Yes | No contradictions were found; the output is judged faithful. |
| Invented next step | `llm` | Fail | 1.0 / pass | 32.37s | Yes | No contradictions were identified; the output is judged faithful. |
| Supported paraphrase | `llm` + ambiguity penalty | Pass | 1.0 / pass | 31.67s | Yes | No contradictions are listed, so the output is judged fully faithful. |
| Supported planned amount | `llm` + ambiguity penalty | Pass | 1.0 / pass | 30.07s | Yes | No contradictions; the output aligns with the retrieval context. |
| Swapped years | `llm` + ambiguity penalty | Fail | 0.0 / fail | 44.04s | Yes | The output reverses the 2025 and 2026 amounts, contradicting the context. |
| Wrong amount | `llm` + ambiguity penalty | Fail | 0.0 / fail | 30.27s | Yes | It gives €17,491,270 for 2025, while the context specifies €17,941,270. |
| Unsupported “already spent” | `llm` + ambiguity penalty | Fail | 0.0 / fail | 37.08s | Yes | It says the city already spent €17,941,270; the context only says that amount was budgeted. |
| Plan stated as actual | `llm` + ambiguity penalty | Fail | 0.0 / fail | 54.73s | Yes | It says the city spent €17,941,270; the context only says the amount was budgeted. |
| Wrong committee | `llm` + ambiguity penalty | Fail | 0.0 / fail | 34.97s | Yes | It names the Social Affairs Committee instead of the Committee for Equal Opportunity and Integration. |
| Wrong date | `llm` + ambiguity penalty | Fail | 0.0 / fail | 50.34s | Yes | It says 29.09.2026, while the meeting is scheduled for 30.09.2026. |
| Wrong place | `llm` + ambiguity penalty | Fail | 0.0 / fail | 33.19s | Yes | It assigns the €37,500 to Nippes, while the context assigns it to Chorweiler. |
| Partially supported | `llm` + ambiguity penalty | Fail | 0.0 / fail | 37.03s | Yes | The new-fire-station detail is not stated in the context. |
| Vague but true | `llm` + ambiguity penalty | Pass | 1.0 / pass | 30.96s | Yes | No contradictions; the output aligns with the retrieval context. |
| Invented next step | `llm` + ambiguity penalty | Fail | 0.0 / fail | 40.63s | Yes | The claimed October 1 start is not in the context, which only gives the rejection proposal and no start date. |

For each of the 12 cases, `hybrid` and `hybrid` with the ambiguity penalty were not run: metric initialization failed because no TypeSafe API key is configured. Both would require an LLM extraction/reason call and a Jev call. `system_one` was also not run for any case for the same key error; it requires Jev but no LLM call.

### Accuracy, speed, and cost

| Configuration | Correct | Accuracy | Mean / median wall time | LLM needed | Cost |
| --- | ---: | ---: | ---: | --- | --- |
| `llm` | 8 / 12 | 66.7% | 33.33s / 33.01s | Yes, Codex judge | Not reported for this custom provider |
| `llm` + `penalize_ambiguous_claims=True` | 12 / 12 | 100% | 37.91s / 36.00s | Yes, Codex judge | Not reported for this custom provider |
| `hybrid` | Not run | Not available | Not available | Yes, plus Jev | Not available |
| `hybrid` + ambiguity penalty | Not run | Not available | Not available | Yes, plus Jev | Not available |
| `system_one` | Not run | Not available | Not available | No LLM; Jev required | Not available |

The ambiguity penalty changed four false passes to failures and did not flip any of the three expected passes. The unpenalized false passes included the known “already spent” claim, the plan-as-actual claim, the unsupported fire-station detail, and the invented next step. This small hand-labeled set is calibration evidence, not a general accuracy guarantee. The Jev price and latency quoted above are TypeSafe's published rates/claim, not measured experiment costs or timings.

### Pipeline rerun

Budget faithfulness checks now score only the ordinance-backed year, amount and line item. The statement no longer carries an unsupported “not actual expenses” caveat; the plan-versus-actual meaning is retained in the UI-visible `status` (`Plan (Haushaltssatzung)`) and `unknowns` (`Tatsächliche Ausgaben nicht belegt`), neither of which is part of the faithfulness input. The 2025 published statement is: “Für das Haushaltsjahr 2025 sind 17.941.270 EUR als Auszahlungen aus Investitionstätigkeit im Haushaltsplan festgesetzt.” The deterministic guard still requires plan wording and rejects actual-spending wording.

We ran the evaluator twice against the same cached generated statements, clearing the faithfulness-result cache between runs so each score was freshly evaluated:

| Published statement | Run 1 | Run 2 | Result in both runs |
| --- | ---: | ---: | --- |
| Strausberg 2025 planned investment outlays | 1.0 | 1.0 | `auto_checked` |
| Strausberg 2026 planned investment outlays | 1.0 | 1.0 | `auto_checked` |
| Köln council paper | 1.0 | 1.0 | `auto_checked` |
| Münster council paper | 1.0 | 1.0 | `auto_checked` |
| Wuppertal council paper | 1.0 | 1.0 | `auto_checked` |

All five scores were stable; no statement flipped, so an extra two-call/minimum-score stability rule was not added. Both budget signals carry the separate plan status and the unknown about actual expenses in structured fields.

### Recommendation

Use `llm` with `penalize_ambiguous_claims=True` in this pipeline: on these cases it caught the false passes without losing any supported or vague-but-true case. Jev could not be calibrated without the hosted TypeSafe key, so this experiment does not justify switching to `hybrid` or `system_one`. Keep the existing deterministic plan-versus-actual guard; it remains an independent invariant.

## Sources

- [DeepEval FaithfulnessMetric: calculation, ambiguity option, and supported modes](https://deepeval.com/docs/metrics-faithfulness)
- [DeepEval evaluation modes](https://deepeval.com/docs/evaluation-eval-modes)
- [TypeSafe: Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [TypeSafe model catalogue, price, context, and language/data notes](https://docs.typesafe.ai/models)
- [TypeSafe API quickstart and API key requirement](https://docs.typesafe.ai/introduction/quickstart)
- [TypeSafe terms of use](https://typesafe.ai/legal/terms)
