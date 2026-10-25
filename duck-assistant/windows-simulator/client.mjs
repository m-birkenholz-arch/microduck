// Browser audio uses WebRTC; the helper only exchanges SDP with OpenAI.
import { createDuckVoice } from './voice.mjs';
import { AnswerGestureCue } from './gestures.mjs';

export class DuckConversation {
  constructor({ onStatus = () => {}, onText = () => {}, onLevel = () => {}, onPhase = () => {}, onGesture = () => {},
    mediaDevices = globalThis.navigator?.mediaDevices,
    makePeer = () => new RTCPeerConnection(),
    makeAudio = () => new Audio(),
    makeContext = () => new AudioContext(),
    makeVoice = createDuckVoice,
    // Window.fetch checks its receiver; calling a stored bare fetch as a method
    // of DuckConversation throws Illegal invocation before making any request.
    fetchImpl = (...args) => globalThis.fetch(...args),
  } = {}) {
    Object.assign(this, { onStatus, onText, onLevel, onPhase, mediaDevices, makePeer, makeAudio, makeContext, makeVoice, fetchImpl });
    this.generation = 0;
    this.voicePitch = 5;
    this.gestureCue = new AnswerGestureCue(onGesture);
  }

  async start() {
    this.stop();
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.onStatus('Verbinden…', true);
    this.onPhase('connecting');
    const controller = this.controller = new AbortController();
    let phase = 'audio';
    try {
      // Resume audio in the button's user gesture so autoplay does not block it.
      const context = this.context = this.makeContext();
      await context.resume();
      if (!current()) return;
      const voice = await this.makeVoice(context, this.voicePitch);
      if (!current()) { voice.close(); return; }
      this.voice = voice;
      voice.input.onprocessorerror = () => { if (current()) this.fail('Eendenstem gestopt. Stop en start het gesprek opnieuw.'); };
      phase = 'helper';
      const health = await this.fetchImpl('http://127.0.0.1:8787/health', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      });
      if (!health.ok) throw new Error(await health.text());
      if (!(await health.json()).ready) throw new Error('Vul je API-key in het PowerShell-venster in.');
      if (!this.mediaDevices?.getUserMedia) throw new Error('Open de simulator op http://localhost:5173 in Chrome of Edge.');
      phase = 'microphone';
      const stream = await this.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } });
      // Stop can be clicked while the browser permission dialog is still open.
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      phase = 'webrtc';
      const peer = this.peer = this.makePeer();
      const audio = this.audio = this.makeAudio();
      audio.autoplay = true;
      // Keep the WebRTC sink playing silently; only the processed graph is audible.
      audio.volume = 0;
      audio.muted = true;
      peer.ontrack = async event => {
        if (!current() || this.source) return;
        const remote = event.streams[0];
        audio.srcObject = remote;
        try {
          await audio.play();
          if (!current()) return;
          const analyser = this.analyser = context.createAnalyser();
          analyser.fftSize = 256;
          this.source = context.createMediaStreamSource(remote);
          this.source.connect(voice.input);
          voice.output.connect(analyser);
          analyser.connect(context.destination);
          const samples = new Float32Array(analyser.fftSize);
          this.meter = setInterval(() => {
            analyser.getFloatTimeDomainData(samples);
            const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
            const level = audio.muted ? 0 : Math.min(1, rms * 7);
            this.onLevel(level);
            this.gestureCue.setLevel(level);
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
      channel.onopen = () => {
        if (current()) {
          // Choose before any output audio, including when an older helper is
          // still running. A browser-only update need not ask for the key again.
          channel.send(JSON.stringify({ type: 'session.update', session: {
            type: 'realtime', audio: { output: { voice: 'shimmer' } },
          } }));
          this.onPhase('listening'); this.onStatus('Verbonden — praat maar', true);
        }
      };
      channel.onclose = () => { if (current()) this.fail('De gespreksverbinding is gesloten. Je kunt opnieuw starten.'); };
      peer.onconnectionstatechange = () => {
        if (current() && ['failed', 'closed'].includes(peer.connectionState)) {
          this.fail('De audioverbinding is verbroken. Je kunt opnieuw starten.');
        }
      };
      const offer = await peer.createOffer();
      if (!current()) return;
      await peer.setLocalDescription(offer);
      phase = 'helper';
      const response = await this.fetchImpl('http://127.0.0.1:8787/session', {
        method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer.sdp,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
      });
      if (!response.ok) throw new Error(await response.text());
      const answer = await response.text();
      if (!current()) return;
      phase = 'webrtc';
      await peer.setRemoteDescription({ type: 'answer', sdp: answer });
      if (!current()) return;
      this.connectionTimer = setTimeout(() => {
        if (current() && channel.readyState !== 'open') this.fail('WebRTC kon niet verbinden. Controleer je netwerk of VPN en probeer opnieuw.');
      }, 20000);
    } catch (error) {
      if (current()) {
        const message = error.name === 'NotAllowedError' && phase === 'microphone'
          ? 'Microfoon geweigerd. Geef Chrome of Edge microfoontoegang en start opnieuw.'
          : error.name === 'NotFoundError' ? 'Geen microfoon gevonden. Sluit een microfoon aan.'
          : error instanceof TypeError && phase === 'helper'
            ? `Gesprekshulp niet bereikbaar (${error.message}). Laat start.ps1 openstaan en gebruik http://localhost:5173.`
          : error.message;
        this.fail(message);
      }
    }
  }

  handleEvent(event) {
    if (event.type === 'input_audio_buffer.speech_started') {
      // WebRTC's server buffer is interrupted by VAD; mute locally immediately.
      this.audio.muted = true;
      this.voice?.setMuted(true);
      this.onLevel(0);
      this.onPhase('listening');
      this.onStatus('Ik luister…', true);
    } else if (event.type === 'input_audio_buffer.speech_stopped') {
      this.onPhase('thinking');
      this.onStatus('Even nadenken…', true);
    } else if (event.type === 'output_audio_buffer.started') {
      this.audio.muted = false;
      this.voice?.setMuted(false);
      this.onPhase('speaking');
      this.onStatus('Microduck spreekt…', true);
    } else if (['output_audio_buffer.stopped', 'output_audio_buffer.cleared'].includes(event.type)) {
      if (event.type === 'output_audio_buffer.cleared') { this.audio.muted = true; this.voice?.setMuted(true); }
      this.onLevel(0);
      this.onPhase('listening');
      this.onStatus('Verbonden — praat maar', true);
    } else if (event.type === 'response.output_audio_transcript.done') {
      this.onText(event.transcript || '');
    } else if (event.type === 'error') {
      this.fail(event.error?.message || 'OpenAI meldt een fout.');
    }
    this.gestureCue.handleEvent(event);
  }

  setVoicePitch(value) {
    this.voicePitch = Number.isFinite(value) ? Math.max(0, Math.min(9, value)) : 5;
    this.voice?.setPitch(this.voicePitch);
  }

  fail(message) { this.stop(); this.onStatus(message, false); }

  stop() {
    this.generation++;
    this.gestureCue.reset();
    this.controller?.abort();
    clearInterval(this.meter);
    clearTimeout(this.connectionTimer);
    if (this.channel) { this.channel.onclose = null; this.channel.onmessage = null; this.channel.onopen = null; this.channel.close(); }
    if (this.peer) { this.peer.onconnectionstatechange = null; this.peer.ontrack = null; this.peer.close(); }
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    this.source?.disconnect();
    this.voice?.close();
    this.analyser?.disconnect();
    this.voice = this.analyser = null;
    this.context?.close().catch(() => {});
    this.controller = this.channel = this.peer = this.stream = this.audio = this.context = this.source = null;
    this.onLevel(0);
    this.onPhase('off');
    this.onStatus('Gesprek gestopt', false);
  }
}
