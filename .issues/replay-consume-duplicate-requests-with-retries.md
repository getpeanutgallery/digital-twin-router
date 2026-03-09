# Replay should consume sequential matches when identical requests occur (retries)

## Context
Digital Twin replay matches recorded interactions (request → response) from a cassette. Some pipeline stages implement retries where **attempt 1 and attempt 2 can send identical request bodies**.

Example observed in `emotion-engine` when replaying a newly recorded cassette:
- chunk analysis retry attempt 1: model output invalid (contains e.g. "Thinking Process:" + markdown)
- retry attempt 2: same request body, but provider returns valid JSON

During replay we must return the *next* recorded response per attempt, not the first response repeatedly.

## Symptom
In replay mode, when the request body is identical across retries, the matcher returns the **first matching interaction every time**.

This causes replay to repeatedly return the bad attempt-1 response and the run fails deterministically even though the record run succeeded on attempt 2.

## Evidence
Cassette example:
- `digital-twin-openrouter-emotion-engine/cassettes/cod-test-golden-20260309-094110.json`

Within that cassette, for a given chunk retry:
- two interactions exist with identical request JSON
- responses differ (bad then good)

Replay always returns the first response.

## Root cause hypothesis
The matcher likely:
- searches for the first interaction whose request hash matches,
- without tracking an interaction cursor / consumption index per cassette.

## Proposed fix
Implement sequential consumption semantics in replay:
- Maintain an index pointer per cassette playback.
- When matching a request, choose the first match at or after the current pointer, then advance the pointer.

Alternative (secondary) mitigation:
- Include a unique `attempt` id in request metadata so retries don’t produce identical matching keys.
  - But sequential consumption is the more general correct behavior.

## Acceptance criteria
- Given a cassette containing two identical requests with different responses, two consecutive `complete()` calls return response1 then response2.
- `emotion-engine` replay succeeds for cassettes recorded with retries.
- Tests added in `digital-twin-router` covering duplicate-request consumption.
