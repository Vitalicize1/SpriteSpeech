export function normalizeSpanish(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export class SpeechManager {
  constructor(lang = 'es-ES') {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.available = Boolean(SR);
    this.lang = lang;
    this.recognition = this.available ? new SR() : null;
    this._continuousActive = false;
    if (this.recognition) {
      this.recognition.lang = this.lang;
      this.recognition.interimResults = true; // enable partial hypotheses for lower latency
      this.recognition.maxAlternatives = 3;
    }
  }

  startOnce() {
    if (!this.recognition) return Promise.reject(new Error('Speech unavailable'));
    return new Promise((resolve, reject) => {
      this.recognition.onresult = (e) => {
        const res = e.results?.[0]?.[0];
        if (!res) return reject(new Error('No result'));
        resolve({ transcript: String(res.transcript || ''), confidence: Number(res.confidence || 0) });
      };
      this.recognition.onerror = (e) => reject(e.error || e);
      this.recognition.onend = () => {};
      try { this.recognition.start(); } catch (e) { reject(e); }
    });
  }

  startContinuous(onResult) {
    if (!this.recognition) throw new Error('Speech unavailable');
    this._continuousActive = true;
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.onresult = (e) => {
      // Emit both interim and final hypotheses
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const isFinal = Boolean(e.results[i].isFinal);
        const alt = e.results[i][0];
        if (typeof onResult === 'function' && alt) {
          onResult({
            transcript: String(alt.transcript || ''),
            confidence: Number(alt.confidence || 0),
            isFinal
          });
        }
      }
    };
    this.recognition.onerror = (_) => {
      // Swallow transient errors; the onend handler will attempt a restart if still active
    };
    this.recognition.onend = () => {
      if (this._continuousActive) {
        // Auto-restart after brief delay to keep listening
        setTimeout(() => {
          try { this.recognition.start(); } catch (_) { /* ignore */ }
        }, 20);
      }
    };
    try { this.recognition.start(); } catch (_) { /* ignore start race */ }
  }

  stopContinuous() {
    if (!this.recognition) return;
    this._continuousActive = false;
    try { this.recognition.stop(); } catch (_) { /* ignore */ }
  }
}


// Utility: classic Levenshtein distance
function levenshteinDistance(a, b) {
  const s = String(a);
  const t = String(b);
  const n = s.length;
  const m = t.length;
  if (n === 0) return m;
  if (m === 0) return n;
  const dp = new Array(m + 1);
  for (let j = 0; j <= m; j += 1) dp[j] = j;
  for (let i = 1; i <= n; i += 1) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= m; j += 1) {
      const temp = dp[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,         // deletion
        dp[j - 1] + 1,     // insertion
        prev + cost        // substitution
      );
      prev = temp;
    }
  }
  return dp[m];
}

// Exported scorer: returns { similarity [0..1], weighted [0..1], score100, label }
export function scorePronunciation(saidRaw, targetRaw, confidence = 0) {
  const said = normalizeSpanish(String(saidRaw || '').trim());
  const target = normalizeSpanish(String(targetRaw || '').trim());
  if (!said || !target) return { similarity: 0, weighted: 0, score100: 0, label: 'no-input' };
  const maxLen = Math.max(said.length, target.length) || 1;
  const lev = levenshteinDistance(said, target);
  const similarity = Math.max(0, 1 - (lev / maxLen)); // 1 is perfect
  // Blend ASR confidence modestly so good phonetic matches with low conf still count somewhat
  const weighted = (similarity * 0.7) + (Math.max(0, Math.min(1, confidence)) * 0.3);
  const score100 = Math.round(weighted * 100);
  const label = weighted >= 0.85 ? 'perfect'
              : weighted >= 0.7  ? 'good'
              : weighted >= 0.55 ? 'okay'
              : 'miss';
  return { similarity, weighted, score100, label };
}

// Simple microphone audio meter with rough pitch estimation via autocorrelation
export class AudioMeter {
  constructor({ fftSize = 2048 } = {}) {
    this.fftSize = fftSize;
    this.context = null;
    this.source = null;
    this.analyser = null;
    this.buffer = null;
    this.raf = 0;
    this.active = false;
  }

  async start(onMetrics) {
    if (this.active) return;
    this.active = true;
    this.context = new (window.AudioContext || window.webkitAudioContext)();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.source = this.context.createMediaStreamSource(stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = 0.6;
    this.source.connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);

    const tick = () => {
      if (!this.active) return;
      this.analyser.getFloatTimeDomainData(this.buffer);
      const rms = Math.sqrt(this.buffer.reduce((acc, v) => acc + (v * v), 0) / this.buffer.length);
      const pitchHz = this._estimatePitch(this.buffer, this.context.sampleRate);
      if (typeof onMetrics === 'function') {
        onMetrics({ rms, pitchHz });
      }
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  stop() {
    this.active = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    try { this.source?.disconnect(); } catch (_) {}
    try { this.analyser?.disconnect(); } catch (_) {}
    try { this.context?.close(); } catch (_) {}
    this.source = null;
    this.analyser = null;
    this.context = null;
  }

  // Very rough autocorrelation pitch estimate
  _estimatePitch(buffer, sampleRate) {
    const SIZE = buffer.length;
    let bestOffset = -1;
    let bestCorrelation = 0;
    let rms = 0;
    for (let i = 0; i < SIZE; i += 1) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return 0; // too quiet

    let lastCorrelation = 1;
    const maxLag = Math.min(1000, Math.floor(sampleRate / 50)); // up to 50 Hz
    const minLag = Math.max(8, Math.floor(sampleRate / 1000));  // down to 1 kHz upper bound guard
    for (let offset = minLag; offset < maxLag; offset += 1) {
      let correlation = 0;
      for (let i = 0; i < SIZE - offset; i += 1) {
        correlation += buffer[i] * buffer[i + offset];
      }
      correlation /= (SIZE - offset);
      if (correlation > 0.9 && correlation > lastCorrelation) {
        if (correlation > bestCorrelation) {
          bestCorrelation = correlation;
          bestOffset = offset;
        }
      } else if (bestCorrelation > 0.01 && correlation < lastCorrelation) {
        // Peak passed
      }
      lastCorrelation = correlation;
    }
    if (bestOffset > 0) return sampleRate / bestOffset;
    return 0;
  }
}

