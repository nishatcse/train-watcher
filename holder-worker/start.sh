#!/bin/sh
# Start the virtual display ourselves (xvfb-run hangs in some containers), then the worker.
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99
for i in 1 2 3 4 5 6 7 8 9 10; do
  [ -e /tmp/.X11-unix/X99 ] && break
  sleep 0.5
done
exec node src/index.js
