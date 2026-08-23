# LeakLine Continuous Evaluation

## Purpose

LeakLine should not treat a capability as permanently correct after release. Every meaningful change to the renewal assistant should be tested against representative operator situations before deployment.

The current loop is:

> Hypothesis -> representative scenarios -> measurable threshold -> prototype -> evaluate -> productize -> monitor real usage -> add failures to the test set -> improve -> reevaluate

## Current evaluation surface

The first evaluation set covers the read-only renewal assistant. It checks:

- Factual accuracy
- Grounding in the supplied workspace records
- Reasoning quality
- Actionability
- Appropriate uncertainty
- Safety and permissions
- Clarity
- Non-fabrication
- Local analysis latency

Tenant isolation, authentication and role enforcement remain server security tests because the assistant analysis function never chooses which workspace data it receives. The server must enforce that boundary before records reach the assistant.

## Release thresholds

The following dimensions currently require a 100% pass rate:

- Factual accuracy
- Grounding
- Appropriate uncertainty
- Safety and permissions
- Non-fabrication

Reasoning quality, actionability, clarity and latency currently require at least 90%. A critical check always blocks release even if the overall dimension threshold is met.

Run the assistant evaluation with:

```bash
npm run eval:assistant
```

Run the complete release check with:

```bash
npm run verify
```

## Turning real failures into regression scenarios

When a pilot user finds a meaningful failure:

1. Record what the user asked, what permitted data was available, what LeakLine returned and what the correct outcome should have been.
2. Remove names, phone numbers, email addresses and other customer information.
3. Create the smallest synthetic scenario that still reproduces the failure.
4. Add it to `evals/renewalAssistantScenarios.ts` with `source: 'production_failure'` and a non-sensitive incident reference.
5. Run the evaluation and confirm that the new scenario fails before changing the product.
6. Fix the capability.
7. Run `npm run verify` and confirm that the new scenario and the existing set pass.
8. Keep the scenario permanently so the same failure cannot silently return.

Do not weaken a threshold or remove a scenario simply to make a release pass. Change a threshold only when product evidence shows that the measurement itself is wrong.

## Next phase

When a language model is added, compare three versions against the same scenarios:

- The current deterministic production baseline
- The ideal human-reviewed answer
- The proposed model response

The model should only replace or extend the baseline when it moves closer to the ideal answer without creating regressions in grounding, permissions, privacy or non-fabrication.
