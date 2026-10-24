//! Microduck microphone capture for the realtime assistant.
//!
//! The shipped robot audio path captures from ALSA. Keep capture outside robotd's
//! 50 Hz loop: `arecord` produces 48 kHz mono S16LE and this module downsamples it
//! to the 24 kHz PCM expected by the realtime session.

use std::process::Stdio;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::audio::ROBOT_RATE;
const CAPTURE_BYTES: usize = 3_840; // 40 ms at 48 kHz mono S16LE.

pub struct Microphone {
    child: Child,
    rx: mpsc::Receiver<Result<Vec<u8>>>,
    capture_task: tokio::task::JoinHandle<()>,
}

impl Microphone {
    pub fn open(device: &str) -> Result<Self> {
        let mut child = Command::new("arecord")
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
                &ROBOT_RATE.to_string(),
            ])
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("kan arecord niet starten op {device}"))?;
        let stdout = child.stdout.take().context("arecord heeft geen stdout")?;
        let (tx, rx) = mpsc::channel(8);

        let capture_task = tokio::spawn(capture_frames(stdout, tx));

        Ok(Self {
            child,
            rx,
            capture_task,
        })
    }

    pub async fn next_frame(&mut self) -> Option<Result<Vec<u8>>> {
        self.rx.recv().await
    }
}

impl Drop for Microphone {
    fn drop(&mut self) {
        self.capture_task.abort();
        let _ = self.child.start_kill();
    }
}

async fn capture_frames(mut source: impl AsyncRead + Unpin, tx: mpsc::Sender<Result<Vec<u8>>>) {
    let mut buf = vec![0u8; CAPTURE_BYTES];
    loop {
        // A pipe read can end on any byte. Assemble a complete frame before
        // resampling so neither half-samples nor sample pairs are discarded.
        let frame = match source.read_exact(&mut buf).await {
            Ok(_) => downsample_48_to_24(&buf),
            Err(error) => {
                let _ = tx
                    .send(Err(error).context("microfoonstream lezen mislukt"))
                    .await;
                break;
            }
        };
        if tx.send(frame).await.is_err() {
            break;
        }
    }
}

/// 48 -> 24 kHz by averaging each adjacent pair. The small low-pass effect is
/// preferable to simply throwing every other sample away and is enough for speech/STT.
fn downsample_48_to_24(input: &[u8]) -> Result<Vec<u8>> {
    if !input.len().is_multiple_of(4) {
        bail!("microfoon PCM bevat een onvolledig samplepaar");
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

    #[tokio::test]
    async fn fragmented_capture_keeps_samples_across_frames_and_reports_eof() {
        use tokio::io::AsyncWriteExt;

        // A one-byte pipe splits every sample; two frames catch boundary loss.
        let (mut writer, reader) = tokio::io::duplex(1);
        let (tx, mut rx) = mpsc::channel(8);
        let capture = tokio::spawn(capture_frames(reader, tx));
        let bytes: Vec<u8> = (0..CAPTURE_BYTES as i16)
            .flat_map(i16::to_le_bytes)
            .collect();
        let expected = downsample_48_to_24(&bytes).unwrap();
        let write = tokio::spawn(async move {
            writer.write_all(&bytes).await.unwrap();
        });
        let mut output = Vec::new();
        for _ in 0..2 {
            let frame = rx.recv().await.unwrap().unwrap();
            assert_eq!(frame.len(), CAPTURE_BYTES / 2);
            output.extend(frame);
        }
        assert_eq!(output, expected);
        assert!(rx.recv().await.unwrap().is_err());
        assert!(rx.recv().await.is_none());
        write.await.unwrap();
        capture.await.unwrap();
    }

    #[test]
    fn rejects_incomplete_pairs() {
        for len in [1, 2, 3, 5, 6, 7] {
            assert!(downsample_48_to_24(&vec![0; len]).is_err());
        }
    }

    #[test]
    fn averages_without_overflow() {
        let bytes: Vec<u8> = [i16::MAX, i16::MAX, i16::MIN, i16::MIN]
            .into_iter()
            .flat_map(i16::to_le_bytes)
            .collect();
        assert_eq!(
            downsample_48_to_24(&bytes).unwrap(),
            [i16::MAX, i16::MIN]
                .into_iter()
                .flat_map(i16::to_le_bytes)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn halves_sample_count() {
        assert_eq!(ROBOT_RATE / 2, crate::audio::OPENAI_RATE);
        let input = [0i16, 1000, -1000, 1000];
        let bytes: Vec<u8> = input.into_iter().flat_map(i16::to_le_bytes).collect();
        let out = downsample_48_to_24(&bytes).unwrap();
        assert_eq!(out.len(), bytes.len() / 2);
        assert_eq!(
            out,
            [500i16, 0]
                .into_iter()
                .flat_map(i16::to_le_bytes)
                .collect::<Vec<_>>()
        );
    }
}
