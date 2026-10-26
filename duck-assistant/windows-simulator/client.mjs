// Browser audio uses WebRTC; the local helper creates the GPT-Live session and handles delegated services.
import { speakerStatusTool } from './speaker-local.mjs';
import { visionTool } from './vision.mjs';
import { cameraStatusTool } from './face-local.mjs';
import { companionInstructions, memoryTools, memoryHandlers } from './companion.mjs';
import { SearchTools } from './search-tools.mjs';
import { createDuckVoice } from './voice.mjs';
import { AnswerGestureCue } from './gestures.mjs';

export class DuckConversation {
  constructor({ onStatus = () => {}, onText = () => {}, onLevel = () => {}, onPhase = () => {}, onGesture = () => {}, onSearchReady = () => {}, onSearchResult = () => {},
    companionStore, cameraStatus, speakerStatus, speakerEnabled, onMicrophone = () => {}, onMicrophoneStop = () => {}, captureImage, onVisionResult = () => {}, onSpeechActivity = () => {}, onMemoryChanged = () => {},
    mediaDevices = globalThis.navigator?.mediaDevices, makePeer = () => new RTCPeerConnection(), makeAudio = () => new Audio(), makeContext = () => new AudioContext(), makeVoice = createDuckVoice,
    fetchImpl = (...args) => globalThis.fetch(...args),
  } = {}) {
    Object.assign(this, { onStatus, onText, onLevel, onPhase, mediaDevices, makePeer, makeAudio, makeContext, makeVoice, fetchImpl, onSearchReady, onSearchResult, companionStore, cameraStatus, speakerStatus, speakerEnabled, onMicrophone, onMicrophoneStop, captureImage, onVisionResult, onSpeechActivity, onMemoryChanged });
    this.generation = 0; this.voicePitch = companionStore?.preferences.pitch ?? 0; this.volume = companionStore?.preferences.volume ?? 1; this.gestureCue = new AnswerGestureCue(onGesture);
  }

