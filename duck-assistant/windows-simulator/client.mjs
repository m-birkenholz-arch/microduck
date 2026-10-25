// Browser audio uses WebRTC; the local helper handles SDP and Google lookup.
import { cameraStatusTool } from './face-local.mjs';
import { companionInstructions, memoryTools, memoryHandlers } from './companion.mjs';
import { SearchTools } from './search-tools.mjs';
import { createDuckVoice } from './voice.mjs';
import { AnswerGestureCue } from './gestures.mjs';

export class DuckConversation {
  constructor({ onStatus = () => {}, onText = () => {}, onLevel = () => {}, onPhase = () => {}, onGesture = () => {}, onSearchReady = () => {}, onSearchResult = () => {},
    companionStore, cameraStatus, onMemoryChanged = () => {},
    mediaDevices = globalThis.navigator?.mediaDevices,
    makePeer = () => new RTCPeerConnection(),
    makeAudio = () => new Audio(),
    makeContext = () => new AudioContext(),
    makeVoice = createDuckVoice,
    // Window.fetch checks its receiver; calling a stored bare fetch as a method
    // of DuckConversation throws Illegal invocation before making any request.
    fetchImpl = (...args) => globalThis.fetch(...args),
  } = {}) {
    Object.assign(this, { onStatus, onText, onLevel, onPhase, mediaDevices, makePeer, makeAudio, makeContext, makeVoice, fetchImpl, onSearchReady, onSearchResult, companionStore, cameraStatus, onMemoryChanged });
    this.generation = 0;
    this.voicePitch = companionStore?.preferences.pitch ?? 0;
    this.volume = companionStore?.preferences.volume ?? 1;
    this.gestureCue = new AnswerGestureCue(onGesture);
  }

  async start({ initialText, initialImage } = {}) {
    const primed = this.primedContext;
    this.primedContext = null;
    this.stop();
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.onStatus('Verbinden…', true);
    this.onPhase('connecting');
    const controller = this.controller = new AbortController();
    let phase = 'audio';
    try {
      // Resume audio in the button's user gesture so autoplay does not block it.
      const context = this.context = primed || this.makeContext();
      await context.resume();
      if (!current()) return;
      const voice = await this.makeVoice(context, this.voicePitch);
      if (!current()) { voice.close(); return; }
      this.voice = voice;
      voice.setVolume?.(this.volume);
      voice.input.onprocessorerror = () => { if (current()) this.fail('Eendenstem gestopt. Stop en start het gesprek opnieuw.'); };
      phase = 'helper';
      const health = await this.fetchImpl('http://127.0.0.1:8787/health', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      });
      if (!health.ok) throw new Error(await health.text());
      const capabilities = await health.json();
      this.onSearchReady(Boolean(capabilities.googleSearch));
      this.baseInstructions = capabilities.instructions;
      this.baseTools = capabilities.tools || [];
      if (this.companionStore && capabilities.companionVersion !== 1) throw new Error('Werk de gesprekshulp bij en start start.ps1 opnieuw voor naam en geheugen.');
      if (!capabilities.ready) throw new Error('Vul je API-key in het PowerShell-venster in.');
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
      this.searchTools = new SearchTools({
        extraTools: { ...(this.companionStore ? memoryHandlers(this.companionStore, () => this.onMemoryChanged()) : {}),
          ...(this.cameraStatus ? { get_camera_status: () => this.cameraStatus() } : {}) },
        send: event => { if (current() && channel.readyState === 'open') channel.send(JSON.stringify(event)); },
        search: async (query, signal) => {
          const response = await this.fetchImpl('http://127.0.0.1:8787/search', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
            signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(35000)]),
          });
          if (!response.ok) throw new Error(await response.text());
          return response.json();
        },
        onState: () => { if (current()) { this.onPhase('thinking'); this.onStatus('Ik zoek het op met Google…', true); } },
        onResult: result => { if (current()) this.onSearchResult(result); },
      });
      channel.onmessage = event => {
        if (!current()) return;
        try { this.handleEvent(JSON.parse(event.data)); } catch { /* Ignore non-JSON transport messages. */ }
      };
      channel.onopen = () => {
        if (current()) {
          // Choose before any output audio, including when an older helper is
          // still running. A browser-only update need not ask for the key again.
          channel.send(JSON.stringify({ type: 'session.update', session: {
            type: 'realtime', audio: { output: { voice: 'marin' } },
            ...this.personalization(),
          } }));
          this.onPhase('listening'); this.onStatus('Verbonden — praat maar', true);
          if (initialText || initialImage) {
            try { this.ask(initialText || 'Wat zie je op deze foto?', initialImage); }
            catch (error) { this.fail(error.message); }
          }
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
    this.searchTools?.handleEvent(event);
  }

  personalization() {
    if (!this.companionStore || !this.baseInstructions) return {};
    const store = this.companionStore;
    return { instructions: this.baseInstructions + companionInstructions(store.preferences, store.memories),
      tools: [...this.baseTools, ...(store.preferences.memoryEnabled ? memoryTools : []), ...(this.cameraStatus ? [cameraStatusTool] : [])], tool_choice: 'auto' };
  }

  updatePersonalization() {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', ...this.personalization() } }));
  }

  async primeAudio() {
    if (this.primedContext) return;
    const context = this.makeContext(), generation = this.generation;
    try { await context.resume(); if (generation !== this.generation) { await context.close().catch(() => {}); return; } this.primedContext = context; }
    catch (error) { await context.close().catch(() => {}); throw error; }
  }

  ask(text, image) {
    if (this.channel?.readyState !== 'open') throw new Error('Start eerst een gesprek.');
    if (image && (!/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 48000)) throw new Error('Foto te groot of ongeldig.');
    const content = [{ type: 'input_text', text: String(text).slice(0, 2000) }];
    if (image) content.push({ type: 'input_image', image_url: image });
    this.channel.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content } }));
    this.channel.send(JSON.stringify({ type: 'response.create' }));
  }

  setVolume(value) {
    this.volume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
    this.voice?.setVolume?.(this.volume);
  }

  setVoicePitch(value) {
    this.voicePitch = Number.isFinite(value) ? Math.max(0, Math.min(9, value)) : 0;
    this.voice?.setPitch(this.voicePitch);
  }

  fail(message) { this.stop(); this.onStatus(message, false); }

  stop() {
    this.generation++;
    this.gestureCue.reset();
    this.searchTools?.cancel(true);
    this.searchTools = null;
    this.onSearchResult(null);
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
    this.primedContext?.close().catch(() => {});
    this.primedContext = null;
    this.controller = this.channel = this.peer = this.stream = this.audio = this.context = this.source = null;
    this.onLevel(0);
    this.onPhase('off');
    this.onStatus('Gesprek gestopt', false);
  }
}
