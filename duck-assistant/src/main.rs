//! Microduck <-> OpenAI realtime conversation bridge.
//!
//! This first slice proves the cloud/session half of the path. Hardware capture/playback
//! is deliberately kept behind the next audio bridge step so robotd remains the sole owner
//! of the codec.

use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::{connect_async, tungstenite::{client::IntoClientRequest, Message}};

const DEFAULT_MODEL: &str = "gpt-realtime-2.1";
const REALTIME_URL: &str = "wss://api.openai.com/v1/realtime";

#[tokio::main]
async fn main() -> Result<()> {
    let api_key = std::env::var("OPENAI_API_KEY")
        .context("OPENAI_API_KEY is niet ingesteld")?;
    let model = std::env::var("DUCK_OPENAI_MODEL")
        .unwrap_or_else(|_| DEFAULT_MODEL.to_owned());

    let url = format!("{REALTIME_URL}?model={model}");
    let mut request = url.into_client_request()?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {api_key}").parse()?,
    );

    let (socket, _) = connect_async(request)
        .await
        .context("kan geen realtime verbinding met OpenAI maken")?;
    let (mut tx, mut rx) = socket.split();

    // Dutch by default, but the duck may naturally follow the user into another language.
    // We ask for PCM16 so the next bridge can resample deterministically to robotd's 48 kHz.
    tx.send(Message::Text(json!({
        "type": "session.update",
        "session": {
            "type": "realtime",
            "instructions": concat!(
                "Je bent de gesprekspersoon van Microduck, een kleine fysieke robot. ",
                "Praat standaard natuurlijk Nederlands, tenzij de gebruiker duidelijk een andere taal kiest. ",
                "Voer een echt doorlopend gesprek: onthoud de context binnen de sessie, ",
                "antwoord compact en spreekbaar, en doe niet alsof je een tekstchat bent. ",
                "Noem jezelf niet ChatGPT tenzij de gebruiker daar expliciet naar vraagt."
            ),
            "audio": {
                "input": {
                    "format": { "type": "audio/pcm", "rate": 24000 },
                    "turn_detection": {
                        "type": "server_vad",
                        "create_response": true,
                        "interrupt_response": true
                    }
                },
                "output": {
                    "format": { "type": "audio/pcm", "rate": 24000 },
                    "voice": "marin"
                }
            }
        }
    }).to_string().into())).await?;

    println!("duck-assistant: realtime sessie verbonden ({model}); Nederlands is standaard");

    while let Some(message) = rx.next().await {
        let message = message?;
        let Message::Text(text) = message else { continue };
        let event: Value = serde_json::from_str(&text)?;
        match event.get("type").and_then(Value::as_str) {
            Some("session.updated") => println!("duck-assistant: sessie gereed"),
            Some("input_audio_buffer.speech_started") => {
                println!("duck-assistant: gebruiker praat — playback moet nu stoppen");
            }
            Some("response.output_audio.delta") => {
                // Next milestone: decode `delta`, resample 24 -> 48 kHz, and stream it to
                // robotd::conversation_audio. Keeping this TODO explicit prevents accidental
                // direct access to the exclusive ALSA device from this process.
            }
            Some("error") => bail!("OpenAI realtime fout: {event}"),
            _ => {}
        }
    }

    Ok(())
}
