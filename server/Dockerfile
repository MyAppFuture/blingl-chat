FROM node:22-alpine

WORKDIR /app

# Copy dependency manifests first (for Docker layer caching)
COPY package.json ./
RUN npm install

# Copy the rest of the source
COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]