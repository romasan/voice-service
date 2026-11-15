#!/bin/bash
# Настройка USB-микрофона (PCM2902, card 1) под voice-service.
# Запускать после загрузки, если уровень слишком тихий.
set -u
CARD=${1:-1}
SRC="alsa_input.usb-C-Media_Electronics_Inc._USB_PnP_Sound_Device-00.analog-mono"

amixer -c "$CARD" sset 'Mic' 16 >/dev/null 2>&1 && echo "ALSA mic gain: 16/16 (+23.8 dB)"
amixer -c "$CARD" sset 'Auto Gain Control' on >/dev/null 2>&1 && echo "ALSA AGC: on"
pactl set-source-volume "$SRC" 150% 2>/dev/null && echo "PulseAudio source volume: 150%"
pactl set-source-mute "$SRC" 0 >/dev/null 2>&1 && echo "PulseAudio source: unmuted"