  send(event) { if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(event)); }

  async start({ initialText, initialImage } = {}) {
    const primed = this.primedContext; this.primedContext = null; this.stop();
    const generation = this.generation, current = () => generation === this.generation;
    this.onStatus('Verbinden met GPT-Live…', true); this.onPhase('connecting');
    const controller = this.controller = new AbortController(); let phase = 'audio';
    try {
      const context = this.context = primed || this.makeContext(); await context.resume(); if (!current()) return;
      const voice = await this.makeVoice(context, this.voicePitch); if (!current()) { voice.close(); return; }
      this.voice = voice; voice.setVolume?.(this.volume); voice.input.onprocessorerror = () => { if (current()) this.fail('Eendenstem gestopt. Stop en start het gesprek opnieuw.'); };
      phase = 'helper';
      const health = await this.fetchImpl('http://127.0.0.1:8787/health', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
      if (!health.ok) throw new Error(await health.text());
      const capabilities = await health.json(); this.onSearchReady(Boolean(capabilities.googleSearch)); this.visionReady = Boolean(capabilities.googleVision); this.speakerReady = Boolean(capabilities.speakerRecognition); this.baseInstructions = capabilities.instructions; this.baseTools = capabilities.tools || [];
      if (this.companionStore && capabilities.companionVersion !== 1) throw new Error('Werk de gesprekshulp bij en start start.ps1 opnieuw voor naam en geheugen.');
      if (!capabilities.ready) throw new Error('Vul je API-key in het PowerShell-venster in.');
      if (!this.mediaDevices?.getUserMedia) throw new Error('Open de simulator op http://localhost:5173 in Chrome of Edge.');
      phase = 'microphone';
      const stream = await this.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream; void this.onMicrophone(context, stream); phase = 'webrtc';
      const peer = this.peer = this.makePeer(), audio = this.audio = this.makeAudio(); audio.autoplay = true; audio.volume = 0; audio.muted = true;
      peer.ontrack = async event => {
        if (!current() || this.source) return; const remote = event.streams[0]; audio.srcObject = remote;
        try { await audio.play(); if (!current()) return; const analyser = this.analyser = context.createAnalyser(); analyser.fftSize = 256; this.source = context.createMediaStreamSource(remote); this.source.connect(voice.input); voice.output.connect(analyser); analyser.connect(context.destination);
          const samples = new Float32Array(analyser.fftSize); this.meter = setInterval(() => { analyser.getFloatTimeDomainData(samples); const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length); const level = audio.muted ? 0 : Math.min(1, rms * 7); this.onLevel(level); this.gestureCue.setLevel(level); }, 40);
        } catch { if (current()) this.fail('Geluidsweergave is geblokkeerd. Stop en start het gesprek opnieuw.'); }
      };
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const channel = this.channel = peer.createDataChannel('oai-events');
      this.searchTools = new SearchTools({
        extraTools: { ...(this.companionStore ? memoryHandlers(this.companionStore, () => this.onMemoryChanged()) : {}), ...(this.speakerReady && this.speakerStatus ? { get_speaker_status: () => this.speakerStatus() } : {}), ...(this.cameraStatus ? { get_camera_status: () => this.cameraStatus() } : {}), ...(this.visionReady && this.captureImage ? { analyze_camera: (args, signal) => this.analyzeCamera(args, signal) } : {}) },
        send: event => { if (current()) this.send(event); },
        search: async (query, signal) => { const response = await this.fetchImpl('http://127.0.0.1:8787/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(35000)]) }); if (!response.ok) throw new Error(await response.text()); return response.json(); },
        onState: () => { if (current()) { this.onPhase('thinking'); this.onStatus('Ik zoek het op…', true); } }, onResult: result => { if (current()) this.onSearchResult(result); },
      });
      channel.onmessage = event => { if (!current()) return; try { this.handleEvent(JSON.parse(event.data)); } catch {} };
      channel.onopen = () => { if (current()) { this.onStatus('GPT-Live verbonden — sessie starten…', true); } };
      channel.onclose = () => { if (current()) this.fail('De GPT-Live verbinding is gesloten. Je kunt opnieuw starten.'); };
      peer.onconnectionstatechange = () => { if (current() && ['failed', 'closed'].includes(peer.connectionState)) this.fail('De audioverbinding is verbroken. Je kunt opnieuw starten.'); };
      const offer = await peer.createOffer(); if (!current()) return; await peer.setLocalDescription(offer); phase = 'helper';
      const response = await this.fetchImpl('http://127.0.0.1:8787/session', { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer.sdp, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]) });
      if (!response.ok) throw new Error(await response.text()); const answer = await response.text(); if (!current()) return; phase = 'webrtc'; await peer.setRemoteDescription({ type: 'answer', sdp: answer }); if (!current()) return;
      this.connectionTimer = setTimeout(() => { if (current() && !this.liveStarted) this.fail('GPT-Live sessie startte niet. Controleer netwerk, API-toegang en modeltoegang.'); }, 20000);
    } catch (error) { if (current()) { const message = error.name === 'NotAllowedError' && phase === 'microphone' ? 'Microfoon geweigerd. Geef Chrome of Edge microfoontoegang en start opnieuw.' : error.name === 'NotFoundError' ? 'Geen microfoon gevonden. Sluit een microfoon aan.' : error instanceof TypeError && phase === 'helper' ? `Gesprekshulp niet bereikbaar (${error.message}). Laat start.ps1 openstaan en gebruik http://localhost:5173.` : error.message; this.fail(message); } }
  }

  handleEvent(event) {
    if (event.type === 'session.started') {
      this.liveStarted = true; clearTimeout(this.connectionTimer); this.updatePersonalization(); this.onPhase('listening'); this.onStatus('Verbonden — praat maar', true);
      if (this.pendingInitial) { const { text, image } = this.pendingInitial; this.pendingInitial = null; this.ask(text, image); }
    } else if (event.type === 'session.input_transcript.delta') {
      this.onSpeechActivity(true); this.onPhase('listening'); this.onStatus('Ik luister…', true);
    } else if (event.type === 'session.output_transcript.delta') {
      if (event.delta) this.onText(event.delta); this.onPhase('speaking'); this.onStatus('Microduck spreekt…', true);
    } else if (event.type === 'session.delegation.created') {
      this.handleDelegation(event);
    } else if (event.type === 'error') this.fail(event.error?.message || 'GPT-Live meldt een fout.');
    this.gestureCue.handleEvent(event);
  }

  async handleDelegation(event) {
    const id = event.delegation?.id; if (!id || event.delegation?.target !== 'client' || this.delegations?.has(id)) return;
    this.delegations ||= new Set(); this.delegations.add(id);
    // The notice intentionally contains no tool arguments. Give Live fresh trusted local context;
    // richer backend-agent routing is added in the next migration step.
    const context = this.cameraInstructions() + this.visionInstructions() + this.speakerInstructions();
    this.send({ type: 'session.thinking.append', event_id: `duck_ctx_${Date.now()}`, delegation_id: id, content: context.slice(0, 1800) });
  }

  personalization() {
    if (!this.companionStore || !this.baseInstructions) return {};
    const store = this.companionStore;
    return { instructions: this.baseInstructions + companionInstructions(store.preferences, store.memories) + this.cameraInstructions() + this.visionInstructions() + this.speakerInstructions() };
  }
  cameraInstructions() { const status = this.cameraStatus?.(); if (!status?.camera_active || !status.name_sharing) return 'Camera/naamdeling is nu uit; gebruik geen eerdere cameranaam.'; return 'Actuele lokale cameracontext: ' + JSON.stringify(status) + '. Een gezicht is niet automatisch de spreker; laat een onzekere naam weg.'; }
  speakerInstructions() { return this.speakerReady && this.speakerEnabled?.() ? 'Biometrische stemherkenning is beschikbaar. Gebruik een stemnaam alleen als actuele aanwijzing en laat de naam weg bij twijfel of conflict met camera.' : 'Biometrische stemherkenning is uit of niet beschikbaar; gebruik geen eerdere stemnaam.'; }
  visionInstructions() { return this.visionReady && this.captureImage && this.cameraStatus?.().image_sharing ? 'Google-beeldanalyse is beschikbaar voor expliciete beeldvragen; kijk niet automatisch.' : 'Google-beeldanalyse is uit of niet beschikbaar.'; }

  async analyzeCamera(args, signal) { signal.throwIfAborted(); if (!args || typeof args.question !== 'string' || !args.question.trim() || args.question.length > 1000) throw new Error('Geef een korte vraag over het beeld.'); if (!this.visionReady) throw new Error('Google-beeldanalyse is niet beschikbaar.'); if (!this.cameraStatus?.().image_sharing) throw new Error('Start de camera en zet beeld delen aan.'); const controller = this.visionController = new AbortController(); try { const image = this.captureImage(); const response = await this.fetchImpl('http://127.0.0.1:8787/vision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: args.question.trim(), image }), signal: AbortSignal.any([controller.signal, signal, this.controller.signal, AbortSignal.timeout(35000)]) }); if (!response.ok) throw new Error(await response.text()); const result = await response.json(); this.onVisionResult(result); return result; } finally { if (this.visionController === controller) this.visionController = null; } }
  updateCameraContext() { if (!this.liveStarted) return; this.updatePersonalization(); }
  updatePersonalization() { if (!this.liveStarted || this.channel?.readyState !== 'open') return; const p = this.personalization(); if (p.instructions) this.send({ type: 'session.instructions.append', event_id: `duck_instructions_${Date.now()}`, delegation_id: null, content: p.instructions.slice(0, 1800) }); }
  async primeAudio() { if (this.primedContext) return; const context = this.makeContext(), generation = this.generation; try { await context.resume(); if (generation !== this.generation) { await context.close().catch(() => {}); return; } this.primedContext = context; } catch (error) { await context.close().catch(() => {}); throw error; } }
  ask(text, image) { if (!this.liveStarted) { this.pendingInitial = { text: text || 'Wat zie je op deze foto?', image }; return; } if (image) throw new Error('Foto-invoer gaat in GPT-Live via de vision-backend; gebruik Bekijk dit.'); const content = String(text || '').trim(); if (!content) return; this.send({ type: 'session.commentary.append', event_id: `duck_text_${Date.now()}`, delegation_id: null, content: content.slice(0, 1800) }); }
  setVolume(value) { this.volume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1; this.voice?.setVolume?.(this.volume); }
  setVoicePitch(value) { this.voicePitch = Number.isFinite(value) ? Math.max(0, Math.min(9, value)) : 0; this.voice?.setPitch(this.voicePitch); }
  fail(message) { this.stop(); this.onStatus(message, false); }
  stop() { this.generation++; this.liveStarted = false; this.pendingInitial = null; this.delegations?.clear(); this.onMicrophoneStop(); this.visionController?.abort(); this.visionController = null; this.onVisionResult(null); this.onSpeechActivity(false); this.gestureCue.reset(); this.searchTools?.cancel(true); this.searchTools = null; this.onSearchResult(null); this.controller?.abort(); clearInterval(this.meter); clearTimeout(this.connectionTimer); if (this.channel) { this.channel.onclose = this.channel.onmessage = this.channel.onopen = null; this.channel.close(); } if (this.peer) { this.peer.onconnectionstatechange = this.peer.ontrack = null; this.peer.close(); } this.stream?.getTracks().forEach(track => track.stop()); if (this.audio) { this.audio.pause(); this.audio.srcObject = null; } this.source?.disconnect(); this.voice?.close(); this.analyser?.disconnect(); this.voice = this.analyser = null; this.context?.close().catch(() => {}); this.primedContext?.close().catch(() => {}); this.primedContext = null; this.controller = this.channel = this.peer = this.stream = this.audio = this.context = this.source = null; this.onLevel(0); this.onPhase('off'); this.onStatus('Gesprek gestopt', false); }
}
