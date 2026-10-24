//! Streaming conversational audio endpoint owned by `robotd`.
//!
//! The ordinary JSON-RPC socket is intentionally not used for PCM. `duck-assistant`
//! connects here, sends a one-byte command followed by raw 48 kHz mono S16LE frames,
//! and `robotd` remains the process that opens the exclusive playback PCM.

use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use tokio::io::AsyncReadExt;
use tokio::net::{UnixListener, UnixStream};

use crate::conversation_audio::SpeechPlayback;

/// Protocol commands. A new PLAY connection supersedes the previous utterance.
pub const CMD_PLAY: u8 = 0x01;
pub const CMD_STOP: u8 = 0x02;

/// Serve conversational playback until the task is cancelled.
///
/// One connection is one utterance. Keeping the stream bounded this way gives disconnect
/// a useful meaning: EOF finishes naturally, while STOP (or a replacement PLAY) cuts now.
pub async fn serve(path: PathBuf, device: String) -> io::Result<()> {
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    let listener = UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660))?;
    tracing::info!(path = %path.display(), "conversation audio socket ready");

    loop {
        let (stream, _) = listener.accept().await?;
        let device = device.clone();
        if let Err(error) = handle(stream, &device).await {
            tracing::warn!(%error, "conversation audio client ended with an error");
        }
    }
}

async fn handle(mut stream: UnixStream, device: &str) -> io::Result<()> {
    let command = stream.read_u8().await?;
    match command {
        CMD_STOP => Ok(()),
        CMD_PLAY => play_stream(stream, device).await,
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown conversation audio command {other:#04x}"),
        )),
    }
}

async fn play_stream(mut stream: UnixStream, device: &str) -> io::Result<()> {
    // `aplay` and its stdin are blocking OS handles. All writes therefore live on a blocking
    // worker so a slow codec can never occupy robotd's async IPC runtime.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
    let device = device.to_owned();
    let worker = tokio::task::spawn_blocking(move || -> io::Result<()> {
        let mut playback = SpeechPlayback::open(&device)?;
        while let Some(chunk) = rx.blocking_recv() {
            playback.write_pcm(&chunk)?;
        }
        playback.finish()
    });

    let mut buf = vec![0u8; 3840]; // 40 ms at 48 kHz, mono S16LE.
    loop {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        // Preserve whole 16-bit samples. The assistant sends aligned chunks; rejecting a
        // broken client is safer than shifting every following sample by one byte.
        if n % 2 != 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "odd PCM byte count"));
        }
        if tx.send(buf[..n].to_vec()).await.is_err() {
            break;
        }
    }
    drop(tx);
    worker.await.map_err(io::Error::other)??;
    Ok(())
}

/// Remove the endpoint during orderly shutdown.
pub fn cleanup(path: &Path) {
    let _ = std::fs::remove_file(path);
}
