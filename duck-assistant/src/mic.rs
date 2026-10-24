//! Microduck microphone capture for the realtime assistant.
//!
//! The shipped robot audio path captures from ALSA. Keep capture outside robotd's
//! 50 Hz loop: `arecord` produces 48 kHz mono S16LE and this module downsamples it
//! to the 24 kHz PCM expected by the realtime session.

use std::process::Stdio;

use anyhow::{Context, Result, bail};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

const ROBOT_RATE: u32 = 48_000;
const REALTIME_RATE: u32 = 24_000;
const CAPTURE_BYTES: usize = 3_840; // 40 ms at 48 kHz mono S16LE.

pub struct Microphone {
    child: Child,
    rx: mpsc::Receiver<Result<Vec<u8>>>,
}

impl Microphone {
    pub fn open(device: &str) -> Result<Self> {
        let mut child = Command::new("arecord")
            .args([
                "-q", "-D", device,
                "-t", "raw", "-f", "S16_LE", "-c", "1", "-r", &ROBOT_RATE.to_string(),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("kan arecord niet starten op {device}"))?;
        let mut stdout = child.stdout.take().context("arecord heeft geen stdout")?;
        let (tx, rx) = mpsc::channel(8);

        tokio::spawn(async move {
            let mut buf = vec![0u8; CAPTURE_BYTES];
            loop {
                match stdout.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let n = n & !1; // only complete i16 samples
                        if n == 0 { continue; }
                        let frame = downsample_48_to_24(&buf[..n]);
                        if tx.send(frame).await.is_err() { break; }
                    }
                    Err(error) => {
                        let _ = tx.send(Err(error.into())).await;
                        break;
                    }
                }
            }
        });

        Ok(Self { child, rx })
    }

    pub async fn next_frame(&mut self) -> Option<Result<Vec<u8>>> {
        self.rx.recv().await
    }
}

impl Drop for Microphone {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

/// 48 -> 24 kHz by averaging each adjacent pair. The small low-pass effect is
/// preferable to simply throwing every other sample away and is enough for speech/STT.
fn downsample_48_to_24(input: &[u8]) -> Result<Vec<u8>> {
    if input.len() % 2 != 0 {
        bail!("microfoon PCM bevat een onvolledige 16-bit sample");
    }
    let samples: Vec<i16> = input
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect();
    let mut out = Vec::with_capacity((samples.len() / 2) * 2);
    for pair in samples.chunks_exact(2) {
        let mixed = ((pair[0] as i32 + pair[1] as i32) / 2) as i16;
        out.extend_from_slice(&mixed.to_le_bytes());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halves_sample_count() {
        assert_eq!(ROBOT_RATE / 2, REALTIME_RATE);
        let input = [0i16, 1000, -1000, 1000];
        let bytes: Vec<u8> = input.into_iter().flat_map(i16::to_le_bytes).collect();
        let out = downsample_48_to_24(&bytes).unwrap();
        assert_eq!(out.len(), bytes.len() / 2);
    }
}
