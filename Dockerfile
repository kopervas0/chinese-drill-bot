# Два образа из одного файла:
#   --target bot     — Telegram-бот (Node, без открытых портов в режиме polling)
#   --target webapp  — тренажёр как статика (nginx на порту 8080)

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY data ./data
COPY webapp ./webapp
RUN npm run build && node scripts/build-webapp.mjs

FROM node:22-alpine AS bot
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY data ./data
# Не root: тот же uid, что у остальных контейнеров на сервере.
USER 10001
CMD ["node", "dist/bot.js"]

FROM nginxinc/nginx-unprivileged:1.29-alpine AS webapp
COPY deploy/nginx-webapp.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/webapp /usr/share/nginx/html
USER 10001
EXPOSE 8080
