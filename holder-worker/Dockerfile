FROM node:22-bookworm-slim

# Real Google Chrome (not Chromium, not Playwright's build): Turnstile flags automation builds, which is why
# src/browser.js spawns a plain Chrome and only attaches to it over CDP. Xvfb gives it a display.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget gnupg ca-certificates xvfb xauth procps fonts-liberation fonts-noto-core \
 && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY start.sh ./

CMD ["sh", "start.sh"]
