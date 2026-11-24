FROM node:lts-alpine

WORKDIR /usr/src/app

ENV NODE_ENV=production \
    PORT=3012 \
    HOST=0.0.0.0 \
    DATA_DIR=/usr/src/app/data

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /usr/src/app/data

EXPOSE 3012

CMD ["node", "server.js"]
