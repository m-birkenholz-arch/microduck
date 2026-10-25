# Microduck conversation design

Status: microphone upload and Realtime playback connected on `feature/conversation`; live hardware validation remains.

## Goal

Turn Microduck's existing microphone, speaker, mouth control, and per-robot voice personality into a natural conversational interface without putting the language model in the 50 Hz robot control loop.

Target interaction:

```text
human speech
  -> microphone audio
  -> VAD / speech-to-text
  -> conversational model + tools
  -> text-to-speech
  -> Microduck voice transform
  -> speaker audio
  -> mouth animation
```

## Design constraints

1. `robotd` keeps ownership of robot hardware and its real-time control loop.
2. Existing voice-bank sounds, theremin and chorale must continue to work.
3. The codec PCM is single-client, so conversational playback must use the existing `Sound` ownership model instead of spawning an independent competing `aplay` process.
4. Arbitrary speech audio must not be transported as base64 inside ordinary JSON-RPC messages. Control belongs in IPC; streaming audio needs a streaming transport/path.
5. The per-robot `sounds::Personality` remains the voice identity. TTS is the linguistic carrier, not the identity source.
6. The first implementation should be reversible and should not modify `main`.

## Milestones

### M1 — arbitrary speaker playback

Add a conversation playback path that can feed 48 kHz mono S16_LE PCM through the same single-client playback owner used by `Sound`. It must be possible to stop/interrupt speech immediately.

Acceptance test: an externally generated spoken sentence is heard through Microduck's speaker without breaking `robot.sound`, theremin, or chorale.

### M2 — microphone stream

Expose microphone PCM to the conversation service without interfering with existing microphone consumers. Add voice-activity detection outside the 50 Hz control loop.

Acceptance test: spoken Dutch is captured continuously and speech segments can be transcribed.

### M3 — conversation service

Add a separate `duck-assistant` process/service. It owns VAD, STT, dialogue state, model/tool calls, TTS, interruption/barge-in, and turn-taking. `robotd` remains responsible for hardware-facing playback and movement intents.

Acceptance test: multi-turn Dutch conversation with interruption support.

### M4 — unique speaking voice

Derive speech transformation parameters from the same `sounds::Personality` seed used for the duck's existing vocalisations. Map pitch register, brightness/tilt, nasality/formants, vibrato/jitter, breath and speed conservatively onto TTS output.

Acceptance test: two seeds produce recognisably different speaking voices while speech remains intelligible; the same seed is deterministic.

### M5 — embodiment

Generate mouth opening from the speech envelope and add restrained listening/thinking/speaking head behaviour through existing robot intents.

Acceptance test: mouth timing follows speech and all motion remains interruptible by normal safety/control behaviour.

## First implementation decision

Do **not** add `robot.speak(text)` to `robotd`. `robotd` should not know about a TTS provider or an LLM. Instead, add a generic interruptible audio-stream playback primitive and keep speech generation in `duck-assistant`.

This separation lets TTS/STT/model providers change without changing the robot firmware contract and keeps network latency away from the control loop.

## Audio format for the first prototype

Use the format already used by synthesized playback in `robotd`:

- mono
- signed 16-bit little-endian PCM
- 48 kHz (`sounds::SR`)

This avoids resampling inside the real-time robot path for M1.

## Safety and failure behaviour

- A new speech utterance may interrupt an old speech utterance.
- Existing shutdown/power-off behaviour retains priority.
- Loss of the assistant process or network must leave ordinary Microduck operation intact.
- No API key or model credential is stored in the repository or voice bank.
- Conversation playback must release the PCM on disconnect/failure.

## Implemented conversation stream

`duck-assistant` connects its `mic::Microphone` to the writer of the existing
OpenAI Realtime WebSocket after sending the session configuration. `arecord`
captures 48 kHz mono S16_LE from `DUCK_MIC_DEVICE` (default `plughw:aic3104,0`).
The capture task assembles complete 40 ms frames, including across partial pipe
reads, then averages adjacent samples to produce 24 kHz PCM16LE. A bounded channel
holds at most eight captured frames; the upload task sends base64
`input_audio_buffer.append` events. It runs independently of playback writes.

