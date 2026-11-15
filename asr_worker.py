#!/usr/bin/env python3
"""
Воркер распознавания речи (Vosk / Kaldi).

Читает raw PCM s16le mono из stdin, пишет JSON-строки в stdout:
  {"type":"ready","model":"vosk-model-small-ru-0.22"}
  {"type":"partial","text":"ант"}
  {"type":"final","text":"антон включи свет","words":[...]}

Завершается по EOF stdin.
"""
import argparse
import json
import os
import sys


def emit(obj):
    try:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, ValueError):
        os._exit(0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--rate", type=int, default=16000)
    ap.add_argument("--no-words", action="store_true")
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

    name = os.path.basename(os.path.normpath(args.model))
    emit({"type": "ready", "model": name})

    rec = KaldiRecognizer(model, args.rate)
    rec.SetWords(not args.no_words)

    stdin = sys.stdin.buffer
    last_partial = ""
    pending = b""

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

        if rec.AcceptWaveform(data):
            res = json.loads(rec.Result())
            emit({"type": "final", "text": res.get("text", "").strip(), "words": res.get("words", [])})
            last_partial = ""
        else:
            partial = json.loads(rec.PartialResult()).get("partial", "").strip()
            if partial != last_partial:
                last_partial = partial
                emit({"type": "partial", "text": partial})

    res = json.loads(rec.FinalResult())
    text = res.get("text", "").strip()
    if text:
        emit({"type": "final", "text": text, "words": res.get("words", []), "eof": True})
    return 0


if __name__ == "__main__":
    sys.exit(main())
