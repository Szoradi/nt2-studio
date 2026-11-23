// Thin wrapper around the prebuilt WebSid (Tiny'R'Sid) emulator by Juergen Wothke.
// WebSid is licensed CC BY-NC-SA 4.0: https://bitbucket.org/wothke/websid

export interface EmscriptenModule {
  ccall(name: string, ret: string | null, argTypes: string[], args: unknown[]): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
}

export class WebSid {
  private m: EmscriptenModule;
  sampleRate = 0;

  constructor(module: EmscriptenModule) {
    this.m = module;
  }

  /** Load a PSID file and start its first subtune. */
  load(sid: Uint8Array, sampleRate: number) {
    const m = this.m;
    const buf = m._malloc(sid.length);
    m.HEAPU8.set(sid, buf);
    const ret = m.ccall('emu_load_file', 'number',
      ['string', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
      ['tune.sid', buf, sid.length, sampleRate, 1024, 0, 0, 0, 0, 0]);
    m._free(buf);
    if (ret !== 0) throw new Error('WebSid could not load the tune');
    m.ccall('emu_set_subsong', 'number', ['number'], [0]);
    this.sampleRate = m.ccall('emu_get_sample_rate', 'number', [], []);
  }

  /** Emulate one video frame. Returns interleaved stereo samples (valid until the next call). */
  frame(): Int16Array {
    const m = this.m;
    m.ccall('emu_compute_audio_samples', 'number', [], []);
    const ptr = m.ccall('emu_get_audio_buffer', 'number', [], []);
    const len = m.ccall('emu_get_audio_buffer_length', 'number', [], []);
    return m.HEAP16.subarray(ptr >> 1, (ptr >> 1) + len * 2);
  }

  read(addr: number): number {
    return this.m.ccall('emu_read_ram', 'number', ['number'], [addr]) & 0xff;
  }
  write(addr: number, value: number) {
    this.m.ccall('emu_write_ram', null, ['number', 'number'], [addr, value]);
  }
  sidWrite(reg: number, value: number) {
    this.m.ccall('emu_set_sid_register', null, ['number', 'number', 'number'], [0, reg, value]);
  }
  setModel(model: '6581' | '8580') {
    this.m.ccall('emu_set_6581', 'number', ['number'], [model === '6581' ? 1 : 0]);
  }
  enableVoice(voice: number, on: boolean) {
    this.m.ccall('emu_enable_voice', null, ['number', 'number', 'number'], [0, voice, on ? 1 : 0]);
  }
}

interface SidWindow {
  WASM_SEARCH_PATH?: string;
  spp_backend_state_SID?: { notReady: boolean; adapterCallback: () => void };
  backend_SID?: { Module: EmscriptenModule };
}

/** Browser loader: injects WebSid's script and waits for the WebAssembly runtime. */
export function loadWebSidModule(baseUrl: string): Promise<EmscriptenModule> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as SidWindow;
    w.WASM_SEARCH_PATH = baseUrl;
    const script = document.createElement('script');
    script.src = baseUrl + 'backend_websid.js';
    script.onerror = () => reject(new Error('Could not load the WebSid emulator'));
    script.onload = () => {
      const state = w.spp_backend_state_SID;
      const done = () => resolve(w.backend_SID!.Module);
      if (!state || !w.backend_SID) reject(new Error('WebSid did not initialise'));
      else if (!state.notReady) done();
      else state.adapterCallback = done;
    };
    document.head.appendChild(script);
  });
}
