// Browser audio uses WebRTC; the helper only exchanges SDP with OpenAI.
export class DuckConversation {
  constructor({ onStatus = () => {}, onText = () => {}, onLevel = () => {},
    mediaDevices = globalThis.navigator?.mediaDevices,
    makePeer = () => new RTCPeerConnection(),
    makeAudio = () => new Audio(),
    makeContext = () => new AudioContext(),
    fetchImpl = globalThis.fetch,
  } = {}) {
    Object.assign(this, { onStatus, onText, onLevel, mediaDevices, makePeer, makeAudio, makeContext, fetchImpl });
    this.generation = 0;
  }

  async start() {
    this.stop();
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.onStatus('Verbinden…', true);
    const controller = this.controller = new AbortController();
    try {
      // Resume audio in the button's user gesture so autoplay does not block it.
      const context = this.context = this.makeContext();
      await context.resume();
      if (!current()) return;
      const health = await this.fetchImpl('http://127.0.0.1:8787/health', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      });
      if (!health.ok) throw new Error(await health.text());
      if (!(await health.json()).ready) throw new Error('Vul je API-key in het PowerShell-venster in.');
      if (!this.mediaDevices?.getUserMedia) throw new Error('Open de simulator op http://localhost:5173 in Chrome of Edge.');
      const stream = await this.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      // Stop can be clicked while the browser permission dialog is still open.
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const peer = this.peer = this.makePeer();
      const audio = this.audio = this.makeAudio();
      audio.autoplay = true;
      peer.ontrack = async event => {
        if (!current()) return;
        const remote = event.streams[0];
        audio.srcObject = remote;
        try {
          await audio.play();
          if (!current()) return;
          const analyser = this.analyser = context.createAnalyser();
          analyser.fftSize = 256;
          this.source = context.createMediaStreamSource(remote);
          this.source.connect(analyser);
          const samples = new Float32Array(analyser.fftSize);
          this.meter = setInterval(() => {
            analyser.getFloatTimeDomainData(samples);
            const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
            this.onLevel(audio.muted ? 0 : Math.min(1, rms * 7));
          }, 40);
        } catch {
          if (current()) this.fail('Geluidsweergave is geblokkeerd. Stop en start het gesprek opnieuw.');
        }
      };
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const channel = this.channel = peer.createDataChannel('oai-events');
      channel.onmessage = event => {
        if (!current()) return;
        try { this.handleEvent(JSON.parse(event.data)); } catch { /* Ignore non-JSON transport messages. */ }
      };
      channel.onopen = () => { if (current()) this.onStatus('Verbonden — praat maar', true); };
      channel.onclose = () => { if (current()) this.fail('De gespreksverbinding is gesloten. Je kunt opnieuw starten.'); };
      peer.onconnectionstatechange = () => {
        if (current() && ['failed', 'closed'].includes(peer.connectionState)) {
          this.fail('De audioverbinding is verbroken. Je kunt opnieuw starten.');
        }
      };
      const offer = await peer.createOffer();
      if (!current()) return;
      await peer.setLocalDescription(offer);
      const response = await this.fetchImpl('http://127.0.0.1:8787/session', {
        method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer.sdp,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
      });
      if (!response.ok) throw new Error(await response.text());
      const answer = await response.text();
      if (!current()) return;
      await peer.setRemoteDescription({ type: 'answer', sdp: answer });
      if (!current()) return;
      this.connectionTimer = setTimeout(() => {
        if (current() && channel.readyState !== 'open') this.fail('WebRTC kon niet verbinden. Controleer je netwerk of VPN en probeer opnieuw.');
      }, 20000);
    } catch (error) {
      if (current()) {
        const message = error.name === 'NotAllowedError'
          ? 'Microfoon geweigerd. Geef Chrome of Edge microfoontoegang en start opnieuw.'
          : error.name === 'NotFoundError' ? 'Geen microfoon gevonden. Sluit een microfoon aan.'
          : error instanceof TypeError ? 'Gesprekshulp niet bereikbaar. Laat start.ps1 openstaan op je laptop.'
          : error.message;
        this.fail(message);
      }
    }
  }

  handleEvent(event) {
    if (event.type === 'input_audio_buffer.speech_started') {
      // WebRTC's server buffer is interrupted by VAD; mute locally immediately.
      this.audio.muted = true;
      this.onLevel(0);
      this.onStatus('Ik luister…', true);
    } else if (event.type === 'output_audio_buffer.started') {
      this.audio.muted = false;
      this.onStatus('Microduck spreekt…', true);
    } else if (['output_audio_buffer.stopped', 'output_audio_buffer.cleared'].includes(event.type)) {
      this.onLevel(0);
      this.onStatus('Verbonden — praat maar', true);
    } else if (event.type === 'response.output_audio_transcript.done') {
      this.onText(event.transcript || '');
    } else if (event.type === 'error') {
      this.fail(event.error?.message || 'OpenAI meldt een fout.');
    }
  }

  fail(message) { this.stop(); this.onStatus(message, false); }

  stop() {
    this.generation++;
    this.controller?.abort();
    clearInterval(this.meter);
    clearTimeout(this.connectionTimer);
    if (this.channel) { this.channel.onclose = null; this.channel.onmessage = null; this.channel.onopen = null; this.channel.close(); }
    if (this.peer) { this.peer.onconnectionstatechange = null; this.peer.ontrack = null; this.peer.close(); }
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    this.source?.disconnect();
    this.context?.close().catch(() => {});
    this.controller = this.channel = this.peer = this.stream = this.audio = this.context = this.source = null;
    this.onLevel(0);
    this.onStatus('Gesprek gestopt', false);
  }
}
