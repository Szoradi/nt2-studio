// Web Audio output: pulls emulated frames from the engine as the sound card needs them.

import type { Engine } from './engine.ts';

export const OUTPUT_RATE = 48000;

export class AudioOutput {
  ctx: AudioContext;
  private node: ScriptProcessorNode;
  private buf: Int16Array = new Int16Array(0);
  private pos = 0;

  constructor(engine: Engine, gain = 1.8) {
    this.ctx = new AudioContext({ sampleRate: OUTPUT_RATE, latencyHint: 'interactive' });
    this.node = this.ctx.createScriptProcessor(1024, 0, 2);
    const k = gain / 32768;
    this.node.onaudioprocess = ev => {
      const l = ev.outputBuffer.getChannelData(0);
      const r = ev.outputBuffer.getChannelData(1);
      for (let i = 0; i < l.length; i++) {
        if (this.pos >= this.buf.length) {
          this.buf = engine.frame();
          this.pos = 0;
          if (!this.buf.length) { l[i] = r[i] = 0; continue; }
        }
        l[i] = Math.max(-1, Math.min(1, this.buf[this.pos++] * k));
        r[i] = Math.max(-1, Math.min(1, this.buf[this.pos++] * k));
      }
    };
    this.node.connect(this.ctx.destination);
  }

  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }
}
