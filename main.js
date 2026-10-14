/* ==========================================================================
   ULTRAMODEM — browser engine v3
   --------------------------------------------------------------------------
   The modem itself (16-tone FSK modulation, CRC-16 framing, Goertzel
   demodulator, packet parser and file assembler) now lives in modem-core.js
   so the exact same pipeline is exercised by test/loopback.test.js in Node.
   This file is only the browser glue: microphone/speaker plumbing + UI.

   What's new in v3: besides text, you can now send ANY document (PDF, images,
   zips, ...). Files are split into 94-byte chunks, each chunk in its own CRC
   protected packet; the receiver reassembles them and offers a download.
   ========================================================================== */

(() => {
  const MC = window.ModemCore;
  if (!MC) { console.error("modem-core.js must be loaded before main.js"); return; }

  // ---------- STATE ----------
  let audioCtx = null;
  let toneOsc = null;
  let micStream = null, analyser = null, micSource = null, processor = null;
  let listening = false, transmitting = false;
  let scopeRAF = null;
  let demod = null;
  let transferId = 1;
  let selectedFile = null, selectedBytes = null;

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const toneFreq = $("toneFreq"), toneFreqVal = $("toneFreqVal");
  const playToneBtn = $("playToneBtn"), stopToneBtn = $("stopToneBtn");
  const micStatus = $("micStatus"), detFreq = $("detFreq");
  const detStrengthVal = $("detStrengthVal"), strengthBar = $("strengthBar");
  const decodedSym = $("decodedSym");
  const listenBtn = $("listenBtn"), stopListenBtn = $("stopListenBtn");
  const scope = $("scope");
  const txText = $("txText"), sendBtn = $("sendBtn");
  const bandSel = $("bandSel");
  const txLen = $("txLen"), txChecksum = $("txChecksum"), txBits = $("txBits");
  const fileInput = $("fileInput"), fileInfo = $("fileInfo"), sendFileBtn = $("sendFileBtn");
  const linkState = $("linkState");
  const pFreq = $("pFreq"), pSym = $("pSym"), pSync = $("pSync"),
        pBinary = $("pBinary"), pChecksum = $("pChecksum"), pText = $("pText");
  const rxBitsEl = $("rxBits"), rxMessage = $("rxMessage"), eventLog = $("eventLog");
  const rxFileName = $("rxFileName"), rxFileSize = $("rxFileSize"),
        rxFill = $("rxFill"), rxPct = $("rxPct"), rxChunks = $("rxChunks"),
        rxFileStatus = $("rxFileStatus"), rxFiles = $("rxFiles");

  function log(msg, cls) {
    if (!eventLog) return;
    const d = document.createElement("div");
    d.className = cls || "";
    d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    eventLog.appendChild(d);
    eventLog.scrollTop = eventLog.scrollHeight;
  }

  function getCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }
  function fmtSec(s) {
    if (s < 90) return s.toFixed(0) + "s";
    return Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";
  }

  // ================= TONE GENERATOR (test page) =================
  if (toneFreq) toneFreq.addEventListener("input", () => { toneFreqVal.textContent = toneFreq.value; });
  if (playToneBtn) playToneBtn.addEventListener("click", () => {
    const ctx = getCtx();
    if (ctx.state === "suspended") ctx.resume();
    toneOsc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.35;
    toneOsc.frequency.value = parseFloat(toneFreq.value);
    toneOsc.connect(gain).connect(ctx.destination);
    toneOsc.start();
    playToneBtn.disabled = true; stopToneBtn.disabled = false;
    log(`Playing test tone at ${toneFreq.value} Hz`, "info");
  });
  if (toneFreq) toneFreq.addEventListener("change", () => {
    if (toneOsc) toneOsc.frequency.setValueAtTime(parseFloat(toneFreq.value), getCtx().currentTime);
  });
  if (stopToneBtn) stopToneBtn.addEventListener("click", () => {
    if (toneOsc) { toneOsc.stop(); toneOsc.disconnect(); toneOsc = null; }
    playToneBtn.disabled = false; stopToneBtn.disabled = true;
    log("Test tone stopped");
  });

  // ================= RECEIVER =================
  async function startListening() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false
      }});
    } catch (e) {
      log("Microphone access denied or unavailable: " + e.message, "bad");
      return;
    }
    const ctx = getCtx();
    if (ctx.state === "suspended") await ctx.resume();

    micSource = ctx.createMediaStreamSource(micStream);

    // analyser purely for the visual spectrum scope (cosmetic)
    analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.15;
    micSource.connect(analyser);

    // the real decode path — sample driven, no timers
    const BUF = 2048;
    processor = ctx.createScriptProcessor(BUF, 1, 1);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    micSource.connect(processor);
    processor.connect(gain);
    gain.connect(ctx.destination);
    processor.onaudioprocess = onAudioProcess;

    // ---- wire the shared demod + parser to the UI ----
    const parser = MC.createParser({
      onPacket: (p) => {
        if (pBinary) pBinary.textContent = `${p.len} B`;
      },
      onText: (text) => {
        demod.keepAlive();
        if (pText) pText.textContent = text;
        if (pChecksum) pChecksum.textContent = "OK";
        if (rxMessage) { rxMessage.textContent = text; rxMessage.classList.remove("empty"); }
        linkState.textContent = "MESSAGE OK"; linkState.className = "status-pill on";
        log(`Received text: "${text}" — CRC OK`, "ok");
      },
      onFileStart: (meta) => {
        demod.keepAlive();
        if (rxFileName) rxFileName.textContent = meta.n;
        if (rxFileSize) rxFileSize.textContent = fmtBytes(meta.s);
        if (rxChunks) rxChunks.textContent = `0/${meta.c}`;
        if (rxFill) rxFill.style.width = "0%";
        if (rxPct) rxPct.textContent = "0%";
        if (rxFileStatus) { rxFileStatus.textContent = "RECEIVING"; rxFileStatus.className = "status-pill hunting"; }
        linkState.textContent = `RECEIVING ${meta.n}`;
        log(`File incoming: "${meta.n}" (${fmtBytes(meta.s)}, ${meta.c} packets)`, "info");
      },
      onFileProgress: (p) => {
        demod.keepAlive();
        const pct = p.totalBytes ? Math.round(100 * p.bytesReceived / p.totalBytes) : 0;
        if (rxChunks) rxChunks.textContent = `${p.chunksReceived}/${p.chunkCount}`;
        if (rxFill) rxFill.style.width = pct + "%";
        if (rxPct) rxPct.textContent = pct + "%";
        linkState.textContent = `RECEIVING ${p.meta.n} (${pct}%)`;
      },
      onFileComplete: (f) => {
        demod.keepAlive();
        if (f.crcOk) {
          const blob = new Blob([f.data], { type: f.mime || "application/octet-stream" });
          const url = URL.createObjectURL(blob);
          addDownload(f.name, url, f.size);
          if (pChecksum) pChecksum.textContent = "OK";
          if (rxFill) rxFill.style.width = "100%";
          if (rxPct) rxPct.textContent = "100%";
          if (rxFileStatus) { rxFileStatus.textContent = "COMPLETE"; rxFileStatus.className = "status-pill on"; }
          linkState.textContent = "FILE OK"; linkState.className = "status-pill on";
          log(`File complete: "${f.name}" (${fmtBytes(f.size)}) — CRC OK, ready to download`, "ok");
        } else {
          if (rxFileStatus) { rxFileStatus.textContent = "FAILED"; rxFileStatus.className = "status-pill err"; }
          linkState.textContent = "FILE CORRUPT"; linkState.className = "status-pill err";
          log(`File transfer failed: ${f.error || "CRC mismatch"}`, "bad");
        }
      },
      onError: (msg) => {
        if (/CRC mismatch/i.test(msg) && pChecksum) pChecksum.textContent = "FAIL";
        log(msg, "bad");
      }
    });

    demod = MC.createDemod(ctx.sampleRate, {
      onSymbol: (s) => parser.push(s),
      onDetect: (d) => updateLiveReadout(d),
      onSync: (s) => {
        if (s) {
          if (pSync) pSync.textContent = `LOCKED (${s.score}/${s.total})`;
          linkState.textContent = "SYNCED — READING PACKET"; linkState.className = "status-pill on";
          log(`Preamble locked (score ${s.score}/${s.total}, phase ${s.phase}).`, "ok");
        } else {
          if (pSync) pSync.textContent = "—";
        }
      },
      onTimeout: () => {
        if (pSync) pSync.textContent = "—";
        linkState.textContent = "HUNTING FOR PREAMBLE"; linkState.className = "status-pill hunting";
        log("Lock timed out (transmission ended). Re-hunting.");
      }
    });

    listening = true;
    micStatus.textContent = "LIVE"; micStatus.className = "status-pill on";
    listenBtn.disabled = true; stopListenBtn.disabled = false;
    resetReceiverUi();
    resizeCanvas();
    log(`Microphone live. 16-tone FSK @ ${MC.SYMBOL_MS}ms/symbol, tones ${MC.FREQS[0]}–${MC.FREQS[15]} Hz.`, "info");

    drawLoop();
  }

  function onAudioProcess(e) {
    if (!demod) return;
    demod.pushSamples(e.inputBuffer.getChannelData(0));
  }

  function stopListening() {
    listening = false;
    if (scopeRAF) { cancelAnimationFrame(scopeRAF); scopeRAF = null; }
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); processor = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    demod = null;
    micStatus.textContent = "OFFLINE"; micStatus.className = "status-pill";
    listenBtn.disabled = false; stopListenBtn.disabled = true;
    linkState.textContent = "IDLE"; linkState.className = "status-pill";
    log("Stopped listening.");
  }

  if (listenBtn) listenBtn.addEventListener("click", startListening);
  if (stopListenBtn) stopListenBtn.addEventListener("click", stopListening);

  function updateLiveReadout(d) {
    const confident = d.ratio >= MC.MIN_RATIO;
    const f = MC.FREQS[d.sym];
    if (detFreq) detFreq.textContent = confident ? `${f} Hz` : "— Hz";
    const pct = Math.max(0, Math.min(100, Math.round((Math.log10(d.ratio) / Math.log10(8)) * 100)));
    if (detStrengthVal) detStrengthVal.textContent = pct + "%";
    if (strengthBar) strengthBar.style.width = pct + "%";
    if (decodedSym) decodedSym.textContent = confident ? d.sym.toString(16).toUpperCase() : "–";
    if (pFreq) pFreq.textContent = confident ? f : "—";
    if (pSym) pSym.textContent = confident ? d.sym.toString(16).toUpperCase() : "—";
    if (rxBitsEl) {
      const cur = rxBitsEl.dataset.tail || "";
      const tail = (cur + d.sym.toString(16).toUpperCase()).slice(-96);
      rxBitsEl.dataset.tail = tail;
      rxBitsEl.innerHTML = tail.slice(0, -1) + (tail ? `<span class="cur">${tail.slice(-1)}</span>` : "");
    }
  }

  function resetReceiverUi() {
    if (pSync) pSync.textContent = "—";
    if (pBinary) pBinary.textContent = "—";
    if (pChecksum) pChecksum.textContent = "—";
    if (pText) pText.textContent = "—";
    if (rxBitsEl) { rxBitsEl.innerHTML = "—"; rxBitsEl.dataset.tail = ""; }
  }

  function addDownload(name, url, size) {
    if (!rxFiles) return;
    if (rxFiles.dataset.filled !== "1") { rxFiles.textContent = ""; rxFiles.dataset.filled = "1"; }
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.textContent = `⬇ ${name} (${fmtBytes(size)})`;
    rxFiles.appendChild(a);
  }

  // ================= SPECTRUM SCOPE (cosmetic) =================
  const sctx = scope ? scope.getContext("2d") : null;
  function resizeCanvas() {
    if (!scope) return;
    scope.width = scope.clientWidth * devicePixelRatio;
    scope.height = 70 * devicePixelRatio;
  }
  if (scope) window.addEventListener("resize", resizeCanvas);

  let SCOPE_MIN = MC.FREQS[0] - 800, SCOPE_MAX = MC.FREQS[15] + 800;
  function drawLoop() {
    if (!listening) return;
    if (analyser) {
      const bins = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      const sr = getCtx().sampleRate;
      const binHz = sr / analyser.fftSize;
      const minBin = Math.floor(SCOPE_MIN / binHz);
      const maxBin = Math.min(bins.length - 1, Math.ceil(SCOPE_MAX / binHz));
      const w = scope.width, h = scope.height;
      sctx.fillStyle = "#061109"; sctx.fillRect(0, 0, w, h);
      const n = maxBin - minBin;
      sctx.strokeStyle = "#5dff9a"; sctx.lineWidth = 1.5 * devicePixelRatio;
      sctx.beginPath();
      for (let i = 0; i < n; i++) {
        const db_i = bins[minBin + i];
        const norm = Math.max(0, Math.min(1, (db_i + 100) / 70));
        const x = (i / n) * w, y = h - norm * h;
        if (i === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y);
      }
      sctx.stroke();
      [MC.FREQS[0], MC.FREQS[15]].forEach(f => {
        const idx = ((f - SCOPE_MIN) / (SCOPE_MAX - SCOPE_MIN)) * w;
        sctx.strokeStyle = "rgba(255,180,84,0.5)"; sctx.lineWidth = 1;
        sctx.beginPath(); sctx.moveTo(idx, 0); sctx.lineTo(idx, h); sctx.stroke();
      });
    }
    scopeRAF = requestAnimationFrame(drawLoop);
  }

  // ================= TRANSMITTER =================
  function updateTxPreview() {
    if (!txText) return;
    const text = txText.value;
    if (!text) {
      if (txLen) txLen.textContent = "0 bytes";
      if (txChecksum) txChecksum.textContent = "—";
      if (txBits) txBits.textContent = "—";
      return;
    }
    const pkt = MC.buildTextPacket(text, 1);
    const body = pkt.bytes;
    if (txLen) txLen.textContent = body.length + " bytes (" + pkt.symbols.length + " symbols)";
    if (txChecksum) txChecksum.textContent =
      "0x" + pkt.crc.toString(16).toUpperCase().padStart(4, "0");
    if (txBits) txBits.textContent = pkt.symbols.map(s => s.toString(16).toUpperCase()).join(" ");
  }
  if (txText) { txText.addEventListener("input", updateTxPreview); updateTxPreview(); }

  // Play one packet's symbols as FSK tones. Resolves when the audio ends.
  function transmitPacket(packet) {
    const ctx = getCtx();
    const syms = packet.symbols;
    return new Promise(resolve => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.4;
      osc.connect(gain).connect(ctx.destination);
      const t0 = ctx.currentTime + 0.08;
      for (let i = 0; i < syms.length; i++)
        osc.frequency.setValueAtTime(MC.FREQS[syms[i]], t0 + i * (MC.SYMBOL_MS / 1000));
      const dur = syms.length * (MC.SYMBOL_MS / 1000);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
      osc.onended = () => { osc.disconnect(); resolve(); };
    });
  }

  function setTransmitting(on) {
    transmitting = on;
    if (sendBtn) sendBtn.disabled = on;
    if (sendFileBtn) sendFileBtn.disabled = on || !selectedFile;
    if (txText) txText.disabled = on;
    if (fileInput) fileInput.disabled = on;
  }

  const INTER_PACKET_GAP_MS = 350; // silence so the receiver re-syncs cleanly

  async function sendText() {
    if (transmitting) return;
    const text = txText.value;
    if (!text) { log("Nothing to send.", "bad"); return; }
    const ctx = getCtx();
    if (ctx.state === "suspended") await ctx.resume();
    const pkt = MC.buildTextPacket(text, 1);
    const secs = MC.symbolsToSeconds(pkt.symbols.length);
    setTransmitting(true);
    log(`Transmitting "${text}" — ${pkt.bytes.length} bytes / ${pkt.symbols.length} symbols (~${fmtSec(secs)})`, "info");
    await transmitPacket(pkt);
    setTransmitting(false);
    log("Transmission complete.", "ok");
  }
  if (sendBtn) sendBtn.addEventListener("click", sendText);

  // ---- file send ----
  if (fileInput) fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files[0];
    selectedFile = f || null;
    selectedBytes = null;
    if (sendFileBtn) sendFileBtn.disabled = transmitting || !selectedFile;
    if (!fileInfo) return;
    if (!f) { fileInfo.textContent = "no file selected"; return; }
    if (f.size > MC.MAX_FILE_BYTES) {
      fileInfo.textContent = `${f.name} — too large (max ${fmtBytes(MC.MAX_FILE_BYTES)})`;
      selectedFile = null;
      if (sendFileBtn) sendFileBtn.disabled = true;
      return;
    }
    selectedBytes = new Uint8Array(await f.arrayBuffer());
    const packets = Math.max(1, Math.ceil(f.size / MC.CHUNK_DATA)) + 2;
    const secs = MC.symbolsToSeconds(packets * (20 /*preamble*/ + 8 + MC.MAX_PAYLOAD + 8));
    fileInfo.textContent = `${f.name} · ${fmtBytes(f.size)} · ~${packets} packets · ETA ~${fmtSec(secs)}`;
    log(`File ready: "${f.name}" (${fmtBytes(f.size)}). Press SEND FILE.`, "info");
  });

  async function sendFile() {
    if (transmitting || !selectedFile || !selectedBytes) return;
    const ctx = getCtx();
    if (ctx.state === "suspended") await ctx.resume();
    const { packets, meta } = MC.buildFilePackets(
      selectedFile.name, selectedFile.type, selectedBytes, transferId++ % 256);
    const totalSecs = MC.symbolsToSeconds(MC.estimateSymbols(packets))
      + (packets.length - 1) * INTER_PACKET_GAP_MS / 1000;
    setTransmitting(true);
    log(`Transmitting "${meta.n}" — ${fmtBytes(meta.s)} in ${packets.length} packets, ~${fmtSec(totalSecs)}. DO NOT STOP THE RECEIVER.`, "info");
    const t0 = performance.now();
    let lastPct = -1;
    for (let i = 0; i < packets.length; i++) {
      await transmitPacket(packets[i]);
      // data packets are i = 1..c; report progress as chunks on air
      if (i >= 1 && i <= meta.c) {
        const pct = Math.round(100 * i / meta.c);
        if (pct >= lastPct + 10 || i === meta.c) {
          lastPct = pct;
          log(`  … packet ${i}/${packets.length} sent (${pct}% of file on air)`);
        }
      }
      if (i < packets.length - 1) await sleep(INTER_PACKET_GAP_MS);
    }
    setTransmitting(false);
    log(`File transmission complete in ${fmtSec((performance.now() - t0) / 1000)}.`, "ok");
  }
  if (sendFileBtn) sendFileBtn.addEventListener("click", sendFile);

  // ================= CARRIER BAND =================
  // Both ends of the link must agree on the band. The default is the audible
  // band (2.0–5.0 kHz) because ordinary laptop/phone speakers and mics carry
  // it; the 17.0–19.7 kHz ultrasonic band is kept as an opt-in for hardware
  // that can actually reproduce it.
  const BAND_ULTRASONIC = "17000,180";
  function applyBand() {
    if (!bandSel) return;
    const parts = String(bandSel.value).split(",");
    const f = MC.setBand(parseFloat(parts[0]), parseFloat(parts[1]));
    SCOPE_MIN = f[0] - 800; SCOPE_MAX = f[MC.NUM_TONES - 1] + 800;
  }
  if (bandSel) {
    try {
      const saved = localStorage.getItem("ultramodem.band");
      if (saved && Array.prototype.some.call(bandSel.options, o => o.value === saved))
        bandSel.value = saved;
    } catch (e) { /* storage unavailable — keep the default band */ }
    applyBand();
    bandSel.addEventListener("change", () => {
      applyBand();
      try { localStorage.setItem("ultramodem.band", bandSel.value); } catch (e) {}
      const ultra = bandSel.value === BAND_ULTRASONIC;
      log(`Carrier band → ${MC.FREQS[0]}–${MC.FREQS[MC.NUM_TONES - 1]} Hz` +
        (ultra ? " (ULTRASONIC — most laptop/phone speakers cannot reproduce this, the other end may hear nothing)" : "") +
        ". Both devices must use the same band.", ultra ? "bad" : "info");
      updateTxPreview();
    });
  }

  // ================= INIT =================
  if (listenBtn || sendBtn || playToneBtn) {
    resetReceiverUi();
    if (sendFileBtn) sendFileBtn.disabled = true;
    if (fileInfo) fileInfo.textContent = "no file selected";
    log(`System ready v3. ${MC.SYMBOL_MS}ms/symbol, ${MC.NUM_TONES} tones ${MC.FREQS[0]}–${MC.FREQS[15]} Hz (~80 bit/s).`);
  }
})();
