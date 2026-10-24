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
