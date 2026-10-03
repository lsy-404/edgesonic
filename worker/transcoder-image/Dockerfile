FROM node:24-alpine

RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json app.js ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "app.js"]
