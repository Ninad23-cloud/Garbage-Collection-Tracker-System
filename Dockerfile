FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY main.cpp engine.hpp httplib.h json.hpp ./
COPY public ./public

RUN g++ -std=c++17 -O2 main.cpp -o server -pthread

ENV HOST=0.0.0.0
EXPOSE 8080

CMD ["./server", "8080", "public"]
