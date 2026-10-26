const startButton = document.querySelector('#start');
const stopButton = document.querySelector('#stop');
const status = document.querySelector('#status');
const remoteAudio = document.querySelector('#remote');
let pc, stream, channel;
const setStatus = text => status.textContent = text;

async function stop() {
  channel?.close(); pc?.close(); stream?.getTracks().forEach(t => t.stop());
  channel = pc = stream = undefined; remoteAudio.srcObject = null;
  startButton.disabled = false; stopButton.disabled = true; setStatus('Gesprek gestopt.');
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true; setStatus('Microfoon openen…');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    pc = new RTCPeerConnection();
    stream.getTracks().forEach(track => pc.addTrack(track, stream));
    pc.ontrack = event => { remoteAudio.srcObject = event.streams[0]; };
    channel = pc.createDataChannel('oai-events');
    channel.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'session.started') { setStatus('Verbonden — praat maar tegen Microduck.'); stopButton.disabled = false; }
        else if (message.type === 'session.closed') setStatus('GPT-Live sessie gesloten.');
        else if (message.type === 'error') { console.error(message); setStatus('GPT-Live meldde een fout.'); }
      } catch (error) { console.error(error); }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const listener = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', listener); resolve(); } };
      pc.addEventListener('icegatheringstatechange', listener);
    });
    const response = await fetch('/session', { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
    if (!response.ok) throw new Error(await response.text());
    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    setStatus('Verbinden met GPT-Live…');
  } catch (error) { console.error(error); await stop(); setStatus(`Starten mislukt: ${error.message}`); }
});
stopButton.addEventListener('click', stop);
