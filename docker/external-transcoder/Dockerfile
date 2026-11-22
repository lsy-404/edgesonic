FROM node:24-alpine

ARG XRAY_VERSION=v26.10.31
ARG XRAY_SHA256=e4bd9119f50ae7c41658b1abd0679ae06f98bd864a2907ff33f2f2cf7081b214
RUN apk add --no-cache ffmpeg python3 py3-pip && python3 -m venv /opt/yt-dlp && /opt/yt-dlp/bin/pip install --no-cache-dir 'yt-dlp[default]' && corepack enable pnpm \
  && wget -qO /tmp/xray.zip "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip" \
  && echo "${XRAY_SHA256}  /tmp/xray.zip" | sha256sum -c - \
  && unzip -q /tmp/xray.zip xray -d /usr/local/bin && chmod 755 /usr/local/bin/xray && rm /tmp/xray.zip
ENV PATH="/opt/yt-dlp/bin:${PATH}"
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY app.js media.js proxy.js ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "app.js"]
