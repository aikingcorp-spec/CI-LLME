# ADR 0013: Native voice transport and bounded task completion review

Status: Implemented; external acceptance pending

Date: 2026-11-02

## Decision and ownership

Native voice is an opt-in personal connection in the existing Voice settings.
The node selects an owned ChatGPT OAuth model credential and creates a native
call from the browser's SDP offer. Only the SDP answer returns to the browser.
The model credential remains the sole owner of token refresh and revocation;
the new preference references that credential with a composite ownership FK.
Deleting the model connection deletes its voice preference. The migration is additive.

The browser owns microphone, playback, RTC lifecycle and the existing CallCard.
Codex owns conversational audio; Pi owns tools, authorization, memory and tasks.
Native delegation IDs are deduplicated within a call. Delegated work uses the
existing thread send/steering pipeline and call nonce. Pi replies return over the
native data channel. Hanging up releases media without cancelling background work.
The browser closes media after a failed node authorization heartbeat; unmount,
account/space changes and explicit hang-up close it immediately. The native
provider endpoint is a versioned external contract and may change independently.

Voice settings do not turn native voice into a TTS or transcription provider.
Legacy speech/dictation settings keep their own credentials and readiness.
Voice choice applies to the next call. Bot TTS voice overrides do not select an
unrelated Codex voice. Native calling currently targets the shared web/Electron
surface; mobile native adaptation and bot-initiated native calls are separate work.

At Pi's existing finish-turn boundary, an opt-in semantic reviewer can identify
unfinished authorized work after tool execution or user steering. It uses the
active connection, no tools, bounded evidence and the versioned
`task-continuity-v1` rubric. It cannot override cancellation, an approval pause,
provider abort, silent background tasks or an exhausted tool budget. It makes
at most two review calls per runtime invocation, each with a 20-second deadline
and 1,024 output-token ceiling. Usage goes through the existing observer and
accounting as `setup`, separately from answer calls. Enable explicitly with
the account's “Continue unfinished tasks” setting; default is off to avoid surprise
model usage. The executor reads this preference with the existing user-context
lookup, without another query. A request's explicit false overrides the optional
`AGENT_CONTINUITY_REVIEW=1` composition-root default for programmatic runtimes.

Invalid or failed reviews are unqualified, logged without conversation content,
and preserve existing completion behavior. The bounded layer improves recovery;
it does not certify every task completed or force repeated continuation forever.
An external dependency failure blocks dependent steps only. Decisions about
meaning come from the rubric/model, not keyword rules.

Verified inline app authorization can wake its completed source run once. The
thread lock serializes card resolution and enqueue preparation. A still-running,
cancelled, superseded or onboarding-only task is not automatically restarted.
Existing queued-run recovery handles a lost enqueue after commit.

## Alternatives

### Call context snapshot, 2026-11-03

At each native call setup the node loads the owned user's display name/timezone,
the selected bot's instructions, separately bounded user and bot durable memory,
the existing conversation summary and up to twelve recent visible messages.
The same MemoryStore and transcript filtering used by Pi own the reads. No
credential store, other account's thread, hidden tool payload or ChatGPT consumer
memory is used as background context. User and bot memory have independent
budgets so a large bot document cannot displace personal memory. Encoded JSON
fields are bounded even when control characters expand during serialization.

The provider receives these facts as background data with explicit limits on
trust and completeness. Memory changes and missing knowledge are delegated to
Pi. Call setup adds no model request or separate persistent memory store. A new
call reloads edits/deletions; an already running provider session cannot unlearn
data previously supplied. This snapshot does not promise to persist every casual
voice utterance as durable memory. Explicit requests to remember facts use Pi's
existing authorized memory tools.

A browser-provided snapshot would let the client choose identity and history;
a separate voice memory store would split ownership from Pi. Node-owned scoped
reads retain the existing authorization boundary.

Running the Codex agent harness behind voice would split ownership of tools,
memory and approval policy from Pi. A native audio transport bridge retains one
execution owner. Reusing a TTS credential would confuse account ownership and
speech readiness, so the native preference is separate.

A new durable workflow engine could track every semantic dependency, but would
replace execution/lease/checkpoint machinery that already exists. A prompt-only
request to keep working cannot enforce a continuation. The bounded finish hook
uses the existing loop without a second task engine. A full task ledger remains
an option if measured failures persist after this limited change.

## Verification and limits

Deterministic checks cover transport/resource lifecycle, owner filters, database
RLS/FK constraints, steering, exactly-once fixture effects and review budgets.
They do not prove human audio quality, voice-originated delegation, entitlement,
provider OAuth success or Internet NAT. Calibrate the semantic rubric against
reviewed examples with an opt-in real model and record review usage separately.
Provider failures are not successful certification.

Rollback the app/API/worker together to their prior immutable artifacts, disable
the opt-in reviewer, and retain the additive tables. Never restore a production
database or rotate pairing/signing material as a rollback test.

Native voice denial handling uses a bounded upstream JSON read and a closed set of safe errors. A structured `usage_limit_reached` denial is distinct from transient HTTP 429 throttling. The API preserves actionable account/service errors instead of reporting an internal server failure. It does not switch credentials, automatically retry call creation, infer a reset time or reproduce provider bodies in logs/client replies.
