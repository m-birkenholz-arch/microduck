//! Interruptible PCM playback for conversational speech.
//!
//! This module is deliberately provider-agnostic: ChatGPT/OpenAI never enters the
//! 50 Hz robot loop. The future `duck-assistant` process produces speech PCM and
//! robotd remains the owner of the physical speaker.
//!
//! M1 contract: 48 kHz, mono, signed 16-bit little-endian PCM. A caller opens one
//! utterance, writes bounded chunks, and can interrupt it immediately by dropping
//! the writer or calling `stop`.

use std::io::{self, Write};
use std::process::{Child, ChildStdin, Command, Stdio};

/// Format used by the existing Microduck synth path.
pub const SPEECH_SAMPLE_RATE: u32 = sounds::SR;
pub const SPEECH_CHANNELS: u8 = 1;

/// One live speech utterance.
///
/// The child is kept here so interruption kills `aplay` and releases the exclusive
/// codec PCM. The stdin pipe is intentionally not cloneable: there is exactly one
/// producer for an utterance.
pub struct SpeechPlayback {
    child: Child,
    stdin: Option<ChildStdin>,
}

impl SpeechPlayback {
    /// Open the robot speaker for raw conversational PCM.
    ///
    /// `device` is the same ALSA device string robotd already uses for its voice.
    pub fn open(device: &str) -> io::Result<Self> {
        let mut child = Command::new("aplay")
            .args([
                "-q",
                "-D",
                device,
                "-t",
                "raw",
                "-f",
                "S16_LE",
                "-c",
                "1",
                "-r",
                &SPEECH_SAMPLE_RATE.to_string(),
                // Keep queued audio short so barge-in feels immediate.
                "--buffer-time=40000",
                "--period-time=10000",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("aplay did not expose stdin"))?;

        Ok(Self {
            child,
            stdin: Some(stdin),
        })
    }

    /// Feed one bounded chunk of S16LE mono PCM.
    ///
    /// An odd byte count cannot contain complete 16-bit samples and is rejected.
    pub fn write_pcm(&mut self, pcm: &[u8]) -> io::Result<()> {
        if pcm.len() % 2 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "speech PCM must contain complete 16-bit samples",
            ));
        }
        match self.stdin.as_mut() {
            Some(stdin) => stdin.write_all(pcm),
            None => Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "speech playback is closed",
            )),
        }
    }

    /// Finish naturally: close stdin and let `aplay` drain the tiny ALSA buffer.
    pub fn finish(mut self) -> io::Result<()> {
        self.stdin.take();
        let _ = self.child.wait()?;
        Ok(())
    }

    /// Barge-in / cancellation: stop playback now and release the PCM.
    pub fn stop(&mut self) {
        self.stdin.take();
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

impl Drop for SpeechPlayback {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_format_matches_microduck_synth() {
        assert_eq!(SPEECH_SAMPLE_RATE, sounds::SR);
        assert_eq!(SPEECH_CHANNELS, 1);
    }
}
