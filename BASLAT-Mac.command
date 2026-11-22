#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "Node.js kurulu değil. https://nodejs.org adresinden LTS sürümünü kur."; read; exit 1; fi
[ -d node_modules ] || npm install
(sleep 2 && open http://localhost:3000/panel) &
node server.js
