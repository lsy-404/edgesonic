FROM node:24-alpine

RUN apk add --no-cache ffmpeg python3 py3-pip && python3 -m venv /opt/yt-dlp && /opt/yt-dlp/bin/pip install --no-cache-dir 'yt-dlp[default]' && corepack enable pnpm
ENV PATH="/opt/yt-dlp/bin:${PATH}"
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY app.js media.js ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "app.js"]