The existing Dutch instructions, server VAD and automatic interruption/response
creation stay on the same session. No client-side commit or response request is
needed. Realtime audio deltas still pass through `RobotAudio` for 24 -> 48 kHz
conversion and robotd playback. `input_audio_buffer.speech_started` stops robot
playback for barge-in.

Microphone EOF/read errors and upload failures end the session. Disconnect, error,
or Ctrl-C cancels capture and upload and requests robot playback stop. Dropping
`Microphone` aborts its capture task and kills its `arecord` process.

This capture prototype requires access to the ALSA capture device. Other mic
consumers must release it or share capture through ALSA configuration; microphone
multiplexing and acoustic echo cancellation are not implemented here. Hardware
acceptance tests for simultaneous listening, playback, and interruption remain.
The per-robot speech voice transform and embodiment milestones remain future work.

## Windows browser test

`duck-assistant/windows-simulator` is an installable overlay for the official
Hugging Face browser simulator, separate from the MuJoCo daemon simulator. A
local Node.js helper exchanges SDP with `/v1/realtime/calls`; browser microphone
and speaker media travel over WebRTC directly to OpenAI. The helper binds only
to loopback, validates Host and Origin, and keeps the project API key out of
Vite, the browser, files, and logs. The PowerShell launcher reads the key with
hidden input and restores its previous process environment on exit.

The browser session profile preserves the Rust assistant's model, exact Dutch
instructions, voice and VAD settings; a test guards instruction drift. Both use
`marin` with Dutch instructions for a warm maternal female voice in a natural
mid register, unhurried delivery and small pauses between explanation steps. The browser additionally applies the local voice transform
described below; the Rust robot currently uses the carrier without this DSP. The helper reads the profile at
startup, so profile changes require a helper restart and a new conversation. WebRTC
negotiates its media format, so this mode does not exercise the robot's 24 kHz
WebSocket PCM conversion, ALSA capture, Unix socket framing or RobotAudio playback.
It tests conversational behavior, interruption, browser audio, cosmetic beak
animation and expressive head/neck motion through the simulator's existing
policy head commands. No model-generated commands can start locomotion or skills.

Server VAD cancels the response and clears the WebRTC output buffer on barge-in;
the browser also immediately mutes playback until the next output buffer starts.
An analyser samples the played audio amplitude to animate only the rendered jaw.
The installer composes this opening with the simulator's existing quack/gamepad
jaw opening. Stop, a closed session,
page exit or a startup failure closes the peer connection and microphone tracks,
including tracks granted after Stop was pressed during the permission dialog.

### Browser companion state and interaction

`companion.mjs` owns a versioned browser-local profile (`microduck.companion.v1`):
duck/user names, interests, weather place, personality, nature mode, memory opt-out,
pitch, volume, motion strength and head/body toggles. Values are bounded and
unknown fields are discarded. Writes are transactional with respect to in-memory
state; storage failure cannot be acknowledged as saved. Corrupt data falls back
to defaults with a UI notice. This is origin/profile-specific plaintext
localStorage, not account sync, encrypted secrets storage or robot persistence.

Only user-entered notes or the completed `remember_fact` function can add one of
at most 30 bounded memories. Instructions require an explicit user request, and
the handler requires `explicit_request: true`; this flag is model-produced, not a
separate authentication mechanism. Common key/password patterns are rejected.
There is no transcript archive or background memory extraction. List/forget
functions and per-note/clear-all UI controls expose the state. Memory-disabled
sessions omit notes and memory tools. Names and other preferences are still
shared. UI deletion or disabling closes the current Realtime session to avoid
continuing with the old context; it cannot delete provider-held historical data.
Tool-driven deletion updates the current instructions but previous conversation
items may still carry that fact until the next session.

