//! Streaming conversational audio endpoint owned by `robotd`.
//!
//! PCM stays off the ordinary JSON-RPC socket. `duck-assistant` keeps one local Unix
//! connection and sends small framed commands; this module is the only side that opens
//! the physical playback device.

use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use tokio::io::AsyncReadExt;
use tokio::net::{UnixListener, UnixStream};

use crate::conversation_audio::SpeechPlayback;

pub const CMD_OPEN: u8 = 1;
pub const CMD_DATA: u8 = 2;
pub const CMD_FINISH: u8 = 3;
pub const CMD_STOP: u8 = 4;
const MAX_FRAME: usize = 256 * 1024;

enum AudioCommand {
    Open,
    Data(Vec<u8>),
    Finish,
    Stop,
}

/// Serve conversational playback until the task is cancelled.
pub async fn serve(path: PathBuf, device: String) -> io::Result<()> {
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    let listener = UnixListener::bind(&path)?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660))?;
    tracing::info!(path = %path.display(), "conversation audio socket ready");

    loop {
        let (stream, _) = listener.accept().await?;
        if let Err(error) = handle(stream, device.clone()).await {
            tracing::warn!(%error, "conversation audio client ended with an error");
        }
    }
}

async fn handle(mut stream: UnixStream, device: String) -> io::Result<()> {
    // The worker owns `SpeechPlayback`: blocking aplay writes never run on the async runtime.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<AudioCommand>(8);
    let worker = tokio::task::spawn_blocking(move || -> io::Result<()> {
        let mut playback: Option<SpeechPlayback> = None;
        while let Some(command) = rx.blocking_recv() {
            match command {
                AudioCommand::Open => {
                    if let Some(mut old) = playback.take() { old.stop(); }
                    playback = Some(SpeechPlayback::open(&device)?);
                }
                AudioCommand::Data(pcm) => {
                    let Some(active) = playback.as_mut() else {
                        return Err(io::Error::new(io::ErrorKind::InvalidData, "DATA before OPEN"));
                    };
                    active.write_pcm(&pcm)?;
                }
                AudioCommand::Finish => {
                    if let Some(active) = playback.take() { active.finish()?; }
                }
                AudioCommand::Stop => {
                    if let Some(mut active) = playback.take() { active.stop(); }
                }
            }
        }
        if let Some(mut active) = playback { active.stop(); }
        Ok(())
    });

    loop {
        let command = match stream.read_u8().await {
            Ok(command) => command,
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(error),
        };
        let message = match command {
            CMD_OPEN => AudioCommand::Open,
            CMD_FINISH => AudioCommand::Finish,
            CMD_STOP => AudioCommand::Stop,
            CMD_DATA => {
                let len = stream.read_u32_le().await? as usize;
                if len > MAX_FRAME || len % 2 != 0 {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid PCM frame length"));
                }
                let mut pcm = vec![0u8; len];
                stream.read_exact(&mut pcm).await?;
                AudioCommand::Data(pcm)
            }
            other => return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unknown conversation audio command {other:#04x}"),
            )),
        };
        if tx.send(message).await.is_err() { break; }
    }

    drop(tx);
    worker.await.map_err(io::Error::other)??;
    Ok(())
}

pub fn cleanup(path: &Path) {
    let _ = std::fs::remove_file(path);
}
