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

The microphone now streams into the existing Dutch Realtime conversation with
interruptible robotd playback; see the [conversation stream design](../docs/design/conversation-design.md#implemented-conversation-stream).

## Configuration

To try a conversation without hardware on Windows 11, see the
[browser simulator test mode](windows-simulator/README.md).

Set `OPENAI_API_KEY` in the service environment. Never commit an API key to this repository.

Optional environment variables:

- `DUCK_OPENAI_MODEL`: overrides the existing default Realtime model.
- `DUCK_MIC_DEVICE`: ALSA capture device (default `plughw:aic3104,0`).
- `DUCK_ROBOT_AUDIO_SOCKET`: robotd conversation socket (default `/run/robotd-conversation.sock`).

Requires `arecord` (`alsa-utils`) and access to the capture device. Other microphone
consumers must release the device or use an ALSA capture-sharing configuration.
The speaker continues to use robotd's existing playback owner.

## Build and test

From the repository root:

```bash
cargo check --workspace
cargo test --workspace
cargo run -p duck-assistant
```

Live conversation and interruption need a Microduck, running robotd conversation
socket, and an OpenAI API key. Unit tests do not require these.