The mother-duck update adds `voiceProfile: mother-v1` to sanitized preferences.
Older profiles switch pitch to zero and personality to `moedereend`, preserving
names, notes and other preferences. Once the new profile is written, subsequent
manual pitch/personality changes persist; the migration does not run again.
Natural `marin` replaces the previous high `shimmer` carrier in both base profiles
and the browser's initial session update. Saved user names are not renamed.
The tutoring instructions call for level-appropriate explanations, a focused
question about the task when needed, hints and small steps, worked examples on
request, checked calculations and neutral correction. They guide model behavior,
not a programmatic guarantee of educational quality or vocal timbre. A homework
button starts a new session and persists homework mode; photo input can carry an
exercise with explicit instructions to ask about illegible text rather than guess.
Google remains available for factual verification without forcing a lookup for
every routine arithmetic or language exercise. Live listening/tutoring validation
is required; Rust changes here are voice/instruction string edits only.

The helper advertises baseline instructions and Google tool declarations in
`/health` with `companionVersion: 1`, never keys. The browser appends personality
and note data as explicitly untrusted JSON to the exact original Dutch profile
and preserves Google tools when adding memory functions. Memory changes remain
local; relevant contextual wording can still appear in a Google lookup question.
UI edits update session instructions without changing the emitted voice. Audio
and motion slider changes only affect their own live controls and stored values.
The post-tool continuation remains tool-free to avoid lookup/memory loops.

A morning button begins a new session with a dated, location-aware prompt for
weather, a nature/science fact and plans; a missing place is requested first.
A spoken good morning has matching instructions. There is no timed automation.
Personality asks occasional relevant follow-ups, and nature mode focuses on
natural phenomena. Clear enthusiasm and curiosity openings add bounded happy or
curious poses after audible audio begins, with yes/no cues taking precedence.
All prior head/body arbitration and interruption gates remain in force.

`wake.mjs` is an opt-in browser SpeechRecognition standby mode. A click primes a
resumed AudioContext for later playback and starts recognition in Dutch. Matching
uses complete word sequences for “hé/hey/hoi <duck name>”, with any trailing
question forwarded as text. Recognition stops before Realtime opens, avoiding
dual microphone consumers and self-triggering on the duck's voice. Ordinary
recognition end schedules a bounded-delay retry; permission/network errors stop
with a user-visible fallback. Stop, page exit, HMR or a hidden tab abort both
modes, timers and audio resources; standby never auto-enables after reload. This
API may send room audio to a browser vendor's online recognition service; it is
not an offline keyword detector. Live Windows support, autoplay and recognition
accuracy remain to be validated.

`photo.mjs` handles a deliberately selected image only, capped at 8 MB, decoded
and resized to a bounded JPEG data URI for a single Realtime `input_image` item.
No webcam is automatically opened, no continuous video is sent, and no photo is
persisted. The current simulator scene camera is only a virtual view (see
`app/src/scene/GameCanvas.jsx` upstream); actual robot video belongs to the
existing [WebRTC transport](remote-webrtc.md). Integrating physical camera frames
and actuators is future work. The model is prompted to express identification
uncertainty and treat image text as data, not instructions.

These features are browser-only; Rust workspace behavior and physical hardware
are unchanged. Tests cover storage, memory dispatch, wake boundaries/lifecycle,
photo limits, voice volume/muting, personalized protocol messages and motion
caps. A DOM smoke check exercises settings reload, memory controls, safe text
rendering, wake start/stop and cleanup; it is not a real Windows microphone test.

