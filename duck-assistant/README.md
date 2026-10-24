# duck-assistant

`duck-assistant` is the conversational bridge that will let a person talk naturally to ChatGPT through Microduck.

Target path:

```text
Microduck microphone
  -> 24 kHz PCM
  -> OpenAI Realtime session (Dutch by default)
  -> 24 kHz PCM response
  -> Microduck personality voice transform
  -> 48 kHz PCM
  -> robotd conversation audio
  -> speaker + beak motion
```

The service is intentionally separate from `robotd`. `robotd` keeps ownership of realtime robot control and the exclusive audio device; this process owns network conversation state.

## Current milestone

The service can establish a stateful Realtime session configured for natural Dutch conversation, server VAD, and interruption. Incoming model audio is recognized but is not yet forwarded to the robot speaker.

## Configuration

Set `OPENAI_API_KEY` in the service environment. Never commit an API key to this repository.

Optional: `DUCK_OPENAI_MODEL` overrides the default realtime model.

## Next milestone

1. Add a local IPC stream between `duck-assistant` and `robotd`.
2. Decode model PCM output and resample 24 kHz -> 48 kHz.
3. Feed it into `SpeechPlayback` without opening ALSA from `duck-assistant`.
4. On detected user speech, immediately stop robot playback (barge-in).
5. Add microphone capture in the reverse direction.
6. Derive a speech-safe voice fingerprint from the robot's existing `sounds::Personality` seed and add beak amplitude tracking.
