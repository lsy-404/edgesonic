FROM node:24-alpine

RUN apk add --no-cache ffmpeg && corepack enable pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY app.js ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "app.js"]
