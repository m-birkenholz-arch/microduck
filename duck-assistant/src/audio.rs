//! Audio adaptation between OpenAI Realtime and robotd.
//!
//! Realtime PCM is signed 16-bit mono little-endian at 24 kHz. robotd's existing
//! speech playback contract is signed 16-bit mono little-endian at 48 kHz.
//! A 2x linear interpolator is enough for the first hardware milestone and keeps
//! the transport deterministic and dependency-free.

use anyhow::{Result, bail};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;

pub const OPENAI_RATE: u32 = 24_000;
pub const ROBOT_RATE: u32 = 48_000;

/// Resample complete PCM16LE samples from 24 kHz to 48 kHz.
///
/// Every source interval produces the original sample plus a midpoint. The final
/// source sample is duplicated so each input sample corresponds to two output
/// samples. This is intentionally simple; later voice-character DSP can replace
/// it without changing the robotd transport.
pub fn pcm24_to_pcm48(input: &[u8]) -> Result<Vec<u8>> {
    if !input.len().is_multiple_of(2) {
        bail!("OpenAI PCM bevat een onvolledige 16-bit sample");
    }
    let samples: Vec<i16> = input
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    let mut out = Vec::with_capacity(input.len() * 2);
    for pair in samples.windows(2) {
        let a = pair[0];
        let b = pair[1];
        out.extend_from_slice(&a.to_le_bytes());
        let mid = ((a as i32 + b as i32) / 2) as i16;
        out.extend_from_slice(&mid.to_le_bytes());
    }
    let last = *samples.last().unwrap();
    out.extend_from_slice(&last.to_le_bytes());
    out.extend_from_slice(&last.to_le_bytes());
    Ok(out)
}

/// Tiny framed protocol to robotd's conversation socket.
///
/// Frame: one command byte followed, for DATA, by a u32 LE byte length and payload.
/// OPEN=1, DATA=2, FINISH=3, STOP=4.
pub struct RobotAudio {
    stream: UnixStream,
    opened: bool,
}

impl RobotAudio {
    pub async fn connect(path: &str) -> Result<Self> {
        Ok(Self {
            stream: UnixStream::connect(path).await?,
            opened: false,
        })
    }

    pub async fn open(&mut self) -> Result<()> {
        if !self.opened {
            self.stream.write_all(&[1]).await?;
            self.opened = true;
        }
        Ok(())
    }

    pub async fn write_24k(&mut self, pcm: &[u8]) -> Result<()> {
        self.open().await?;
        let pcm48 = pcm24_to_pcm48(pcm)?;
        self.stream.write_all(&[2]).await?;
        self.stream
            .write_all(&(pcm48.len() as u32).to_le_bytes())
            .await?;
        self.stream.write_all(&pcm48).await?;
        Ok(())
    }

    pub async fn finish(&mut self) -> Result<()> {
        if self.opened {
            self.stream.write_all(&[3]).await?;
            self.opened = false;
        }
        Ok(())
    }

    pub async fn stop(&mut self) -> Result<()> {
        self.stream.write_all(&[4]).await?;
        self.opened = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles_sample_count() {
        let input = [0i16, 1000, -1000];
        let bytes: Vec<u8> = input.into_iter().flat_map(i16::to_le_bytes).collect();
        let out = pcm24_to_pcm48(&bytes).unwrap();
        assert_eq!(out.len(), bytes.len() * 2);
    }
}
