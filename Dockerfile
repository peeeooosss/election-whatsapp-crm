FROM node:20-slim

# Create a non-root user to run the app
RUN useradd --create-home appuser
WORKDIR /app

# Install deps before copying source (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install

# Copy the app
COPY . .

# The WhatsApp session lives on a mounted volume (/data/sessions)
RUN mkdir -p /data/sessions && chown -R appuser:appuser /data /app
USER appuser

EXPOSE 3000
ENV NODE_ENV=production
ENV HOST=0.0.0.0

CMD ["node", "server.js"]
