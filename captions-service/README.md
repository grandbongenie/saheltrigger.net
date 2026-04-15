# Sahel Trigger Live Captions Service

Streams live RTMP audio into OpenAI Realtime transcription and broadcasts caption JSON to browser clients over WebSocket.

## 1) Install

```bash
cd /var/www/sites/saheltrigger.net/captions-service
npm install --omit=dev
```

## 2) Configure env

Create `/etc/saheltrigger/captions.env` (recommended, root-owned):

```bash
sudo install -d -m 750 /etc/saheltrigger
sudo install -m 640 /dev/null /etc/saheltrigger/captions.env
sudoedit /etc/saheltrigger/captions.env
```

Minimum content:

```bash
OPENAI_API_KEY=<your key>
OPENAI_REALTIME_URL=wss://api.openai.com/v1/realtime?intent=transcription
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
OPENAI_TRANSCRIPTION_LANGUAGE=auto
OPENAI_TRANSLATION_MODEL=gpt-4o-mini
AUDIO_SAMPLE_RATE=24000
```

## 3) Run with systemd

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now saheltrigger-captions.service
sudo systemctl status saheltrigger-captions.service
```

## 4) Logs

```bash
sudo journalctl -u saheltrigger-captions.service -f
```

## 5) Manual start/stop/restart

```bash
sudo systemctl start saheltrigger-captions.service
sudo systemctl stop saheltrigger-captions.service
sudo systemctl restart saheltrigger-captions.service
```

## Output format

Each message sent to browser clients:

```json
{
  "type": "caption",
  "id": "cap_1741099999999_10",
  "t0": 1741099999099,
  "t1": 1741100002499,
  "text": "Bonjour a tous",
  "translations": {
    "fr": "Bonjour a tous",
    "en": "Hello everyone",
    "es": "Hola a todos"
  },
  "final": true
}
```

## Quick validation

1. Verify ffmpeg audio extraction:
```bash
ffmpeg -hide_banner -loglevel warning -i rtmp://127.0.0.1:8443/live/saheltrigger -vn -ac 1 -ar 24000 -f s16le -t 3 /tmp/captions-test.pcm && ls -lh /tmp/captions-test.pcm
```
2. Verify local WS listener:
```bash
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" http://127.0.0.1:3010/
```
3. Verify public WS upgrade via nginx:
```bash
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" https://www.saheltrigger.net/captions/ws
```
4. Browser: open `https://www.saheltrigger.net/live` and confirm CC overlay updates while stream plays.
