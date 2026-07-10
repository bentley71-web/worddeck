#!/bin/bash
# WordDeck 一鍵啟動:本機 + 同 WiFi 都能連
cd "$(dirname "$0")"
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
echo "──────────────────────────────"
echo " WordDeck 啟動中…"
echo "  本機:    http://localhost:8000"
[ -n "$IP" ] && echo "  同WiFi:  http://$IP:8000"
echo "  (停止:在這個視窗按 Ctrl+C)"
echo "──────────────────────────────"
exec python3 -m uvicorn server:app --host 0.0.0.0 --port 8000
