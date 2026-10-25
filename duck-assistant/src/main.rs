//! Microduck <-> OpenAI realtime conversation bridge.

mod audio;
mod mic;

use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

use audio::RobotAudio;
use mic::Microphone;

const DEFAULT_MIC_DEVICE: &str = "plughw:aic3104,0";
const DEFAULT_MODEL: &str = "gpt-realtime-2.1";
const REALTIME_URL: &str = "wss://api.openai.com/v1/realtime";
const DEFAULT_ROBOT_AUDIO_SOCKET: &str = "/run/robotd-conversation.sock";

#[tokio::main]
async fn main() -> Result<()> {
    let api_key = std::env::var("OPENAI_API_KEY").context("OPENAI_API_KEY is niet ingesteld")?;
    let model = std::env::var("DUCK_OPENAI_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_owned());
    let audio_socket = std::env::var("DUCK_ROBOT_AUDIO_SOCKET")
        .unwrap_or_else(|_| DEFAULT_ROBOT_AUDIO_SOCKET.to_owned());

    let mic_device =
        std::env::var("DUCK_MIC_DEVICE").unwrap_or_else(|_| DEFAULT_MIC_DEVICE.to_owned());

    let mut robot_audio = RobotAudio::connect(&audio_socket)
        .await
        .with_context(|| format!("kan robot-audio socket {audio_socket} niet openen"))?;

    let url = format!("{REALTIME_URL}?model={model}");
    let mut request = url.into_client_request()?;
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {api_key}").parse()?);

    let (socket, _) = connect_async(request)
        .await
        .context("kan geen realtime verbinding met OpenAI maken")?;
    let (mut tx, mut rx) = socket.split();

    tx.send(Message::Text(json!({
        "type": "session.update",
        "session": {
            "type": "realtime",
            "instructions": concat!(
                "Je bent de gesprekspersoon van Microduck, een kleine fysieke robot. ",
                "Praat standaard natuurlijk Nederlands, tenzij de gebruiker duidelijk een andere taal kiest. ",
                "Voer een echt doorlopend gesprek: onthoud de context binnen de sessie, ",
                "antwoord compact en spreekbaar, en doe niet alsof je een tekstchat bent. ",
                "Noem jezelf niet ChatGPT tenzij de gebruiker daar expliciet naar vraagt. ",
                "Je bent een warme, zorgzame moeder-eend. ",
                "Spreek met een natuurlijke vrouwelijke stem in een comfortabel middenregister, ",
                "rond en zacht van klank, met een rustig tempo en kleine pauzes tussen uitlegstappen. ",
                "Klink geduldig, geruststellend en betrokken. ",
                "Houd deze warme stem ook bij langere antwoorden vast."
            ),
            "audio": {
                "input": {
                    "format": { "type": "audio/pcm", "rate": audio::OPENAI_RATE },
                    "noise_reduction": { "type": "far_field" },
                    "turn_detection": {
                        "type": "server_vad",
                        "create_response": true,
                        "interrupt_response": true,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 450
                    }
                },
                "output": {
                    "format": { "type": "audio/pcm", "rate": audio::OPENAI_RATE },
                    "voice": "marin"
                }
            }
        }
    }).to_string().into())).await?;

    println!("duck-assistant: realtime verbonden ({model}); Nederlands is standaard");

    let mut microphone = Microphone::open(&mic_device)?;
    // Keep uploading while RobotAudio is awaiting playback writes. The bounded
    // capture channel applies backpressure without buffering an entire conversation.
    let mut input_task = tokio::spawn(async move {
        while let Some(frame) = microphone.next_frame().await {
            let pcm24 = frame?;
            tx.send(Message::Text(
                json!({
                    "type": "input_audio_buffer.append",
                    "audio": STANDARD.encode(&pcm24),
                })
                .to_string()
                .into(),
            ))
            .await?;
        }
        bail!("microfoonstream is gestopt")
    });

    let result: Result<()> = async {
        loop {
            let message = tokio::select! {
                result = &mut input_task => {
                    return result.context("microfoontaak is gestopt")?;
                }
                message = rx.next() => match message {
                    Some(message) => message?,
                    None => break,
                },
                signal = tokio::signal::ctrl_c() => {
                    signal?;
                    break;
                }
            };
            let Message::Text(text) = message else {
                continue;
            };
            let event: Value = serde_json::from_str(&text)?;
            match event.get("type").and_then(Value::as_str) {
                Some("session.updated") => println!("duck-assistant: sessie gereed"),
                Some("input_audio_buffer.speech_started") => {
                    // Barge-in: the user gets the floor immediately.
                    robot_audio.stop().await?;
                }
                Some("response.output_audio.delta") => {
                    let delta = event
                        .get("delta")
                        .and_then(Value::as_str)
                        .context("audio delta zonder delta-data")?;
                    let pcm24 = STANDARD
                        .decode(delta)
                        .context("ongeldige base64 audio van OpenAI")?;
                    robot_audio.write_24k(&pcm24).await?;
                }
                Some("response.output_audio.done") | Some("response.done") => {
                    robot_audio.finish().await?;
                }
                Some("error") => bail!("OpenAI realtime fout: {event}"),
                _ => {}
            }
        }

        Ok(())
    }
    .await;

    input_task.abort();
    let _ = robot_audio.stop().await;
    result
}
