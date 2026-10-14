/* ==========================================================================
   ULTRAMODEM — modem core v3 (shared between browser UI and Node test harness)
   --------------------------------------------------------------------------
   v3 upgrade: the link now carries FILES, not just short text.

   Modulation: 16-tone FSK. Each 50ms symbol encodes 4 bits (one hex digit),
   using tones FREQ_BASE + k*FREQ_SPACING for k = 0..15 — by default
   2000 Hz + k*200 Hz (2000–5000 Hz), which ordinary laptop/phone speakers and
   microphones reproduce faithfully. That's ~80 bits/second. The near-ultrasonic
   17000–19700 Hz band remains available via setBand().

   Framing:   [preamble 20 sym] [start 2 sym] [type][id][len hi][len lo]
              [payload ...] [crc16 hi][crc16 lo] [end 2 sym]
              CRC-16/CCITT covers type..payload. Every packet carries its own
              preamble so the receiver re-locks between packets.

   Packets:   0x01 TEXT          payload = UTF-8 message
              0x02 FILE_META     payload = JSON {n,m,s,c,k} name/mime/size/
                                              chunkCount/fileCrc16
              0x03 FILE_DATA     payload = [idx hi][idx lo][chunk bytes]
              0x04 FILE_END      payload = [fileCrc16 hi][lo]

   The demodulator is the same sample-driven Goertzel engine as v2, upgraded
   to pick a winner among 16 tones, and it is written as a plain class so the
   Node loopback test exercises the EXACT pipeline the browser uses.
   ========================================================================== */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ModemCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- TUNABLE CONSTANTS ----------
  const SYMBOL_MS = 50;               // one symbol (4 bits) per 50ms
  const SUB_MS = 5;                   // hunt-step resolution while seeking preamble
  // Carrier band. The default is the hardware-friendly audible band
  // (2000 Hz + k*200 Hz => 2000–5000 Hz): every laptop and phone speaker and
  // mic reproduces it. The near-ultrasonic band (17000 + k*180 => 17000–19700)
  // is still available through setBand(), but most consumer speakers cannot
  // produce anything up there, so the other end of the link hears nothing.
  let FREQ_BASE = 2000;               // tone for symbol 0
  let FREQ_SPACING = 200;             // Hz between consecutive tones
  const NUM_TONES = 16;
  const FREQS = [];
  for (let i = 0; i < NUM_TONES; i++) FREQS.push(FREQ_BASE + i * FREQ_SPACING);

  // Switch the carrier band at runtime (both ends of the link must agree).
  // FREQS is mutated in place so every reference held by the demodulator and
  // the UI picks up the new tones immediately.
  function setBand(base, spacing) {
    FREQ_BASE = Math.round(Number(base));
    FREQ_SPACING = Math.round(Number(spacing));
    for (let i = 0; i < NUM_TONES; i++) FREQS[i] = FREQ_BASE + i * FREQ_SPACING;
    return FREQS;
  }

  const PREAMBLE = [];                // alternating 0/15 symbols, 20 long
  for (let i = 0; i < 20; i++) PREAMBLE.push(i % 2 === 0 ? 0 : 15);
  const START_MARKER = [10, 5];
  const END_MARKER = [5, 10];

  const MIN_RATIO = 1.45;             // winner must beat runner-up by this factor
  const RING_SECONDS = 3;
  const MAX_PAYLOAD = 96;             // bytes of payload per packet
  const CHUNK_DATA = MAX_PAYLOAD - 2; // minus the 2-byte chunk index
  const MAX_FILE_BYTES = 4 * 1024 * 1024;

  const TYPE_TEXT = 0x01;
  const TYPE_FILE_META = 0x02;
  const TYPE_FILE_DATA = 0x03;
  const TYPE_FILE_END = 0x04;

  // After locking, how many silent symbols we tolerate before assuming the
  // transmitter stopped and re-hunting. Callers call demod.keepAlive() after
  // every successfully parsed packet so a multi-packet transfer rides through
  // the short silence gaps without dropping the lock.
  const LOCK_HORIZON_SYMBOLS = 400;

  // ---------- BYTE / SYMBOL HELPERS ----------
  function bytesToSymbols(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
      out.push((bytes[i] >> 4) & 0x0f);
      out.push(bytes[i] & 0x0f);
    }
    return out;
  }

  function utf8Encode(str) { return new TextEncoder().encode(str); }
  function utf8Decode(bytes) { return new TextDecoder("utf-8").decode(bytes); }

  // ---------- CRC-16/CCITT ----------
  function crc16(bytes) {
    let crc = 0xffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 8;
      for (let b = 0; b < 8; b++)
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }

  // ---------- FRAMING ----------
  function buildFrame(type, id, payload) {
    payload = payload || new Uint8Array(0);
    const body = new Uint8Array(4 + payload.length);
    body[0] = type & 0xff;
    body[1] = id & 0xff;
    body[2] = (payload.length >> 8) & 0xff;
    body[3] = payload.length & 0xff;
    body.set(payload, 4);
    const c = crc16(body);
    const full = new Uint8Array(body.length + 2);
    full.set(body, 0);
    full[body.length] = (c >> 8) & 0xff;
    full[body.length + 1] = c & 0xff;
    const symbols = []
      .concat(PREAMBLE, START_MARKER, bytesToSymbols(full), END_MARKER);
    return { symbols, bytes: full, crc: c, type, id };
  }

  function buildTextPacket(text, id) {
    return buildFrame(TYPE_TEXT, id === undefined ? 1 : id, utf8Encode(text));
  }

  function buildFilePackets(name, mime, data, id) {
    id = id === undefined ? 1 : id;
    data = data || new Uint8Array(0);
    const meta = {
      n: name,
      m: mime || "application/octet-stream",
      s: data.length,
      c: Math.max(1, Math.ceil(data.length / CHUNK_DATA)),
      k: crc16(data),
      t: Date.now()
    };
    const packets = [buildFrame(TYPE_FILE_META, id, utf8Encode(JSON.stringify(meta)))];
    for (let idx = 0; idx < meta.c; idx++) {
      const off = idx * CHUNK_DATA;
      const chunk = data.subarray(off, Math.min(off + CHUNK_DATA, data.length));
      const payload = new Uint8Array(2 + chunk.length);
      payload[0] = (idx >> 8) & 0xff;
      payload[1] = idx & 0xff;
      payload.set(chunk, 2);
      packets.push(buildFrame(TYPE_FILE_DATA, id, payload));
    }
    packets.push(buildFrame(TYPE_FILE_END, id, new Uint8Array([
      (meta.k >> 8) & 0xff, meta.k & 0xff
    ])));
    return { packets, meta };
  }

  // Total symbols + rough on-air seconds for a list of packets (no gap).
  function estimateSymbols(packets) {
    let n = 0;
    for (const p of packets) n += p.symbols.length;
    return n;
  }
  function symbolsToSeconds(symbols) { return symbols * SYMBOL_MS / 1000; }

  // ---------- GOERTZEL ----------
  // Magnitude of `targetFreq` inside `samples`. w is computed exactly from the
  // target frequency (no bin rounding), so it works at any sample rate.
  function goertzelMag(samples, targetFreq, sr) {
    const N = samples.length;
    const w = (2 * Math.PI * targetFreq) / sr;
    const cosine = Math.cos(w), coeff = 2 * cosine, sine = Math.sin(w);
    let q0 = 0, q1 = 0, q2 = 0;
    for (let i = 0; i < N; i++) {
      q0 = coeff * q1 - q2 + samples[i];
      q2 = q1; q1 = q0;
    }
    const real = q1 - q2 * cosine;
    const imag = q2 * sine;
    return Math.sqrt(real * real + imag * imag);
  }

  // Winner-take-all across all 16 tones. Always decisive.
  function detectSymbol(samples, sr) {
    let best = -1, bestIdx = 0, second = -1;
    for (let k = 0; k < NUM_TONES; k++) {
      const m = goertzelMag(samples, FREQS[k], sr);
      if (m > best) { second = best; best = m; bestIdx = k; }
      else if (m > second) second = m;
    }
    return { sym: bestIdx, mag: best, ratio: best / (second + 1e-12) };
  }

  // ---------- DEMODULATOR ----------
  // Push raw Float32 mic samples in; symbols come out via onSymbol.
  function createDemod(sampleRate, handlers) {
    handlers = handlers || {};
    const sr = sampleRate;
    const symSamples = Math.round(sr * SYMBOL_MS / 1000);
    const subStepSamples = Math.round(sr * SUB_MS / 1000);
    const ringLen = Math.round(sr * RING_SECONDS);
    const ring = new Float32Array(ringLen);
    let totalWritten = 0;

    let mode = "HUNTING";
    let huntNextEnd = symSamples;
    let subTrace = [];
    let lockNextEnd = 0, lockWatchdog = 0;

    function reset() {
      mode = "HUNTING";
      huntNextEnd = totalWritten + symSamples;
      subTrace = [];
      lockNextEnd = 0;
      lockWatchdog = 0;
      if (handlers.onSync) handlers.onSync(false);
    }

    function getWindow(end, len) {
      const start = end - len;
      if (start < 0) return null;
      if (end > totalWritten) return null;
      if (totalWritten - start > ringLen) return null;
      const out = new Float32Array(len);
      const base = start % ringLen;
      if (base + len <= ringLen) out.set(ring.subarray(base, base + len));
      else {
        const firstPart = ringLen - base;
        out.set(ring.subarray(base, ringLen), 0);
        out.set(ring.subarray(0, len - firstPart), firstPart);
      }
      return out;
    }

    function tryLockPreamble() {
      const oversample = Math.max(1, Math.round(symSamples / subStepSamples));
      const need = PREAMBLE.length * oversample;
      if (subTrace.length < need) return false;

      let bestScore = -1, bestPhase = 0, bestEndIdx = -1;
      for (let phase = 0; phase < oversample; phase++) {
        let score = 0, count = 0, idx = subTrace.length - 1 - phase;
        const picks = [];
        for (let b = PREAMBLE.length - 1; b >= 0 && idx >= 0; b--, idx -= oversample) {
          picks.push(idx);
          count++;
        }
        if (count < PREAMBLE.length) continue;
        picks.reverse();
        for (let b = 0; b < PREAMBLE.length; b++) {
          const e = subTrace[picks[b]];
          if (e.sym === PREAMBLE[b] && e.ratio >= MIN_RATIO) score++;
        }
        if (score > bestScore) {
          bestScore = score; bestPhase = phase; bestEndIdx = picks[picks.length - 1];
        }
      }

      if (bestScore >= PREAMBLE.length - 2) {
        const last = subTrace[bestEndIdx];
        mode = "LOCKED";
        lockNextEnd = last.end + symSamples;
        lockWatchdog = lockNextEnd + symSamples * LOCK_HORIZON_SYMBOLS;
        if (handlers.onSync)
          handlers.onSync({ score: bestScore, total: PREAMBLE.length, phase: bestPhase });
        return true;
      }
      return false;
    }

    function step() {
      if (mode === "HUNTING") {
        while (totalWritten >= huntNextEnd) {
          const win = getWindow(huntNextEnd, symSamples);
          if (win) {
            const d = detectSymbol(win, sr);
            subTrace.push({ sym: d.sym, ratio: d.ratio, end: huntNextEnd });
            if (subTrace.length > 600) subTrace.shift();
            if (handlers.onDetect) handlers.onDetect(d);
            if (tryLockPreamble()) break;
          }
          huntNextEnd += subStepSamples;
        }
      } else { // LOCKED
        while (totalWritten >= lockNextEnd) {
          const win = getWindow(lockNextEnd, symSamples);
          if (win) {
            const d = detectSymbol(win, sr);
            if (handlers.onDetect) handlers.onDetect(d);
            if (handlers.onSymbol) handlers.onSymbol(d.sym, d);
          }
          lockNextEnd += symSamples;
          if (lockNextEnd > lockWatchdog) {
            if (handlers.onTimeout) handlers.onTimeout();
            reset();
            break;
          }
        }
      }
    }

    return {
      reset,
      keepAlive() { lockWatchdog = lockNextEnd + symSamples * LOCK_HORIZON_SYMBOLS; },
      pushSamples(input) {
        for (let i = 0; i < input.length; i++) {
          ring[totalWritten % ringLen] = input[i];
          totalWritten++;
        }
        step();
      },
      get mode() { return mode; },
      symSamples, subStepSamples
    };
  }

  // ---------- PACKET PARSER + FILE ASSEMBLER ----------
  // Feed decoded symbols in via push(); callbacks fire as packets complete.
  function createParser(handlers) {
    handlers = handlers || {};
    let state = "IDLE";           // IDLE | START | HEADER | DATA | CRC | ENDMARK
    let buf = [];                 // symbol buffer for markers
    let nibbleHi = null;          // partial byte while collecting symbols
    let header = [];              // type,id,lenHi,lenLo
    let payloadLen = 0;
    let payload = [];
    let crcBuf = [];
    let transfer = null;

    function resetTransfer() { transfer = null; }

    function byteFromSymbol(sym) {
      if (nibbleHi === null) { nibbleHi = sym; return null; }
      const b = ((nibbleHi & 0x0f) << 4) | (sym & 0x0f);
      nibbleHi = null;
      return b;
    }

    function dispatch() {
      const body = new Uint8Array(header.concat(payload));
      const recv = ((crcBuf[0] << 8) | crcBuf[1]) & 0xffff;
      const expect = crc16(body);
      const type = header[0];
      if (recv !== expect) {
        if (handlers.onError) handlers.onError(`CRC mismatch on packet type 0x${type.toString(16)} (expected ${expect}, got ${recv})`);
        return;
      }
      // CRC verified — let the UI show what just came off the air.
      if (handlers.onPacket) handlers.onPacket({ type, id: header[1], len: payload.length });
      if (type === TYPE_TEXT) {
        if (handlers.onText) handlers.onText(utf8Decode(new Uint8Array(payload)), header[1]);
      } else if (type === TYPE_FILE_META) {
        try {
          const meta = JSON.parse(utf8Decode(new Uint8Array(payload)));
          if (typeof meta.n !== "string" || typeof meta.s !== "number" || typeof meta.c !== "number")
            throw new Error("bad meta fields");
          if (meta.s > MAX_FILE_BYTES) throw new Error("file too large for this link");
          transfer = { meta, chunks: new Map() };
          if (handlers.onFileStart) handlers.onFileStart(meta);
        } catch (e) {
          if (handlers.onError) handlers.onError("Bad file meta: " + e.message);
        }
      } else if (type === TYPE_FILE_DATA) {
        if (!transfer) { if (handlers.onError) handlers.onError("Data packet without meta"); return; }
        if (payload.length >= 2) {
          const idx = ((payload[0] << 8) | payload[1]) & 0xffff;
          transfer.chunks.set(idx, new Uint8Array(payload.slice(2)));
          if (handlers.onFileProgress) {
            let got = 0;
            for (const c of transfer.chunks.values()) got += c.length;
            handlers.onFileProgress({
              meta: transfer.meta,
              chunksReceived: transfer.chunks.size,
              chunkCount: transfer.meta.c,
              bytesReceived: got,
              totalBytes: transfer.meta.s
            });
          }
        }
      } else if (type === TYPE_FILE_END) {
        if (!transfer) { if (handlers.onError) handlers.onError("File end without meta"); return; }
        const { meta, chunks } = transfer;
        let total = 0, missing = -1;
        for (let i = 0; i < meta.c; i++) {
          const c = chunks.get(i);
          if (!c) { missing = i; break; }
          total += c.length;
        }
        const data = new Uint8Array(total);
        let off = 0;
        for (let i = 0; i < meta.c; i++) {
          const c = chunks.get(i);
          data.set(c, off);
          off += c.length;
        }
        const crcOk = missing === -1 && total === meta.s && crc16(data) === meta.k;
        if (handlers.onFileComplete)
          handlers.onFileComplete({
            name: meta.n, mime: meta.m, size: meta.s,
            data, crcOk,
            error: missing !== -1 ? `chunk ${missing} missing`
                 : total !== meta.s ? `size mismatch (${total} vs ${meta.s})`
                 : crc16(data) !== meta.k ? "CRC mismatch" : null
          });
        transfer = null;
      }
    }

    function push(sym) {
      switch (state) {
        case "IDLE":
          if (sym === START_MARKER[0]) { buf = [sym]; state = "START"; }
          break;
        case "START":
          buf.push(sym);
          if (buf.length === START_MARKER.length) {
            if (buf[0] === START_MARKER[0] && buf[1] === START_MARKER[1]) {
              state = "HEADER"; header = []; nibbleHi = null; buf = [];
            } else if (sym === START_MARKER[0]) {
              buf = [sym];
            } else {
              buf = []; state = "IDLE";
            }
          }
          break;
        case "HEADER": {
          const b = byteFromSymbol(sym);
          if (b !== null) {
            header.push(b);
            if (header.length === 4) {
              payloadLen = ((header[2] << 8) | header[3]) & 0xffff;
              if (payloadLen > MAX_PAYLOAD) {
                if (handlers.onError) handlers.onError(`Suspicious payload length ${payloadLen}`);
                state = "IDLE";
              } else {
                payload = [];
                state = payloadLen === 0 ? "CRC" : "DATA";
              }
            }
          }
          break;
        }
        case "DATA": {
          const b = byteFromSymbol(sym);
          if (b !== null) {
            payload.push(b);
            if (payload.length === payloadLen) { crcBuf = []; state = "CRC"; }
          }
          break;
        }
        case "CRC": {
          const b = byteFromSymbol(sym);
          if (b !== null) {
            crcBuf.push(b);
            if (crcBuf.length === 2) { dispatch(); buf = []; state = "ENDMARK"; }
          }
          break;
        }
        case "ENDMARK":
          buf.push(sym);
          if (buf.length === END_MARKER.length) {
            if (!(buf[0] === END_MARKER[0] && buf[1] === END_MARKER[1]) && handlers.onError)
              handlers.onError("End marker mismatch");
            buf = []; state = "IDLE";
          }
          break;
      }
    }

    return {
      push,
      reset() {
        state = "IDLE"; buf = []; nibbleHi = null; header = [];
        payloadLen = 0; payload = []; crcBuf = []; transfer = null;
      },
      get state() { return state; }
    };
  }

  // ---------- PUBLIC API ----------
  return {
    SYMBOL_MS, SUB_MS, NUM_TONES, FREQS, setBand,
    get FREQ_BASE() { return FREQ_BASE; },
    get FREQ_SPACING() { return FREQ_SPACING; },
    PREAMBLE, START_MARKER, END_MARKER, MIN_RATIO,
    MAX_PAYLOAD, CHUNK_DATA, MAX_FILE_BYTES, LOCK_HORIZON_SYMBOLS,
    TYPE_TEXT, TYPE_FILE_META, TYPE_FILE_DATA, TYPE_FILE_END,
    bytesToSymbols, utf8Encode, utf8Decode, crc16,
    buildFrame, buildTextPacket, buildFilePackets,
    estimateSymbols, symbolsToSeconds,
    goertzelMag, detectSymbol, createDemod, createParser
  };
});
