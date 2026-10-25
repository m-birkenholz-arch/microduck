// The expressive head pattern already used by robotd's chorale, adapted to speech
// amplitude. Command order: neck pitch, head pitch, head yaw, head roll (radians).
// No locomotion commands, policy switches or direct servo/rig writes live here.
export function headExpression(beats, reach) {
  const bar = 2 * Math.PI * beats / 4;
  const phrase = 2 * Math.PI * beats / 8;
  const beat = 2 * Math.PI * beats;
  return [0, -0.10 * reach + 0.025 * Math.sin(beat),
    0.05 * Math.sin(phrase), 0.08 * Math.sin(bar)];
}

export class ConversationMotion {
  constructor() {
    this.phase = 'off';
    this.enabled = true;
    this.strength = 3;
    this.level = 0;
    this.time = 0;
    this.head = [0, 0, 0, 0];
  }

  setPhase(phase) {
    if (!['off', 'connecting', 'listening', 'thinking', 'speaking'].includes(phase)) phase = 'off';
    if (phase !== this.phase) this.time = 0;
    this.phase = phase;
    if (phase !== 'speaking') this.level = 0;
  }

  setLevel(level) {
    this.level = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  }

  setStrength(value) {
    this.strength = Number.isFinite(value) ? Math.max(1, Math.min(4, value)) : 3;
  }

  step(dt, allowed) {
    // The caller owns arbitration. Reset rather than queue gestures while a
    // person, a trick, a recovery or a community policy has the duck.
    if (!allowed || !this.enabled) { this.head.fill(0); this.time = 0; return this.head; }
    const seconds = Number.isFinite(dt) ? Math.max(0, Math.min(0.05, dt)) : 0;
    this.time += seconds;
    let target = [0, 0, 0, 0];
    if (this.phase === 'speaking') {
      // Same small chorale sway; a syllable's loudness replaces note reach.
      target = headExpression(this.time * 1.15, this.level);
      target[0] = 0.025 * this.level;
      // Laptop audio often has a low RMS level. Keep the phrase sway visible
      // between quiet syllables instead of attenuating it almost to nothing.
      target = target.map(v => v * (0.60 + 0.40 * this.level));
    } else if (this.phase === 'listening' || this.phase === 'thinking') {
      // The idle behaviour's curious tilt and neck lean, kept facing the user
      // instead of random glances or yawns in the middle of a conversation.
      const energy = this.phase === 'thinking' ? 0.55 : 0.35;
      target = headExpression(this.time * 0.35, 0).map(v => v * energy);
      target[0] = 0.025 * energy;
      target[3] += 0.045;
    }
    const alpha = 1 - Math.exp(-seconds / 0.35);
    for (let i = 0; i < 4; i++) {
      const limit = i === 0 ? 0.12 : 0.30;
      const scaled = Math.max(-limit, Math.min(limit, target[i] * this.strength));
      this.head[i] += alpha * (scaled - this.head[i]);
      if (Math.abs(this.head[i]) < 1e-6) this.head[i] = 0;
    }
    return this.head;
  }
}

export const conversationMotion = new ConversationMotion();
export function stepConversationHead(dt, allowed) { return conversationMotion.step(dt, allowed); }
