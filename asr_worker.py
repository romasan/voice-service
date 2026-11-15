#!/usr/bin/env python3
"""
Воркер распознавания речи (Vosk / Kaldi) с опциональным Silero VAD.

Читает raw PCM s16le mono 16 кГц из stdin, пишет JSON-строки в stdout:
  {"type":"ready","model":"...","vad":true}
  {"type":"vad","speech":true,"prob":0.98}
  {"type":"partial","text":"ант"}
  {"type":"final","text":"антон включи свет","words":[...]}

VAD (--vad path/to/silero_vad.onnx) режет тишину: в распознаватель уходят только
участки речи, плюс pre-roll перед началом и хвост после конца, чтобы Kaldi успел
закрыть фразу. Завершается по EOF stdin.
"""
import argparse
import json
import os
import sys
from collections import deque

VAD_FRAME = 512          # 32 мс при 16 кГц
VAD_CONTEXT = 64         # контекст, который silero ждёт вместе с кадром
VAD_HANGOVER_MS = 600    # сколько тишины ещё кормим в Vosk после конца речи
PRE_ROLL_FRAMES = 12     # ~384 мс до начала речи


def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, ValueError):
        os._exit(0)


class SileroVad:
    def __init__(self, path, threshold):
        import numpy as np
        import onnxruntime as ort

        self.np = np
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self.session = ort.InferenceSession(path, providers=["CPUExecutionProvider"], sess_options=opts)
        self.threshold = float(threshold)
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros((1, VAD_CONTEXT), dtype=np.float32)
        self.sr = np.array(16000, dtype=np.int64)

    def __call__(self, chunk):
        np = self.np
        x = np.concatenate([self.context, chunk.reshape(1, -1)], axis=1).astype(np.float32)
        out, self.state = self.session.run(None, {"input": x, "state": self.state, "sr": self.sr})
        self.context = x[:, -VAD_CONTEXT:]
        return float(np.asarray(out).ravel()[0])

    def reset(self):
        np = self.np
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros((1, VAD_CONTEXT), dtype=np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--rate", type=int, default=16000)
    ap.add_argument("--no-words", action="store_true")
    ap.add_argument("--vad", default="")
    ap.add_argument("--vad-threshold", type=float, default=0.5)
    args = ap.parse_args()

    if not os.path.isdir(args.model):
        emit({"type": "error", "error": "model dir not found: " + args.model})
        return 2

    try:
        from vosk import Model, KaldiRecognizer, SetLogLevel
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "error": "vosk import failed: %s" % e})
        return 3

    SetLogLevel(-1)
    try:
        model = Model(args.model)
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "error": "model load failed: %s" % e})
        return 4

    vad = None
    if args.vad:
        if not os.path.isfile(args.vad):
            emit({"type": "error", "error": "vad model not found: " + args.vad})
        else:
            try:
                vad = SileroVad(args.vad, args.vad_threshold)
            except Exception as e:  # noqa: BLE001
                emit({"type": "error", "error": "vad init failed: %s" % e})
                return 5

    name = os.path.basename(os.path.normpath(args.model))
    emit({"type": "ready", "model": name, "vad": vad is not None})

    rec = KaldiRecognizer(model, args.rate)
    rec.SetWords(not args.no_words)

    stdin = sys.stdin.buffer
    last_partial = ""
    pending = b""
    feed_buf = b""

    # состояние VAD
    pre_roll = deque(maxlen=PRE_ROLL_FRAMES)
    speech = False
    hangover = 0
    hangover_frames = max(1, int(VAD_HANGOVER_MS / (VAD_FRAME * 1000.0 / args.rate)))
    need_reset = False

    def feed(pcm):
        nonlocal last_partial
        if rec.AcceptWaveform(pcm):
            res = json.loads(rec.Result())
            emit({"type": "final", "text": res.get("text", "").strip(), "words": res.get("words", [])})
            last_partial = ""
        else:
            partial = json.loads(rec.PartialResult()).get("partial", "").strip()
            if partial != last_partial:
                last_partial = partial
                emit({"type": "partial", "text": partial})

    def flush_final():
        nonlocal last_partial
        res = json.loads(rec.FinalResult())
        text = res.get("text", "").strip()
        if text:
            emit({"type": "final", "text": text, "words": res.get("words", [])})
        last_partial = ""

    while True:
        try:
            data = stdin.read1(8192)
        except (KeyboardInterrupt, OSError):
            break
        if not data:
            break
        if pending:
            data = pending + data
            pending = b""
        if len(data) % 2:
            pending = data[-1:]
            data = data[:-1]
        if not data:
            continue

        if vad is None:
            feed(data)
            continue

        feed_buf += data
        frame_bytes = VAD_FRAME * 2
        np = vad.np
        while len(feed_buf) >= frame_bytes:
            raw = feed_buf[:frame_bytes]
            feed_buf = feed_buf[frame_bytes:]
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            prob = vad(samples)
            speaking = prob >= vad.threshold

            if speaking:
                if not speech:
                    # речь началась: сначала отдаём pre-roll, чтобы не срезать первый слог
                    for pr in pre_roll:
                        feed(pr)
                    pre_roll.clear()
                    speech = True
                    emit({"type": "vad", "speech": True, "prob": round(prob, 3)})
                hangover = 0
                feed(raw)
            else:
                if speech:
                    hangover += 1
                    if hangover <= hangover_frames:
                        feed(raw)
                    else:
                        speech = False
                        hangover = 0
                        emit({"type": "vad", "speech": False, "prob": round(prob, 3)})
                        flush_final()
                        need_reset = True
                else:
                    pre_roll.append(raw)
                    if need_reset:
                        need_reset = False

    if vad is not None and speech:
        flush_final()
    flush_final()
    return 0


if __name__ == "__main__":
    sys.exit(main())
