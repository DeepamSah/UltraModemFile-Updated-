# ▚ UltraModem

**Acoustic FSK data link — browser to browser, over the air, no cables.**

![UltraModem Receiver UI in action](./docs/demo.png)

UltraModem is a pure JavaScript and Web Audio API implementation of a data-over-audio communication system. It allows two devices running a web browser to transmit and receive text messages — and whole documents such as PDFs, images or zips — through the air using high-frequency sound, effectively turning their speakers and microphones into a modem.

This project runs entirely in the browser, with no server-side components, frameworks, or build steps required.

## How to Use

1.  **Open the application** on two separate devices (e.g., a laptop and a phone). You can start at the main `index.html` page.
2.  **Navigate to Sender Mode:** On one device, choose **▲ SENDER**.
3.  **Navigate to Receiver Mode:** On the other device, choose **◉ RECEIVER** and click the **◉ LISTEN** button to activate the microphone.
4.  **Position the devices:** Place the devices a few feet apart in a quiet room, with the speaker of the sender facing the microphone of the receiver.
5.  **Transmit Data:** On the sender device, either type a message (up to 90 characters) and click **▲ SEND TEXT**, or pick any file and click **📦 SEND FILE**.
6.  **Receive Data:** Watch the receiver's UI as it locks onto the signal, decodes the symbols, verifies the CRC, and displays the message — completed files appear as download links in the **INCOMING FILE TRANSFER** panel.

> **Note on bandwidth:** this is a real acoustic link, so throughput is a few bytes per second. Small documents (a page of PDF, an icon, a short note) work well; large files would take hours over sound.

## How It Works

UltraModem uses **16-tone Frequency-Shift Keying (FSK)** to encode data. Each 50ms symbol carries 4 bits and is transmitted as one of 16 tones in the selected carrier band — by default **2000 Hz to 5000 Hz** (200 Hz apart), which ordinary laptop and phone speakers and microphones reproduce faithfully, for roughly 80 bits per second. A near-ultrasonic **17000–19700 Hz** band is also selectable; it is much less obtrusive, but most consumer speakers cannot reproduce anything above ~16 kHz, so the far end will simply hear nothing — pick the band that works for your hardware and make sure **both devices use the same one**.

### Key Technical Features

*   **Sample-Accurate Timing:** Instead of relying on JavaScript's `setInterval()`, which is prone to event loop jitter, the receiver uses a `ScriptProcessorNode` (or `AudioWorklet`). This allows it to process audio in exact, sample-accurate chunks, ensuring the demodulator never loses sync with the incoming bitstream.

*   **Efficient Goertzel Algorithm:** To detect which frequency is present in an audio chunk, the demodulator uses the **Goertzel algorithm**. Unlike a full Fast Fourier Transform (FFT) which calculates the magnitude of a wide spectrum of frequencies, Goertzel is highly optimized for detecting the strength of a few specific, pre-determined frequencies. This makes it significantly more efficient and provides better signal-to-noise performance for this use case.

*   **Robust Preamble Synchronization:** A transmission begins with a `101010...` preamble. The receiver continuously scans the incoming audio for this pattern. To achieve a lock, it correlates the recent history of detected bits against the expected preamble pattern at multiple sub-bit phases. Once a strong correlation is found, the receiver is "locked" and knows the exact sample index where each subsequent data bit begins.

### Packet Structure

Every packet is self-contained and CRC-protected:

| Preamble (20 symbols) | Start (2 sym) | Type (1 B) | ID (1 B) | Length (2 B) | Payload (0–96 B) | CRC-16 (2 B) | End (2 sym) |
| --------------------- | ------------- | ---------- | -------- | ------------ | ---------------- | ------------ | ----------- |
| `0F0F0F0F…`           | `A5`          | `...`      | `...`    | `...`        | `...`            | `...`        | `5A`        |

*   **Preamble:** An alternating 0/F symbol sequence; the receiver correlates against it at every sub-symbol phase to lock on, then rides through an entire multi-packet transfer.
*   **Type:** `0x01` text, `0x02` file meta (JSON: name, MIME type, size, chunk count, file CRC), `0x03` file chunk (2-byte index + up to 94 bytes), `0x04` file end.
*   **CRC-16/CCITT:** Covers the whole packet body. A file only becomes downloadable after every chunk passes its CRC *and* the reassembled file matches the advertised CRC — corrupt transfers are reported, never silently accepted.

### Sending Files

Files are split into 94-byte chunks, each sent as its own packet preceded by a meta packet. The receiver reassembles the chunks in order and offers the finished file as a download link. The whole modem (modulation, framing, demodulator, parser and file assembler) lives in `modem-core.js`, which runs both in the browser and in Node so it can be tested without speakers or microphones.

## Tunable Parameters

The core transmission parameters can be adjusted in `modem-core.js`:

*   `SYMBOL_MS`: The duration of each 4-bit symbol in milliseconds (default 50ms ≈ 80 bits/sec).
*   `FREQ_BASE` / `FREQ_SPACING`: The 16 carrier tones (default 2000 Hz + k·200 Hz, i.e. 2000–5000 Hz).
*   `setBand(base, spacing)`: Switches the carrier band at runtime — the UI exposes this as the **CARRIER BAND** selector. Both ends of the link must agree on the band.
*   `PREAMBLE`: The symbol pattern used for synchronization.
*   `MAX_PAYLOAD` / `CHUNK_DATA`: Packet payload size and file chunk size.

## Testing

A loopback test renders real packets to a noisy 48kHz/44.1kHz waveform and pushes them through the exact demodulator and parser the browser uses:

```bash
node test/loopback.test.js
```

## Running Locally

No build process is required — just serve the project directory with any static file server.

**Recommended (this repo ships one):**

```bash
npm install
npm start        # http://localhost:3000
```

**Alternatives:**

```bash
npx http-server         # or
python -m http.server
```

Then open `http://localhost:3000` (or the appropriate port) in your browser.

## License

This project is open source and available under the MIT License.

---

Copyright © 2026 Ronen Singha. All rights reserved.
