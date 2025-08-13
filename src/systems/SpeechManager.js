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


