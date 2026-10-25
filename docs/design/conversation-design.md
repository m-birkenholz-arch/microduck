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
`shimmer` with Dutch delivery instructions for a light, slightly higher, warm and
playful duck character. The browser additionally applies the local voice transform
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

### Browser duck voice

The received WebRTC stream is routed through a mono `AudioWorkletNode`, a mute
gain, the existing jaw/gesture analyser and the AudioContext destination. The
HTML audio sink has volume zero, so the unprocessed carrier is never doubled
with the duck voice. Two Hann-crossfaded variable-delay heads resample short
windows, raising pitch and formants together while producing exactly one output
sample per incoming sample. Default +5 semitones, adjustable 0..9 live; zero
bypasses the shifter. Delay spans 8..68 ms. This is an initial cartoon effect,
not formant-preserving or studio-quality speech processing; listening validation
is still needed for intelligibility, timbre and possible granular artifacts.

Barge-in and output-buffer clearing mute the graph immediately and reset the
short delay buffer. Stop disconnects the graph, closes the worklet port and
AudioContext, and releases the microphone as before. The meter sees transformed
audio, preserving jaw motion and audible-answer gesture gating. Installers ship
both voice modules; Vite bundles the worklet URL as a module asset (inlined for small modules).
The data-channel open handler sets `shimmer` before output audio, allowing this
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
