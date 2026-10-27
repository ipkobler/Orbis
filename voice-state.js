export const VOICE_STATES = ['enabled', 'silent', 'unavailable', 'restoring', 'speaking'];
export class VoiceState {
  constructor({ state = 'enabled', preference = 'enabled' } = {}) { this.state = state; this.preference = preference; this.updatedAt = new Date().toISOString(); }
  transition(action) { const next = { enable: 'enabled', disable: 'silent', restore: 'restoring', ready: 'enabled', speak: 'speaking', stop: this.preference === 'silent' ? 'silent' : 'enabled', unavailable: 'unavailable' }[action]; if (!next) throw Error('invalid voice action'); this.state = next; if (action === 'enable' || action === 'disable') this.preference = next; this.updatedAt = new Date().toISOString(); return this.snapshot(); }
  snapshot() { return { state: this.state, preference: this.preference, updatedAt: this.updatedAt, textAvailable: true, speechActive: this.state === 'speaking' }; }
}