Interface references: [Realtime image inputs](https://developers.openai.com/api/docs/guides/realtime-conversations#image-inputs)
and [browser SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).

### Local laptop face recognition

`face-local.mjs` runs an opt-in browser-only face detection/recognition experiment.
Face recognition itself sends no camera frames through Realtime, the helper or
Google. The separate opt-in Gemini snapshot feature below can send a requested
frame through the helper to Google; Realtime receives only its text analysis. `Camera testen`
opens controls, then an explicit camera-start click requests user-facing video
640x480 with `audio: false`. Preview and bounding rectangles are mirrored together.
There is no physical robot camera bridge or identity-driven movement command.
The pre-existing explicit photo upload remains independent of this live camera.

`install.ps1 -FaceCamera` runs `face-assets.mjs`, downloading the minified browser
bundle, three model manifests and their shards, and the upstream license from
face-api.js 0.22.2 commit `8609b25a15f417398a4d2b95dc91985cd1e0c0c3`.
`face-assets.json` records exact sizes and SHA-256 digests. Downloads use temporary
files, reject invalid content and reuse only verified cached files. The overlay
installer validates the complete optional asset set before copying it to
`app/public/duck-face`. Binaries are downloaded on the user's laptop, not stored
in this repository. Once installed, browser script/weight requests are same-origin
only. Missing models give a setup instruction. Script/model loading has bounded
timeouts. `face-engine.mjs` waits for current video data and takes a local 2D
canvas snapshot at the intrinsic video dimensions before inference, clearing its
pixels afterwards. This avoids passing an unready or driver-dependent video
texture directly into TensorFlow. Model access is serialized across Stop/restart
overlap. WebGL is preferred; the first inference failure triggers one CPU retry
with locally reloaded weights rather than reusing possibly lost GPU textures; the simulator and voice worklet
keep their existing independent pipelines.

Only TinyFaceDetector, the tiny 68-point landmark network and the 128-dimensional
recognition network are loaded. No age/gender/emotion or other attribute heads
are loaded or invoked. Inference is serial, with a 250 ms pause between completed
passes. A usable enrollment observation requires exactly one face, score >=0.8,
and a box >=100x100 pixels. Three recent, consistent descriptor samples are needed
before the explicit Learn button can create a record. Enrollment rejects invalid
vectors, excessive variation, duplicate names and measurements that already
match an existing profile. There is no silent enrollment or image archive.

`FaceGallery` owns a separate plaintext localStorage key, `microduck.faces.v1`,
with the engine version, up to five opaque IDs, user-supplied names and three
128-number templates per person. Storage failure is not acknowledged as saved.
The ordinary memory toggle/clear function does not delete this separate gallery;
it has its own per-profile and clear-all controls. Match scoring uses minimum
Euclidean distance over a person's samples, threshold 0.45 and at least 0.08
margin against the next person. Each enrolled person is surfaced after three consecutive quality matches, including
when several people are visible. Duplicate identity matches in one frame are rejected.
Enrollment still requires exactly one face. Missing, poor quality, unknown/ambiguous
results or a >5 second stale observation withhold the affected name immediately. These
are conservative heuristic thresholds, not calibrated identity probabilities.
There is no liveness proof: photos and false matches are possible.

The default schedule/cancel callbacks wrap `globalThis.setTimeout/clearTimeout`
rather than storing bare Window methods on a class instance. The previous
`this.schedule(...)` invocation used an invalid native receiver, raising
`Illegal invocation` after the first face result and preventing three-frame
enrollment. Browser-style receiver checks now cover the full timer-driven
three-frame enrollment and stop path; the wake restart timer has the same fix.
Node's permissive timer receivers had hidden this issue from earlier tests.

The local `get_camera_status` Realtime function is read-only and never starts a
camera. It returns active state and a recent face count, plus a list of possible
names and a possible speaker only when the user opts in to name sharing. It never
exposes images, landmarks or descriptors to the model. Current consented context
is included in session instructions and refreshed only when it changes; microphone
VAD start/stop events also refresh it. Instructions require a fresh status tool call
before answering with name sharing enabled, avoiding stale attribution during the
automatic VAD response. Updates do not create responses or interrupt playback.
A dedicated greeting button can still start a fresh conversation with a one-sentence
greeting, using a possible name when available, without a routine confirmation.
Recognition uncertainty stays in the background: omit an uncertain name and continue
the conversation. Ask “Wie praat er?” once only if identity matters. An explicit
recognition question without a match gets “Ik herken je nog niet.” Technical
limitations are explained only on request, rather than repeated aloud.

Speaker attribution is an experimental local heuristic, not voice identification.
Only during Realtime input VAD speech does each stable enrolled face accumulate
up to 12 mouth-opening measurements over 2.5 seconds. Inner-lip distance is
normalized by mouth width. At least three measurements spanning 400 ms, two
changes >0.025 and a range >0.06 are required. Exactly one moving mouth and all
visible faces recognized are required; otherwise attribution is withheld. The
possible speaker remains available after speech ends for at most 15 seconds,
provided the face is still present and fresh; the next speech start clears it.
Short utterances, CPU latency, eating, off-camera speech and overlapping speakers
can defeat this heuristic. The assistant asks who is speaking when needed and
must not equate the only visible face with a proven speaker. No audio identity
embeddings or image/video recordings are stored.

The base Dutch
voice/profile, Google tools and explicit memory functions remain present. Names
are untrusted data, not instructions. Sharing defaults off, is not persisted and
resets on stop. Already shared names can remain in the conversation/provider
history; disabling sharing is not retrospective deletion.

Stop, hidden tab, page exit and HMR close camera tracks, reset samples/results,
clear the serial-loop timer and disable sharing. Generation guards release tracks
granted after Stop and ignore late model/detection completion without reopening
the camera. An inference failure now clears match/enrollment state and pauses only
recognition; the camera preview stays open, with a bounded diagnostic message and
a user-triggered retry button using the same stream. Retrying is disabled while
recognition is already active and is generation-guarded against Stop. An optional
rectangle-render failure only hides the overlay. A video track ended by the
browser/OS still closes capture and shows a reason; listeners are removed on Stop.
Hidden-tab shutdown also explains its cause and still requires an explicit restart.
Explicit profile deletion also stops recognition to clear old matches.
Model weights can remain cached in browser memory until page exit, but are not a
camera recording. Readiness/consent controls and profile names use DOM text APIs.

Validation includes lifecycle/matching/storage/hash tests, DOM enrollment/share/
delete smoke checks and real CPU inference on two upstream test-face fixtures.
The real model smoke check confirms detection/descriptor extraction and separation
of those fixtures; it is not a recognition accuracy benchmark. Real Windows camera,
GPU performance and false-match behavior require the user's live trial. Rust
workspace code and hardware paths are unchanged.

Upstream implementation/API: [face-api.js](https://github.com/justadudewhohacks/face-api.js/tree/8609b25a15f417398a4d2b95dc91985cd1e0c0c3).

### Google Search for browser conversations

When a Google API key is present, the helper adds the `search_web` function and
supplementary Dutch search instructions to the base session profile. The base
Dutch conversation/voice profile still matches Rust. Google uses the Gemini REST
`generateContent` endpoint with `google_search`, default `gemini-3.8-flash` (model
configurable via `DUCK_GOOGLE_MODEL`). OpenAI remains the Realtime voice provider.
Only the standalone search question, current UTC time and a fixed search prompt
are sent to Google, not the full transcript or microphone stream. Keys stay in
the loopback helper; `start.ps1 -GoogleSearch` prompts with hidden input and
restores both previous process environment values on exit.

The browser executes function calls only after a completed `response.done`, not
on arguments-done events which can belong to cancelled responses. It sends each
`function_call_output` followed by one `response.create` with `tool_choice: none`
for the spoken answer. Duplicate calls are ignored. Barge-in cancels pending
lookups, completes old calls as interrupted without generating another answer,
and suppresses stale results; Stop aborts without sending into a closed channel.
Search failures become explicit tool errors; absence of grounded sources is an
error rather than a plausible but unverified search answer.

`POST /search` retains the helper's exact Origin/Host checks, accepts only a
bounded JSON query and uses a fixed Google endpoint with header authentication.
It has a 30-second provider timeout, one active lookup and ten requests per minute;
client disconnect aborts the provider request. Provider/network errors are
sanitized, never forwarded verbatim. Source URLs are restricted to HTTP(S) with
no embedded credentials. The latest Google answer and source links are rendered
as text/DOM links; Search Suggestions use Google's supplied HTML in a sandboxed
iframe with scripts disabled. The panel displays the lookup evidence, not
claim-level citations for the Realtime model's later spoken paraphrase. Retrieved
text is untrusted data and carries no authority to change instructions or operate
the robot. The feature can only look up public information, not drive actuators.

Without a Google key, the original speech session remains available without tools.
`/health` exposes only search readiness/version and no keys. Existing helpers must
be restarted to activate the new route and tool registration. The physical Rust
assistant has not yet implemented the Google tool; this milestone is browser-only.
Tests mock both providers. Live Google access, account quota, Windows prompts and
spoken search behavior require a user-side test with valid credentials.

Official interface references: [Google Search grounding](https://ai.google.dev/gemini-api/docs/generate-content/google-search),
[Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key), and
[Realtime function calls](https://developers.openai.com/api/docs/guides/realtime-conversations#function-calling).

### Browser duck voice

The received WebRTC stream is routed through a mono `AudioWorkletNode`, a mute
gain, the existing jaw/gesture analyser and the AudioContext destination. The
HTML audio sink has volume zero, so the unprocessed carrier is never doubled
with the duck voice. Two Hann-crossfaded variable-delay heads resample short
windows, raising pitch and formants together while producing exactly one output
sample per incoming sample. The mother-duck profile defaults to 0 semitones
(bypass), adjustable 0..9 live. This removes the high cartoon shift and its
granular artifacts from the default voice. Delay spans 8..68 ms. This is an initial cartoon effect,
not formant-preserving or studio-quality speech processing; listening validation
is still needed for intelligibility, timbre and possible granular artifacts.

Barge-in and output-buffer clearing mute the graph immediately and reset the
short delay buffer. Stop disconnects the graph, closes the worklet port and
AudioContext, and releases the microphone as before. The meter sees transformed
audio, preserving jaw motion and audible-answer gesture gating. Installers ship
both voice modules; Vite bundles the worklet URL as a module asset (inlined for small modules).
The data-channel open handler sets `marin` before output audio, allowing this
browser update to work with a helper still holding the previous profile. No extra
provider call, package dependency, changed speech tempo or response-length queue
is introduced. This browser DSP is not yet the seed-derived robot personality
transform from M4 and is not applied to RobotAudio PCM playback.

### Existing expressions connected to speech

`motion.mjs` ports the small `robotd::chorale::head_expression` pattern, using
played speech amplitude as the reach parameter instead of a sung note's pitch.
A parity test checks the existing Rust pattern's constants and output. Listening
and waiting use a restrained neck lean and curious tilt in the spirit of
`idle_head.rs`; this is not a port of its full autonomous glance/yawn behaviour.
Explicit client phases come from input/output buffer events. `response.done`
does not end the speaking motion because buffered audio may still be playing.

The offset is added to the existing `headTarget` before its normal 50 Hz EMA;
the stored manual target is never changed. The installer validates this hook
before editing any source. The extension yields while moving, in head mode,
during boot/respawn, sit/skills, recovery, dragging, scripts, community policies,
roller mode and stand-up/post-kick transitions. There is no queue of gestures to
replay when these end. The head offsets fade toward zero at Stop, and can be
disabled separately from voice.

### Standing body reactions

The official browser simulator already loads `BEST_alpha_stand.onnx` for recovery.
It is the alpha standing/body-pose network (the old standing slot documented in
`deploy/robotd.toml`). While the conversation asks for body movement and the duck
is stationary in ordinary legs/walk mode, the existing session selector now uses
this standing network. Recovery retains first priority. This avoids feeding
unsupported body-pose requests to the walking policy or faking a rendered pose.

The same conversation tick produces bounded body `[z, roll, pitch]` offsets:
small breathing/weight shifts while speaking, a held attentive posture while
listening, all smoothed. These enter command slots 9/10/11, the observation's
57/58/59. Body x/y/yaw (slots 7/8/12) stay zero. Scripts retain their existing
final ownership of the full command vector. No direct changes to MuJoCo qpos,
actuator outputs or rendered transforms are made by the conversation extension.

Body height is capped at +/-0.008 m and roll/pitch at +/-0.10 rad. The existing
manual/movement/skill/recovery gates override body reactions immediately. Stop,
disabling body motion or a closed session fades the pose to zero; the standing
network remains selected through that return, then the ordinary session resumes.
The independent body toggle does not change head motion or voice.

Tests cover pose slot layout, zeros in the untrained slots, policy selection,
recovery priority, immediate manual takeover, bounded/smooth motion, neutral
return and independent toggles. Simulator balance and model-to-model transitions
still need observing on the laptop; none of this is a hardware validation.

The browser build and automated tests do not establish Windows device access or
live OpenAI account/model access; those require a conversation on the laptop.

The browser motion strength defaults to 3x, adjustable from 1x to 4x. A speech
phrase retains a 0.60 amplitude floor so low laptop RMS does not make the sway
invisible. Scaled offsets are capped at 0.12 rad for the neck and 0.30 rad for
other head axes before the existing smoothing; these are simulator command
bounds, not measured guarantees about rendered angles or hardware validation.

### Affirmative nods and negative shakes

`gestures.mjs` conservatively classifies the opening clause of the model's
generated audio transcript. Streamed deltas are buffered until a clause boundary
or transcript completion: a partial "Dat klopt" must not nod before "niet"
arrives. Clear Dutch yes/no phrases trigger a nod or shake; quoted speech,
questions, uncertain wording and unrecognised clauses abstain. This is a local
phrase matcher, not a general semantic classifier or an additional LLM call.

Each response ID owns its pending cue. The cue waits for the matching
`output_audio_buffer.started` and nonzero played audio, then emits at most once.
Completed generation does not end a buffered audio response. Interrupted,
cancelled or drained responses are tombstoned so late transcript.done events
cannot revive an old gesture. Stop clears all cue state. Transcript timing has
no per-word playback alignment here: the gesture is approximately aligned with
the audible answer, not guaranteed to coincide with an individual word.

The gesture briefly replaces the generic head sway with two enveloped pitch
cycles for yes or yaw cycles for no. Existing bounds and policy head command
paths still apply, with faster head smoothing for a visible deliberate gesture.
Body sway is unchanged. Listening, Stop, disabled head motion and manual takeover
cancel a gesture; it is never replayed after an override. Tests cover split
negation, ambiguity, response/audio ordering, duplicate and late events, motion
axis/duration/bounds, independent body motion and cancellation.


### Requested camera analysis with Google Gemini

`vision.mjs` defines `analyze_camera` and the single-frame capture contract.
The camera panel has a separate, non-persisted **Camerabeelden delen met Google**
checkbox, default off and reset by camera stop, Stop all, hidden tab and page exit.
Name sharing and image sharing are independent. After an explicit visual question
or **Bekijk dit**, the tool captures one decoded frame from the already-running
laptop video. It never starts the camera, samples in the background or archives
images. Canvas capture shrinks the image to at most 960 pixels on its longest
edge, reducing further as needed to a JPEG data URL <=240,000 characters; the
canvas pixels are cleared immediately. Image analysis does not identify people.

The client discovers `googleVision` through `/health`; an older helper keeps voice
working but requires an update/restart for vision. The new tool appears alongside
Google Search, memory and camera-status tools. A live session is reused by the
button; an idle app starts a session. While a response is pending or playing,
the button asks the user to wait or ask aloud (existing voice barge-in applies).
The model is instructed to invoke analysis only for an explicit visual request.
The frontend and tool handler enforce consent again before capture and after the
response; they do not depend on the model to enforce the checkbox.

`POST /vision` uses the same loopback Host/Origin protections as `/search`, a
250,000-byte JSON-body limit, exact question/image schema, bounded question and
JPEG/base64 checks. It shares the one-active-request and ten-requests-per-minute
Google budget with search. `vision-google.mjs` calls Gemini generateContent with
one inline JPEG and the question using the existing server-only Google key and
model setting. It has no Google Search tool: results are labelled Gemini image
analysis, not Lens results or sourced web search. Instructions treat image text
as untrusted data and request concise Dutch answers. Provider errors are sanitized;
thought parts, raw images and descriptors never enter the Realtime tool output.
The analysis description is sent to OpenAI for the spoken answer. The app stores
neither the frame nor analysis in localStorage or files; provider retention is
not controlled by the app.

Only one image call per completed response batch is accepted. Extra tool handlers
receive the existing cancellation signal; barge-in and Stop abort vision requests
and invalidate the batch. Revoking image sharing or stopping the camera aborts the
pending browser request; disconnected HTTP responses abort the upstream call.
Late results are discarded before display or tool output. Requests already sent
to Google cannot be recalled. Successful tool results produce the existing single
spoken response and retain voice settings, motion, face recognition and playback.

Reference: [Gemini inline image inputs](https://ai.google.dev/gemini-api/docs/generate-content/image-understanding).
