FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS backend
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install --no-audit --no-fund
COPY backend/ ./
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    RTL_TCP_HOST=host.docker.internal \
    RTL_TCP_PORT=1234 \
    FRONTEND_DIST=/app/frontend/dist
COPY --from=backend /app/backend/package.json /app/backend/package.json
COPY --from=backend /app/backend/node_modules /app/backend/node_modules
COPY --from=backend /app/backend/dist /app/backend/dist
COPY --from=frontend /app/frontend/dist /app/frontend/dist
EXPOSE 8080
CMD ["node", "/app/backend/dist/index.js"]
