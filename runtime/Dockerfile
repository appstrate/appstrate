FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY entrypoint.mjs ./

# Flow prompt will be passed as FLOW_PROMPT env var
# OAuth tokens as TOKEN_GMAIL, TOKEN_CLICKUP, etc.
# Config as CONFIG_* env vars

ENTRYPOINT ["node", "entrypoint.mjs"]
