# Same-Anchor 96px Imperfection Preference Design

## Goal

Improve the production Top-N selection for exact `96x96` Gemini watermark candidates by promoting a visually cleaner same-anchor candidate when the current winner has a high-severity imperfection signal and the alternative stays within established evidence and damage tolerances.

This change is intentionally narrow. It must not alter `48x48`, `94x94`, other non-96 sizes, different anchors, candidate generation, alpha estimation, or the existing general ranking weights.

## Evidence

The diagnostic source is:

- `.artifacts/same-anchor-imperfection-review/report.json`
- `.artifacts/same-anchor-imperfection-review/review.json`
- `.artifacts/same-anchor-imperfection-review/summary.json`

The current 424-sample report contains 111 `residual-risk` inputs. Re-running those inputs while capturing all completed Top-N candidates produced 26 same-anchor comparisons that met the diagnostic evidence and damage tolerances.

For exact `96x96` selected anchors, the manual review result was:

- 7 `alternative-better`
- 3 `tie`
- 0 `current-better`
- 0 `unclear`

The separate `94x94` comparison was also better but is excluded because one sample is insufficient to establish a production rule for that size.

The reviewed pairs do not share one selected family, discovery role, source string, or alpha-profile transition. Their alternatives include both `alpha` and `geometry` families. The stable relationship is instead:

- exact same structured anchor (`x`, `y`, `width`, `height`)
- exact `96x96` size
- continuous imperfection score at least `0.15` lower
- evidence loss no more than `0.05` above the incumbent
- damage loss no more than `0.05` above the incumbent

One visually better alternative has a higher aggregate residual loss than the incumbent. Therefore residual loss must not be added as a separate eligibility tolerance for this rule.

## Considered Approaches

### 1. Post-ranking same-anchor promotion (selected)

Run the existing ranking unchanged, then inspect only the current winner and eligible exact-96 same-anchor alternatives. Promote the best eligible alternative whose imperfection score improves by at least `0.15` to rank 1 and preserve the relative order of all remaining candidates.

Advantages:

- exactly matches the validated diagnostic relationship
- isolates the change from `48x48` and other sizes
- preserves existing discovery penalties, Pareto dominance, catastrophic protection, and general score behavior
- is deterministic and easy to test independently

### 2. Add imperfection score to the global final score

Rejected because it changes every candidate comparison, including the mixed `48x48` cluster where manual review found improvements, ties, and regressions in equal numbers.

### 3. Prefer selected families or alpha profiles

Rejected because the manually better pairs span selected `geometry`, `alpha`, `standard`, and `polarity` families, alternative `alpha` and `geometry` families, and multiple alpha-profile transitions. A family or profile allowlist would encode accidental sample details instead of the validated relationship.

## Production Rule

The implementation will add a pure post-ranking preference step in `src/core/pipelineCandidateQuality.js`.

The existing ranking first produces its normal ordered candidate list. Let its first candidate be the incumbent. The post-ranking preference is eligible only when all of the following are true:

1. The incumbent has a structured position with `width === 96` and `height === 96`.
2. The incumbent imperfection severity is exactly `high`.
3. The incumbent imperfection score, evidence loss, and damage loss are finite numbers.
4. The alternative has the exact same structured `x`, `y`, `width`, and `height`.
5. The alternative imperfection score is finite and no greater than `incumbent.imperfectionScore - 0.15`.
6. The alternative evidence loss is finite and no greater than `incumbent.evidenceLoss + 0.05`.
7. The alternative damage loss is finite and no greater than `incumbent.damageLoss + 0.05`.
8. The alternative does not meet the existing catastrophic-block condition.

A minimum `0.15` imperfection-score reduction is required. The initially broader rule incorrectly promoted the `20260617.png` alpha-`1.15` candidate after only a `0.1188` reduction, producing a visible dark star. All 10 reviewed exact-96 alternatives remain eligible: the smallest reviewed reduction is approximately `0.1595`.

The rule does not require the alternative to have a different family, alpha profile, source, or polarity.

## Alternative Selection Order

If more than one alternative is eligible, choose deterministically by:

1. lower imperfection score
2. lower residual loss
3. earlier position in the existing base ranking
4. lexicographically smaller candidate ID

The chosen candidate moves to index 0. Every other candidate retains its relative base-ranking order. Ranks are then reassigned sequentially.

This is a post-ranking list transformation rather than a new pairwise comparator rule. That avoids comparator cycles and keeps the existing ranking semantics intact for all candidates outside the narrow override.

## Selection Confidence and Metadata

The final selected candidate continues to expose its existing `qualitySignals.imperfections` data and candidate summaries. No new public metadata shape is required.

Selection confidence is calculated from the final ordered list using the existing formula. If a promoted candidate has a worse aggregate final score than the prior incumbent, the existing clamp naturally reports zero confidence instead of inventing confidence from the imperfection metric.

## Missing or Invalid Data

The preference step must return the base-ranked list unchanged when:

- the list is empty
- the incumbent position is missing or not exactly `96x96`
- the incumbent severity is not `high`
- any required incumbent signal is missing or non-finite
- no same-anchor alternative meets every eligibility condition

Diagnostic callbacks remain default-off and are not required for production selection. Callback failures remain isolated from candidate execution and ranking.

## Testing

### Unit tests

Add focused tests proving:

- an eligible exact-96 same-anchor lower-imperfection candidate is promoted
- an eligible visual-tie style candidate is still allowed to promote without a minimum score delta
- `48x48`, `94x94`, and non-square positions are unchanged
- different `x` or `y` positions are unchanged
- the evidence and damage tolerances include the exact `+0.05` boundary and reject values above it
- missing or non-finite signals leave base ranking unchanged
- catastrophic candidates cannot be promoted
- multiple eligible alternatives use the documented deterministic order
- non-promoted candidates preserve their relative base order
- existing same-anchor clean dominance and all current ranking tests continue to pass

### Batch validation

Re-run the current 424-sample suite and the 36-image contrast suite.

Acceptance criteria:

- the exact-96 preference changes only the 10 reviewed exact-96 cases, unless a changed source report is explicitly explained
- the 10 reviewed cases resolve to the reviewed alternative candidate IDs
- no `48x48`, `94x94`, or other-size selected candidate changes
- no new catastrophic result
- no new retry recommendation
- no clean-output regression
- no increase in possible-content-damage or mixed classifications

Generate before/current/after triplets for every changed candidate and visually recheck all changed outputs. The expected reviewed outcome is 7 improvements, 3 ties, and 0 regressions.

### Repository validation

- focused candidate-quality tests
- diagnostic script tests
- full `pnpm test`
- `pnpm build`
- `git diff --check`

## Scope Boundaries

This design does not:

- change candidate discovery or Top-N count
- change alpha maps, alpha gains, geometry search, or cleanup algorithms
- alter global final-score weights or discovery penalties
- apply to `48x48`, `94x94`, or other sizes
- automatically generalize from the current 96px result to future watermark sizes
- remove or weaken catastrophic-block protection

Any later expansion to another size requires a separate visual evidence set and design review.
